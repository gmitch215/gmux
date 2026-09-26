import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Machine } from '../../../src/worker/machine/machine.ts';

/**
 * host nanoseconds per call for the syscalls src/cost.c loops over, timed between its markers as the
 * console delivers them, minus the empty loop. `cost.wasm` is src/cost.c built like a tests/c probe.
 * `node --experimental-strip-types experiments/syscall-cost/scripts/cost.ts <cost.wasm> [n] [rounds]`
 */
const root = new URL('../../../', import.meta.url).pathname;
const [plain, n = '20000', rounds = '3'] = process.argv.slice(2);
if (!plain) throw new Error('usage: cost.ts <cost.wasm> [n] [rounds]');
const kernel = join(root, 'build/kernel');
const work = mkdtempSync(join(tmpdir(), 'gmux-syscall-cost-'));
const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const manifest = JSON.parse(readFileSync(join(kernel, 'manifest.json'), 'utf8'));
execFileSync(join(root, 'scripts/wasm/instrument.sh'), [plain, join(work, 'cost.fuel.wasm')]);
execFileSync('python3', [
	join(root, 'scripts/wasm/cpio-append.py'),
	join(kernel, 'initramfs.bin'),
	join(work, 'initramfs.cpio'),
	`/bin/cost=${plain}`
]);

let output = '';
const marks: [string, number, number][] = [];
const machine = new Machine({
	vmlinux: new WebAssembly.Module(readFileSync(join(kernel, 'vmlinux.wasm'))),
	initrd: new Uint8Array(readFileSync(join(work, 'initramfs.cpio'))),
	cmdline:
		'maxcpus=3 root=/dev/ram0 rootfstype=ramfs init=/init console=hvc console=ttyS0',
	registry: new Map([
		[manifest.busybox, new WebAssembly.Module(readFileSync(join(kernel, 'busybox.wasm')))],
		[sha256(new Uint8Array(readFileSync(plain))), new WebAssembly.Module(readFileSync(join(work, 'cost.fuel.wasm')))]
	]),
	maximumPages: 1024,
	sha256,
	sharedKernel: true,
	write: (text) => {
		const at = performance.now();
		output += text;
		for (const m of text.matchAll(/mark (\S+) (\d+)/g)) marks.push([m[1]!, Number(m[2]), at]);
	}
});
const run = async (until: () => boolean) => {
	const t = Date.now();
	await machine.run(
		() => until() || Date.now() - t > 120_000,
		(ms) => new Promise((r) => setTimeout(r, Math.min(ms, 5)))
	);
	if (!until()) throw new Error(`stuck: ${output.match(/mark \S+ \d+/g)?.join(" | ")} ${output.slice(-300)}`);
};

await run(() => output.includes('# '));
const perCall = new Map<string, number[]>();
for (let r = 0; r < Number(rounds); r++) {
	marks.length = 0;
	const start = output.length;
	machine.type(`cost ${n}\n`);
	await run(() => output.slice(start).includes('cost done'));
	let loop = 0;
	for (let i = 0; i + 1 < marks.length; i += 2) {
		const [name, count, begin] = marks[i]!;
		const ns = ((marks[i + 1]![2] - begin) * 1e6) / count;
		if (name === 'loop') loop = ns;
		else perCall.set(name, [...(perCall.get(name) ?? []), ns - loop]);
	}
}
const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[xs.length >> 1]!;
console.log(
	JSON.stringify(Object.fromEntries([...perCall].map(([k, v]) => [k, Math.round(median(v))])))
);
console.log(JSON.stringify({ unit: 'host ns per call, median of rounds', crashed: String(machine.crashed) }));
