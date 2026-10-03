import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Machine } from '../../../src/worker/machine/machine.ts';

/**
 * ns per host crossing into a fork child's own memory: the machine's `wasm_user_copy` import now
 * (a span checked once, views kept) against the import as it was before (a view of both memories
 * made for every call), on the same memories, interleaved over the rounds. The child's memory is
 * 42 MB, as in own-memory.ts. The wasm-to-host transition and the kernel's own work are not in
 * either arm.
 * `node --experimental-strip-types experiments/mmu/scripts/crossing.ts [rounds]`
 */
const root = new URL('../../../', import.meta.url).pathname;
const rounds = Number(process.argv[2] ?? 9);
const build = process.env.GMUX_BUILD ?? join(root, 'build');
const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const machine = new Machine({
	vmlinux: new WebAssembly.Module(readFileSync(join(build, 'kernel/vmlinux.wasm'))),
	initrd: new Uint8Array(0),
	cmdline: '',
	registry: new Map(),
	maximumPages: 4096,
	sha256,
	sharedKernel: true
});
const internals = machine as any;
const child = new WebAssembly.Memory({ initial: 672, maximum: 4096, shared: true });
const mm = 1;
internals.privateMemories.set(mm, child);
const runner = { instance: { exports: { wasm_current_mm: () => mm } } };
const next: (k: number, u: number, n: number, mode: number) => number = internals.rawImports(
	() => runner
).wasm_user_copy;

// the import as it stood before the domain: a view of each memory per call
function before(k: number, u: number, n: number, mode: number) {
	const mem = internals.userMemory(runner) as WebAssembly.Memory;
	const [kk, uu, len] = [k >>> 0, u >>> 0, n >>> 0];
	const user = new Uint8Array(mem.buffer);
	if (mem === machine.memory || uu + len > user.length) return len;
	if (mode === 0) new Uint8Array(machine.memory.buffer).set(user.subarray(uu, uu + len), kk);
	else if (mode === 1) user.set(new Uint8Array(machine.memory.buffer, kk, len), uu);
	else user.fill(0, uu, uu + len);
	return 0;
}

const sizes = [8, 24, 144, 256, 4096, 65536];
const user = 0x100000;
const kernel = 0x1000;
const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]!;
const time = (fn: typeof before, n: number, calls: number) => {
	const start = process.hrtime.bigint();
	// to the kernel (mode 1), from it (mode 0), and zeroing (mode 2), in turn
	for (let i = 0; i < calls; i++) fn(kernel, user + (i & 7) * 64, n, i % 3);
	return Number(process.hrtime.bigint() - start) / calls;
};
const out: object[] = [];
for (const n of sizes) {
	const calls = Math.max(20000, Math.floor(4e8 / (n + 200)) | 0) >> 3;
	time(before, n, calls);
	time(next, n, calls);
	const a: number[] = [];
	const b: number[] = [];
	for (let r = 0; r < rounds; r++) {
		if (r & 1) {
			b.push(time(next, n, calls));
			a.push(time(before, n, calls));
		} else {
			a.push(time(before, n, calls));
			b.push(time(next, n, calls));
		}
	}
	out.push({
		bytes: n,
		calls,
		beforeNs: +median(a).toFixed(1),
		beforeSpread: [+Math.min(...a).toFixed(1), +Math.max(...a).toFixed(1)],
		nextNs: +median(b).toFixed(1),
		nextSpread: [+Math.min(...b).toFixed(1), +Math.max(...b).toFixed(1)],
		ratio: +(median(a) / median(b)).toFixed(2)
	});
}
for (const row of out) console.log(JSON.stringify(row));
console.log(JSON.stringify({ rounds, copies: machine.stats.userCopies, bytes: machine.stats.userCopyBytes }));
process.exit(0);
