import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync } from 'node:fs';
import { Session } from 'node:inspector/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { appendCpio } from '../../../scripts/wasm/cpio-append.ts';
import { Machine } from '../../../src/worker/machine/machine.ts';

/**
 * host nanoseconds per call for the syscalls src/cost.c loops over, timed between its markers as the
 * console delivers them, minus the empty loop. `cost.wasm` is src/cost.c built like a tests/c probe.
 * PROFILE=getdents instead samples a run of only the directory loop and prints the functions with the
 * most samples (VMLINUX names a kernel built with its name section, for kernel function names).
 * GMUX_BUILD picks the build, as tests/c/run.ts does. CACHE=1 answers repeated absolute statx from the
 * host (MachineOptions.syscallCache, with a kernel that has patch 0022), CACHE=verify checks it.
 * `node --experimental-strip-types experiments/syscall-cost/scripts/cost.ts <cost.wasm> [n] [rounds]`
 */
const root = new URL('../../../', import.meta.url).pathname;
const [plain, n = '20000', rounds = '3'] = process.argv.slice(2);
if (!plain) throw new Error('usage: cost.ts <cost.wasm> [n] [rounds]');
const kernel = join(process.env.GMUX_BUILD ?? join(root, 'build'), 'kernel');
const work = mkdtempSync(join(tmpdir(), 'gmux-syscall-cost-'));
const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const manifest = JSON.parse(readFileSync(join(kernel, 'manifest.json'), 'utf8'));
execFileSync(join(root, 'scripts/wasm/instrument.sh'), [plain, join(work, 'cost.fuel.wasm')]);
appendCpio(join(kernel, 'initramfs.bin'), join(work, 'initramfs.cpio'), [`/bin/cost=${plain}`]);

let output = '';
const marks: [string, number, number][] = [];
const machine = new Machine({
	vmlinux: new WebAssembly.Module(readFileSync(process.env.VMLINUX ?? join(kernel, 'vmlinux.wasm'))),
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
	syscallCache: process.env.CACHE === "verify" ? "verify" : process.env.CACHE === "1",
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
if (process.env.PROFILE === 'getdents') {
	const session = new Session();
	session.connect();
	await session.post('Profiler.enable');
	await session.post('Profiler.setSamplingInterval', { interval: 100 });
	const start = output.length;
	const t0 = performance.now();
	await session.post('Profiler.start');
	machine.type(`cost ${n} getdents\n`);
	await run(() => output.slice(start).includes('cost done'));
	const { profile } = await session.post('Profiler.stop');
	const ms = performance.now() - t0;
	const byId = new Map(profile.nodes.map((node) => [node.id, node]));
	const self = new Map<string, number>();
	for (const id of profile.samples ?? []) {
		const frame = byId.get(id)!.callFrame;
		const name = frame.url.startsWith('wasm://') ? frame.functionName : `(host) ${frame.functionName || frame.url}`;
		self.set(name, (self.get(name) ?? 0) + 1);
	}
	const total = [...self.values()].reduce((a, b) => a + b, 0);
	const entries = Number(/cost done (\d+)/.exec(output.slice(start))?.[1] ?? 0) / Number(n);
	console.log(JSON.stringify({ directories: Number(n), entriesPerDirectory: entries, usPerDirectory: +((ms * 1000) / Number(n)).toFixed(2), samples: total }));
	for (const [name, count] of [...self].sort((a, b) => b[1] - a[1]).slice(0, 25))
		console.log(`| ${name} | ${((100 * count) / total).toFixed(1)}% |`);
	process.exit(0);
}
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
const { statxHits, statxMisses, statxFills, statxMismatches } = machine.stats;
console.log(JSON.stringify({ statxHits, statxMisses, statxFills, statxMismatches }));
