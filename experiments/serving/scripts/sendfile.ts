import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { appendCpio } from '../../../scripts/wasm/cpio-append.ts';
import { Machine } from '../../../src/worker/machine/machine.ts';

/**
 * CPU of moving bytes to a loopback socket with sendfile, splice or read and write, through the
 * tests/c/sendfile probe in a machine. The probe forks a receiver that discards; a sample boots a
 * machine, runs the probe with no transfers (the fixed cost: fork, the source file, the connection),
 * then with CALLS transfers of SIZE bytes, and reports the difference per transfer.
 *   MODE=prep (needs wasm2wat and wat2wasm): writes WORK/sendfile.run.wasm, the probe with fuel checks
 *     and resumable frames, which fork needs
 *   default: KIND=sendfile|splice|rw SIZE=<bytes> CALLS=<n>; one JSON line
 * PROBE is the probe as the pipeline built it (build/probes/sendfile.wasm); WORK keeps the prep
 * output and the generated initramfs.
 * `node --no-warnings --experimental-strip-types experiments/serving/scripts/sendfile.ts <kernel dir>`
 */
const root = new URL('../../../', import.meta.url).pathname;
const dir = process.argv[2] ?? join(root, 'build/kernel');
const probe = process.env.PROBE ?? join(root, 'build/probes/sendfile.wasm');
const work = process.env.WORK ?? join(root, 'build/batch/run4/P1-b/work');
const run = join(work, 'sendfile.run.wasm');
const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
mkdirSync(work, { recursive: true });

if (process.env.MODE === 'prep') {
	const fueled = join(work, 'sendfile.fueled.wasm');
	execFileSync(join(root, 'scripts/wasm/instrument.sh'), [probe, fueled]);
	execFileSync(
		join(root, 'scripts/ts'),
		[join(root, 'scripts/wasm/export-globals.ts'), fueled, `${fueled}.g`, '--all-mutable'],
		{ stdio: 'ignore' }
	);
	execFileSync(
		process.execPath,
		[
			join(root, 'experiments/evacuation/scripts/evacuate.ts'),
			`${fueled}.g`,
			run,
			process.env.GMUX_EVACUATE ?? '--resume'
		],
		{ stdio: 'ignore' }
	);
	console.log(JSON.stringify({ prep: run, probe: sha256(readFileSync(probe)) }));
	process.exit(0);
}

const kind = process.env.KIND ?? 'sendfile';
const size = Number(process.env.SIZE ?? 65536);
const calls = Number(process.env.CALLS ?? 1000);
if (!['sendfile', 'splice', 'rw'].includes(kind)) throw new Error(`KIND ${kind}`);
if (!existsSync(run)) throw new Error(`${run} is missing; run MODE=prep first`);

const manifest = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8'));
const cpio = join(work, 'initramfs-sendfile.cpio');
if (!existsSync(cpio)) appendCpio(join(dir, 'initramfs.bin'), cpio, [`/bin/sendfile=${probe}`]);
let output = '';
const machine = new Machine({
	vmlinux: new WebAssembly.Module(readFileSync(join(dir, 'vmlinux.wasm'))),
	initrd: new Uint8Array(readFileSync(cpio)),
	cmdline: 'maxcpus=3 root=/dev/ram0 rootfstype=ramfs init=/init console=hvc console=ttyS0',
	registry: new Map([
		[manifest.busybox, new WebAssembly.Module(readFileSync(join(dir, 'busybox.wasm')))],
		[sha256(readFileSync(probe)), new WebAssembly.Module(readFileSync(run))]
	]),
	maximumPages: 4096,
	sha256,
	sharedKernel: true,
	write: (text) => (output += text)
});
const sleep = () => new Promise<void>((r) => setImmediate(r));
const until = (done: () => boolean, limitMs = 300_000) => {
	const started = Date.now();
	return machine.run(() => done() || Date.now() - started > limitMs, sleep);
};

async function sh(command: string) {
	const from = output.length;
	machine.type(`${command}; echo end=$((6*7))-$?\n`);
	const want = /end=42-(\d+)/;
	await until(() => want.test(output.slice(from)));
	const text = output.slice(from).replace(/\r/g, '');
	return { text, rc: Number(want.exec(text)?.[1] ?? -1) };
}

await until(() => output.includes('# '));
await sh('ifconfig lo 127.0.0.1 up');
const probeRun = (n: number) => `sendfile cpu ${kind} ${size} ${n}`;
await sh(probeRun(1));
// the fixed cost, then the transfers
const measure = async (n: number) => {
	const before = { ...machine.stats };
	const cpu = process.cpuUsage();
	const t0 = performance.now();
	const result = await sh(probeRun(n));
	const used = process.cpuUsage(cpu);
	const after = { ...machine.stats };
	return {
		result,
		cpuMs: (used.user + used.system) / 1000,
		wallMs: performance.now() - t0,
		userCopies: after.userCopies - before.userCopies,
		userCopyBytes: after.userCopyBytes - before.userCopyBytes,
		switches: after.switches - before.switches
	};
};
const base = await measure(0);
const main = await measure(calls);
const line = new RegExp(`cpu ${kind} ${size} x ${calls}: sent (\\d+), received (\\d+)`).exec(
	main.result.text
);
const ok = main.result.rc === 0 && line?.[1] === String(size * calls) && line?.[2] === String(size * calls);
console.log(
	JSON.stringify({
		host: 'machine',
		kind,
		size,
		calls,
		ok,
		crashed: String(machine.crashed),
		baseCpuMs: +base.cpuMs.toFixed(3),
		cpuMs: +main.cpuMs.toFixed(3),
		wallMs: +main.wallMs.toFixed(3),
		cpuUsPerCall: +(((main.cpuMs - base.cpuMs) * 1000) / calls).toFixed(3),
		userCopies: main.userCopies - base.userCopies,
		userCopyBytes: main.userCopyBytes - base.userCopyBytes,
		switches: main.switches - base.switches
	})
);
process.exit(ok ? 0 : 1);
