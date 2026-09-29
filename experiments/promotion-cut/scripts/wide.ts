import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

/**
 * What a thunk costs when its import carries an i64 or a float, without editing burrow. The interpreter
 * shim (burrow's wasm3.wasm) already hands `host_call` the raw 64-bit wasm3 stack slots and takes any
 * signature wasm3 knows (`I` is i64, `F` f64, `f` f32); only burrow's own JS `host_call` narrows every
 * argument to i32. This rig instantiates the same wasm3.wasm with a `host_call` that reads each slot
 * by the signature's letter, and times a thunk (host import, JS glue, a V8 export that sets the stack
 * pointer) for `i(ii)` against `i(iI)`, `i(iF)` and `I(iI)`, the cut-model's method: loop with the crossing against the same loop without it, n and 2n,
 * arms interleaved, paired rounds. The `i(ii)` arm is also run through burrow's own createInterpreter as
 * the control for this rig's copy of `host_call`.
 * `node --experimental-strip-types wide.ts <burrow dist> [rounds]`, prints JSON.
 */
const [dist = '', roundsArg = '15'] = process.argv.slice(2);
if (!dist) {
	console.error('usage: wide.ts <burrow dist> [rounds]');
	process.exit(2);
}
const rounds = Number(roundsArg);
const wasmTools = (input: string) => execFileSync('wasm-tools', ['parse', '-o', '/dev/stdout'], { input, maxBuffer: 1 << 24 });
const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]!;
const summary = (xs: number[]) => ({ median: median(xs), min: Math.min(...xs), max: Math.max(...xs), spread: (Math.max(...xs) - Math.min(...xs)) / median(xs) });

const guestWat = `(module
	(import "native" "ti" (func $ti (param i32 i32) (result i32)))
	(import "native" "tI" (func $tI (param i32 i64) (result i32)))
	(import "native" "tF" (func $tF (param i32 f64) (result i32)))
	(import "native" "tJ" (func $tJ (param i32 i64) (result i64)))
	(memory 1)
	(func (export "empty_i") (param $n i32) (result i32)
		(local $i i32) (local $s i32)
		(loop $next
			(local.set $s (i32.add (local.get $s) (i32.const 1)))
			(local.set $i (i32.add (local.get $i) (i32.const 1)))
			(br_if $next (i32.lt_u (local.get $i) (local.get $n))))
		(local.get $s))
	(func (export "empty_I") (param $n i32) (result i32)
		(local $i i32) (local $s i32) (local $w i64)
		(loop $next
			(local.set $w (i64.extend_i32_u (local.get $s)))
			(local.set $s (i32.add (local.get $s) (i32.const 1)))
			(local.set $i (i32.add (local.get $i) (i32.const 1)))
			(br_if $next (i32.lt_u (local.get $i) (local.get $n))))
		(i32.add (local.get $s) (i32.wrap_i64 (local.get $w))))
	(func (export "empty_F") (param $n i32) (result i32)
		(local $i i32) (local $s i32) (local $d f64)
		(loop $next
			(local.set $d (f64.convert_i32_u (local.get $s)))
			(local.set $s (i32.add (local.get $s) (i32.const 1)))
			(local.set $i (i32.add (local.get $i) (i32.const 1)))
			(br_if $next (i32.lt_u (local.get $i) (local.get $n))))
		(i32.add (local.get $s) (i32.trunc_f64_u (local.get $d))))
	(func (export "cross_i") (param $n i32) (result i32)
		(local $i i32) (local $s i32)
		(loop $next
			(local.set $s (call $ti (i32.const 1024) (local.get $s)))
			(local.set $i (i32.add (local.get $i) (i32.const 1)))
			(br_if $next (i32.lt_u (local.get $i) (local.get $n))))
		(local.get $s))
	(func (export "cross_I") (param $n i32) (result i32)
		(local $i i32) (local $s i32) (local $w i64)
		(loop $next
			(local.set $w (i64.extend_i32_u (local.get $s)))
			(local.set $s (call $tI (i32.const 1024) (local.get $w)))
			(local.set $i (i32.add (local.get $i) (i32.const 1)))
			(br_if $next (i32.lt_u (local.get $i) (local.get $n))))
		(i32.add (local.get $s) (i32.wrap_i64 (local.get $w))))
	(func (export "cross_F") (param $n i32) (result i32)
		(local $i i32) (local $s i32) (local $d f64)
		(loop $next
			(local.set $d (f64.convert_i32_u (local.get $s)))
			(local.set $s (call $tF (i32.const 1024) (local.get $d)))
			(local.set $i (i32.add (local.get $i) (i32.const 1)))
			(br_if $next (i32.lt_u (local.get $i) (local.get $n))))
		(i32.add (local.get $s) (i32.trunc_f64_u (local.get $d))))
	(func (export "empty_J") (param $n i32) (result i32)
		(local $i i32) (local $s i32) (local $w i64)
		(loop $next
			(local.set $w (i64.extend_i32_u (local.get $s)))
			(local.set $s (i32.add (local.get $s) (i32.const 1)))
			(local.set $i (i32.add (local.get $i) (i32.const 1)))
			(br_if $next (i32.lt_u (local.get $i) (local.get $n))))
		(i32.add (local.get $s) (i32.wrap_i64 (local.get $w))))
	(func (export "cross_J") (param $n i32) (result i32)
		(local $i i32) (local $s i32) (local $w i64)
		(loop $next
			(local.set $w (call $tJ (i32.const 1024) (i64.extend_i32_u (local.get $s))))
			(local.set $s (i32.wrap_i64 (local.get $w)))
			(local.set $i (i32.add (local.get $i) (i32.const 1)))
			(br_if $next (i32.lt_u (local.get $i) (local.get $n))))
		(local.get $s))
)`;
const nativeWat = `(module
	(global $sp (mut i32) (i32.const 0))
	(func (export "ni") (param $sp i32) (param $a i32) (result i32)
		(global.set $sp (local.get $sp))
		(i32.add (local.get $a) (i32.const 1)))
	(func (export "nI") (param $sp i32) (param $a i64) (result i32)
		(global.set $sp (local.get $sp))
		(i32.add (i32.wrap_i64 (local.get $a)) (i32.const 1)))
	(func (export "nF") (param $sp i32) (param $a f64) (result i32)
		(global.set $sp (local.get $sp))
		(i32.add (i32.trunc_f64_u (local.get $a)) (i32.const 1)))
	(func (export "nJ") (param $sp i32) (param $a i64) (result i64)
		(global.set $sp (local.get $sp))
		(i64.add (local.get $a) (i64.const 1)))
)`;
const controlWat = `(module
	(import "native" "ti" (func $ti (param i32 i32) (result i32)))
	(memory 1)
	(func (export "empty_i") (param $n i32) (result i32)
		(local $i i32) (local $s i32)
		(loop $next
			(local.set $s (i32.add (local.get $s) (i32.const 1)))
			(local.set $i (i32.add (local.get $i) (i32.const 1)))
			(br_if $next (i32.lt_u (local.get $i) (local.get $n))))
		(local.get $s))
	(func (export "cross_i") (param $n i32) (result i32)
		(local $i i32) (local $s i32)
		(loop $next
			(local.set $s (call $ti (i32.const 1024) (local.get $s)))
			(local.set $i (i32.add (local.get $i) (i32.const 1)))
			(br_if $next (i32.lt_u (local.get $i) (local.get $n))))
		(local.get $s))
)`;
const guestBytes = new Uint8Array(wasmTools(guestWat));
const native = new WebAssembly.Instance(new WebAssembly.Module(wasmTools(nativeWat))).exports as Record<string, (...a: (number | bigint)[]) => number | bigint>;
const wasm3 = new WebAssembly.Module(readFileSync(`${dist}/vendor/wasm3.wasm`));

// a copy of burrow's createInterpreter reduced to loading one guest, with a host_call that reads each slot by its signature letter
interface Linked {
	kinds: string;
	result: string;
	fn: (...a: (number | bigint)[]) => number | bigint | void;
}
async function wideInterpreter(imports: Record<string, { signature: string; fn: Linked['fn'] }>) {
	const handlers: Linked[] = [];
	let shim: Record<string, (...a: number[]) => number | bigint> & { memory: WebAssembly.Memory };
	const instance = await WebAssembly.instantiate(wasm3, {
		env: { emscripten_notify_memory_growth: () => {} },
		burrow: {
			host_call: (id: number, sp: number): number => {
				const h = handlers[id]!;
				const base = h.result === 'v' ? 0 : 1;
				const buf = shim.memory.buffer;
				const args: (number | bigint)[] = [];
				for (let i = 0; i < h.kinds.length; i++) {
					const at = sp + 8 * (base + i);
					switch (h.kinds[i]) {
						case 'i':
							args.push(new Int32Array(buf, at, 1)[0]!);
							break;
						case 'I':
							args.push(new BigInt64Array(buf, at, 1)[0]!);
							break;
						case 'F':
							args.push(new Float64Array(buf, at, 1)[0]!);
							break;
						default:
							args.push(new Float32Array(buf, at, 1)[0]!);
					}
				}
				const out = h.fn(...args);
				if (h.result === 'i') new BigUint64Array(buf, sp, 1)[0] = BigInt(out as number) & 0xffffffffn;
				else if (h.result === 'I') new BigInt64Array(buf, sp, 1)[0] = out as bigint;
				return 0;
			}
		}
	});
	shim = instance.exports as typeof shim;
	(shim._initialize as () => void)();
	if (shim.burrow_init!(8 * 1024 * 1024, 0) !== 0) throw new Error('init');
	const cstring = (s: string) => {
		const b = new TextEncoder().encode(`${s}\0`);
		const p = shim.burrow_alloc!(b.length) as number;
		new Uint8Array(shim.memory.buffer).set(b, p);
		return p;
	};
	const ptr = shim.burrow_alloc!(guestBytes.length) as number;
	new Uint8Array(shim.memory.buffer).set(guestBytes, ptr);
	const index = shim.burrow_parse!(ptr, guestBytes.length) as number;
	if (index < 0) throw new Error('parse');
	if (shim.burrow_instantiate!(index) !== 0) throw new Error('instantiate');
	for (const [field, spec] of Object.entries(imports)) {
		const id = shim.burrow_link!(index, cstring('native'), cstring(field), cstring(spec.signature)) as number;
		if (id < 0) throw new Error(`link ${field}`);
		const open = spec.signature.indexOf('(');
		handlers[id] = { kinds: spec.signature.slice(open + 1, -1), result: spec.signature[0]!, fn: spec.fn };
	}
	return (name: string, n: number) => {
		const r = shim.burrow_call_in!(index, cstring(name), n, 0, 0, 0) as bigint;
		return Number(r) >>> 0;
	};
}

const thunk = (name: string) => (...a: (number | bigint)[]) => native[name]!(...a);
const wideImports = {
	ti: { signature: 'i(ii)', fn: thunk('ni') },
	tI: { signature: 'i(iI)', fn: thunk('nI') },
	tF: { signature: 'i(iF)', fn: thunk('nF') },
	tJ: { signature: 'I(iI)', fn: thunk('nJ') }
};
const call = await wideInterpreter(wideImports);

// control: the i32 thunk through burrow's own createInterpreter (its host_call)
const { createInterpreter } = await import(`${dist}/interpret.js`);
const vm = await createInterpreter({ module: wasm3 });
const control = vm.load(new Uint8Array(wasmTools(controlWat)), {
	imports: { native: { ti: { signature: 'i(ii)', fn: (a: number, b: number) => native.ni!(a, b) } } }
});

interface Arm {
	name: string;
	run: (n: number) => number;
	n: number;
}
const arms: Arm[] = [];
for (const k of ['i', 'I', 'F', 'J'])
	for (const kind of ['empty', 'cross']) arms.push({ name: `${kind}_${k}`, run: (n) => call(`${kind}_${k}`, n), n: 400_000 });
for (const kind of ['empty', 'cross']) arms.push({ name: `control_${kind}_i`, run: (n) => control.call(`${kind}_i`, n) >>> 0, n: 400_000 });
const time = (f: () => number) => {
	const t = performance.now();
	f();
	return performance.now() - t;
};
const perIter = (a: Arm) => ((time(() => a.run(2 * a.n)) - time(() => a.run(a.n))) * 1e6) / a.n;
for (const a of arms) for (let i = 0; i < 3; i++) perIter(a);
const got = new Map(arms.map((a) => [a.name, [] as number[]]));
for (let r = 0; r < rounds; r++)
	for (let i = 0; i < arms.length; i++) {
		const a = arms[(i + r * 3) % arms.length]!;
		got.get(a.name)!.push(perIter(a));
	}
const pair = (label: string, cross: string, empty: string) => ({ label, ...summary(got.get(cross)!.map((v, i) => v - got.get(empty)![i]!)) });
const rows = [
	pair('i(ii) thunk, this rig host_call', 'cross_i', 'empty_i'),
	pair('i(iI) thunk (one i64 argument)', 'cross_I', 'empty_I'),
	pair('i(iF) thunk (one f64 argument)', 'cross_F', 'empty_F'),
	pair('I(iI) thunk (i64 argument and result)', 'cross_J', 'empty_J'),
	pair('i(ii) thunk, burrow host_call (control)', 'control_cross_i', 'control_empty_i')
];
console.log(JSON.stringify({ node: process.version, v8: process.versions.v8, rounds, unit: 'ns per crossing, cross loop less the same loop without the crossing', rows }, null, '\t'));
