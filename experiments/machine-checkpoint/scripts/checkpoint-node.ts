import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { Machine, type MachineOptions } from '../../boot/src/machine.ts';

const vendor = new URL('../../boot/vendor/', import.meta.url);
const read = (name: string) => new Uint8Array(readFileSync(new URL(name, vendor)));
const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const plain = process.env.PLAIN === '1';

let output = '';
const options: MachineOptions = {
	vmlinux: new WebAssembly.Module(
		read(plain ? 'vmlinux.shared.wasm' : (process.env.KERNEL_MODULE ?? 'vmlinux.async.wasm'))
	),
	initrd: read(process.env.INITRD ?? 'initramfs.cpio.gz'),
	cmdline:
		'maxcpus=3 root=/dev/ram0 rootfstype=ramfs init=/init console=hvc console=ttyS0',
	registry: new Map([
		[
			sha256(read(process.env.BUSYBOX ?? 'busybox.wasm')),
			new WebAssembly.Module(
				read(
					plain ? 'busybox.fuel.wasm' : (process.env.USER_MODULE ?? 'busybox.async.wasm')
				)
			)
		]
	]),
	maximumPages: Number(process.env.PAGES ?? 2048),
	sha256,
	sharedKernel: process.env.SHARED !== '0',
	now: process.env.FROZEN === '1' ? () => frozen.ns : undefined,
	fuelBudget: process.env.FUEL ? Number(process.env.FUEL) : undefined,
	asyncify: !plain,
	log: (line) => console.error(`[host] ${line}`),
	trace: process.env.TRACE === '1',
	write: (text) => {
		output += text;
		process.stdout.write(text);
	}
};
// FROZEN=1 mimics a deployed Worker: the clock moves only when the pump sleeps
const frozen = { ns: 0n };
const sleep = (ms: number) => {
	frozen.ns += BigInt(Math.max(ms, 1)) * 1_000_000n;
	if (process.env.FROZEN === '1') return new Promise<void>((r) => setImmediate(r));
	return new Promise<void>((r) => setTimeout(r, Math.min(ms, 50)));
};
const wait = async (m: Machine, done: () => boolean, ms: number) => {
	const t = Date.now();
	return m.run(() => done() || Date.now() - t > ms, sleep);
};
const prompts = () => (output.match(/~ # /g) ?? []).length;

const t0 = performance.now();
let machine = new Machine(options);
await wait(machine, () => (process.env.EARLY === '1' ? output.includes('Run /init') : prompts() >= 1), 60000);
const booted = performance.now();
console.error(
	`[test] boot ${(booted - t0).toFixed(0)} ms wall, stats ${JSON.stringify(machine.stats)}`
);
if (process.env.TAX === '1') {
	const j0 = performance.now();
	machine.type(`${process.env.TAXCMD ?? 'yes | head -c 100000000 | sha256sum'}; echo TAX$((1+1))DONE\n`);
	await wait(machine, () => output.includes('TAX2DONE'), 300000);
	console.error(
		`[tax] ${plain ? 'plain' : 'asyncify'} boot ${(booted - t0).toFixed(0)} ms job ${(performance.now() - j0).toFixed(0)} ms`
	);
	process.exit(0);
}

// a cpu-bound job in the background and a shell waiting at its prompt
const idle = process.env.IDLE === '1';
machine.type(
	idle
		? 'echo 504832ca4f576454c1e2393b2cab3942a54fcd26faf099128cf9c05cd11641b8 > /sum\n'
		: 'yes | head -c 100000000 | sha256sum > /sum &\n'
);
await wait(machine, () => false, 3000);
const before = output.length;
const c0 = performance.now();
const snapshot = await machine.checkpoint();
const c1 = performance.now();
const stackBytes = snapshot.runners.reduce(
	(a, r) => a + (r.kernelStack?.byteLength ?? 0) + (r.userStack?.byteLength ?? 0),
	0
);
console.error(
	`[test] checkpoint ${(c1 - c0).toFixed(0)} ms, memory ${snapshot.memory.byteLength >> 20} MiB, runners ${snapshot.runners.length}, ` +
		`stacks ${snapshot.runners.filter((r) => r.kernelStack || r.userStack).length} (${stackBytes} B), user programs ${snapshot.runners.filter((r) => r.program).length}`
);

// a fresh machine: new memory, new instances, nothing carried over but the snapshot
const r0 = performance.now();
machine = await Machine.restore(options, snapshot);
const r1 = performance.now();
const scratch = [snapshot.scratch, snapshot.scratch + 32 * 0x10000];
const now = new Uint8Array(machine.memory.buffer);
let diff = 0;
for (let i = 0; i < snapshot.memory.byteLength; i++)
	if ((i < scratch[0]! || i >= scratch[1]!) && now[i] !== snapshot.memory[i]) diff++;
console.error(
	`[test] restore ${(r1 - r0).toFixed(0)} ms, bytes changed outside scratch by restore: ${diff}`
);

await wait(machine, () => false, 20000);
machine.type('wait; cat /sum; echo ALIVE-$((6*7))\n');
await wait(machine, () => output.slice(before).includes('ALIVE-42'), 120000);
const expected = createHash('sha256').update(Buffer.alloc(100000000, 'y\n')).digest('hex');
const got = output.slice(before).match(/([0-9a-f]{64})/)?.[1];
console.error(
	`[test] after restore: sum ${got} expected ${expected} ${got === expected ? 'EXACT' : 'MISMATCH'}; shell ${output.slice(before).includes('ALIVE-42') ? 'alive' : 'dead'}`
);
console.error(`[test] output after restore: ${JSON.stringify(output.slice(before).slice(-300))}`);
console.error(`[test] stats ${JSON.stringify(machine.stats)} crashed=${String(machine.crashed)}`);
process.exit(got === expected ? 0 : 1);
