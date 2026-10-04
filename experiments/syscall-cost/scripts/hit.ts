import binaryen from 'binaryen';
import { routerModules } from '../../../scripts/wasm/router-modules.ts';
import { StatxTable, SYS_STATX } from '../../../src/worker/machine/router.ts';

/**
 * Nanoseconds per statx hit by the number of kernel counters the answer is held on (0: the kernel's
 * whole generation), from a wasm loop calling the hit export, so a hit costs what the router's tail
 * call into it costs. The kernel's three exports are a wasm stub, since a JS import would add its own
 * crossing. GMUX_BUILD names the router build.
 * `node --experimental-strip-types experiments/syscall-cost/scripts/hit.ts [calls] [rounds]`
 */
const calls = Number(process.argv[2] ?? 5_000_000);
const rounds = Number(process.argv[3] ?? 5);
const wasm = (wat: string) => {
	const module = binaryen.parseText(wat);
	module.setFeatures(binaryen.Features.All);
	if (!module.validate()) throw new Error('does not validate');
	const bytes = module.emitBinary();
	module.dispose();
	return new WebAssembly.Module(bytes);
};
const kernel = new WebAssembly.Instance(
	wasm(`(module
		(memory 1)
		(func (export "view") (result i32) (i32.const 0x1234))
		(func (export "gen") (result i32) (i32.const 0))
		(func (export "at") (param i32) (result i32)
			(i32.load (i32.shl (i32.and (local.get 0) (i32.const 1023)) (i32.const 2)))))`)
).exports as Record<string, WebAssembly.ExportValue>;
const user = new WebAssembly.Memory({ initial: 1, maximum: 4, shared: true });
const table = new StatxTable(false);
const statx = new WebAssembly.Instance(routerModules().statx, {
	env: { user, table: table.memory },
	kernel: { view: kernel.view as Function, gen: kernel.gen as Function, at: kernel.at as Function }
}).exports as { hit: Function; key: (...a: number[]) => bigint };
const driver = new WebAssembly.Instance(
	wasm(`(module
		(import "e" "hit" (func $hit (param i32 i32 i32 i32 i32 i32 i32 i32) (result i32)))
		(func (export "run") (param $n i32) (result i32)
			(local $sink i32)
			(loop $next
				(local.set $sink
					(i32.add (local.get $sink)
						(call $hit (i32.const 0) (i32.const 0) (i32.const ${SYS_STATX}) (i32.const -100)
							(i32.const 0x100) (i32.const 0) (i32.const 0x7ff) (i32.const 0x400))))
				(br_if $next (local.tee $n (i32.sub (local.get $n) (i32.const 1)))))
			(local.get $sink)))`),
	{ e: { hit: statx.hit as Function } }
).exports.run as (n: number) => number;

const path = new TextEncoder().encode('/usr/lib/x86_64-linux-gnu/x');
new Uint8Array(user.buffer).set([...path, 0], 0x100);
const hash = Number(BigInt.asUintN(32, statx.key(0x100, 0x1234, 0, 0x7ff)));
const answer = new Uint8Array(256);
const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[xs.length >> 1]!;
const rows: Record<string, { ns: number[] }> = {};
for (const guards of [0, 1, 2, 3, 4, 6, 8]) {
	table.set(hash, {
		view: 0x1234,
		flags: 0,
		mask: 0x7ff,
		path,
		gen: 0,
		guards: Array.from({ length: guards }, (_, i) => [i + 1, 0]),
		ret: 0,
		bytes: answer
	});
	driver(1000);
	rows[guards] = { ns: [] };
	for (let r = 0; r < rounds; r++) {
		const t = performance.now();
		const sink = driver(calls);
		rows[guards]!.ns.push(+(((performance.now() - t) * 1e6) / calls).toFixed(2));
		if (sink !== 0) throw new Error(`a call missed: ${sink}`);
	}
}
for (const [guards, { ns }] of Object.entries(rows))
	console.log(JSON.stringify({ guards: Number(guards), median: median(ns), ns }));
