import binaryen from 'binaryen';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { routerModules } from '../../../scripts/wasm/router-modules.ts';
import { Machine } from '../../../src/worker/machine/machine.ts';

/**
 * What a statx the cache has no answer for costs, by part, and what a fill that never suspended
 * could save. A: a wasm loop calling an import that is plain JS, a Suspending async function, and a
 * Suspending function that awaits a `promising` call of a wasm export (a hook that asks the kernel
 * and a probe). B: in a machine with `syscallCache: 'verify'` (every statx is a miss), the time in the
 * hook, in statxQuery, in statxFill and in its probes, as monkeypatched wrappers see it. GMUX_BUILD
 * names the kernel. `node --experimental-strip-types experiments/syscall-cost/scripts/miss.ts [n]`
 */
const n = Number(process.argv[2] ?? 300);

// #region A
const assemble = (text: string) => {
	const module = binaryen.parseText(text);
	module.setFeatures(binaryen.Features.All);
	const bytes = module.emitBinary();
	module.dispose();
	return new WebAssembly.Module(bytes);
};
const loop = assemble(`(module
	(import "e" "f" (func $f (param i32) (result i32)))
	(func (export "run") (param $n i32) (result i32)
		(local $sink i32)
		(loop $next
			(local.set $sink (i32.add (local.get $sink) (call $f (local.get $n))))
			(br_if $next (local.tee $n (i32.sub (local.get $n) (i32.const 1)))))
		(local.get $sink)))`);
const trivial = new WebAssembly.Instance(
	assemble('(module (func (export "k") (param i32) (result i32) (local.get 0)))')
).exports.k as (n: number) => number;
const N = 200_000;
const ns = async (name: string, f: Function, suspends: boolean) => {
	const run = new WebAssembly.Instance(loop, { e: { f } }).exports.run as (n: number) => number;
	const call = suspends ? WebAssembly.promising(run as never) : (run as never as Function);
	const asked: number[] = [];
	for (let r = 0; r < 5; r++) {
		const t = performance.now();
		await call(N);
		asked.push(((performance.now() - t) * 1e6) / N);
	}
	asked.sort((a, b) => a - b);
	console.log(JSON.stringify({ part: 'A', name, ns: +asked[2]!.toFixed(1), rounds: asked.map((x) => +x.toFixed(1)) }));
};
await ns('plain JS import', (x: number) => x, false);
await ns('Suspending async import', new WebAssembly.Suspending(async (x: number) => x), true);
const promisingK = WebAssembly.promising(trivial as never);
await ns(
	'Suspending import awaiting a promising wasm call',
	new WebAssembly.Suspending(async (x: number) => Number(await promisingK(x))),
	true
);
// #endregion

// #region B
const root = new URL('../../../', import.meta.url).pathname;
const kernel = join(process.env.GMUX_BUILD ?? join(root, 'build'), 'kernel');
const read = (path: string) => new Uint8Array(readFileSync(path));
const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const manifest = JSON.parse(readFileSync(join(kernel, 'manifest.json'), 'utf8'));
let output = '';
const machine = new Machine({
	vmlinux: new WebAssembly.Module(read(join(kernel, 'vmlinux.wasm'))),
	initrd: read(join(kernel, 'initramfs.bin')),
	cmdline: 'maxcpus=3 root=/dev/ram0 rootfstype=ramfs init=/init console=hvc console=ttyS0',
	registry: new Map([
		[manifest.busybox, new WebAssembly.Module(read(join(kernel, 'busybox.wasm')))]
	]),
	maximumPages: 1024,
	sha256,
	sharedKernel: true,
	syscallCache: 'verify',
	router: routerModules(),
	write: (text) => (output += text)
});
const spent: Record<string, { calls: number; ms: number }> = {};
const wrap = (name: string, only?: (args: unknown[]) => boolean) => {
	const m = machine as any;
	const original = m[name].bind(machine);
	spent[name] = { calls: 0, ms: 0 };
	m[name] = (...args: unknown[]) => {
		if (only && !only(args)) return original(...args);
		const t = performance.now();
		const result = original(...args);
		const done = (v: unknown) => {
			spent[name]!.calls++;
			spent[name]!.ms += performance.now() - t;
			return v;
		};
		return result instanceof Promise ? result.then(done) : done(result);
	};
};
wrap('syscallHook', (args) => args[3] === 291);
wrap('statxQuery');
wrap('statxFill');
wrap('statxProbe');
const run = async (until: () => boolean) => {
	await machine.run(
		() => until(),
		(ms) => new Promise((r) => setTimeout(r, Math.min(ms, 5)))
	);
};
await run(() => output.includes('# '));
const at = output.length;
machine.type(`i=0; while [ $i -lt ${n} ]; do ls -l /bin > /dev/null; i=$((i+1)); done; echo @@DONE$((1+1))\n`);
await run(() => output.slice(at).includes('@@DONE2\r\n'));
const calls = spent.syscallHook!.calls;
const per = (name: string) => +((spent[name]!.ms * 1e6) / calls).toFixed(0);
const hook = per('syscallHook');
const fill = per('statxFill');
const probe = per('statxProbe');
const query = per('statxQuery');
console.log(
	JSON.stringify({
		part: 'B',
		statxCalls: calls,
		probes: spent.statxProbe!.calls,
		probesPerCall: +(spent.statxProbe!.calls / calls).toFixed(2),
		perCallNs: {
			hook,
			query,
			fill,
			probes: probe,
			fillBookkeeping: fill - probe,
			kernelViaHook: hook - fill - query
		},
		perProbeNs: +((spent.statxProbe!.ms * 1e6) / Math.max(1, spent.statxProbe!.calls)).toFixed(0)
	})
);
// #endregion
process.exit(0);
