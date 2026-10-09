import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { loadavg } from 'node:os';
import { join } from 'node:path';
import { countInsns } from './insn.ts';

/**
 * What the promotion ladder's all-native module costs against the guest it was made from, with no interpreter in the
 * way: the rebased module adds `$gbase` to every load and store address and a temporary to every store.
 *
 * - `assemble <out dir> <guest.wasm> <ladder rungs dir>` (needs wasm-tools): copies the guest, takes the ladder's all-native
 *   module as `rebased.wasm` (plus a `d_run` export that skips the stack-pointer entry) and derives `zero.wasm` (`$gbase` a
 *   defined constant 0), `const0.wasm` (the global's reads replaced by a constant) and `offset.wasm` (the base in the offsets)
 * - `sample <dir> <rounds> [out.json]`: one paired round per variant per round (run(2n) less run(n), variants rotated),
 *   after three warm-up calls; the caller holds the lock and the quiet reading
 * - `code <dir> <variant> <function index> <function name>`: V8's optimising-tier machine code for one function,
 *   as byte and instruction counts (loads, stores, adds, leas: see `insn.ts`, one counter for arm64 and x86-64)
 *
 * Variants: orig (the guest), rebased (the all-native module over a memory holding the guest's image at an unaligned base,
 * entered with the stack pointer as an argument), rebased-direct (the same, entered at `run` itself), imp0 (the same code with
 * `$gbase` an imported 0 and the image at 0, so V8 cannot fold it), zero (`$gbase` an immutable global of constant 0 in the
 * module), const0 (every `global.get $gbase` replaced by `i32.const 0`, so the address add is the constant 0 operand),
 * offset (the base added to each access's offset immediate instead of to its address; image at the base like rebased).
 */
const [mode = '', ...args] = process.argv.slice(2);
const wasmTools = (a: string[], input?: string) => execFileSync('wasm-tools', a, { input, maxBuffer: 1 << 28 });
const BASE = 16_869_112;

if (mode === 'assemble') {
	const [out = '', guest = '', rungs = ''] = args;
	mkdirSync(out, { recursive: true });
	const manifest = JSON.parse(readFileSync(join(rungs, 'rungs.json'), 'utf8')) as { rungs: { rung: number; label: string }[] };
	const last = manifest.rungs.at(-1)!;
	if (last.label !== 'native') throw new Error(`the last rung is ${last.label}, not native`);
	copyFileSync(guest, join(out, 'guest.wasm'));
	writeFileSync(join(out, 'image.bin'), new Uint8Array((new WebAssembly.Instance(new WebAssembly.Module(readFileSync(guest))).exports.memory as WebAssembly.Memory).buffer));
	const text = wasmTools(['print', join(rungs, `rung${last.rung}.native.wasm`)]).toString();
	if (!/\(func \$run /.test(text)) throw new Error('no $run in the native module');
	const withExport = text.replace(/\n\)\s*$/, '\n  (export "d_run" (func $run))\n)\n');
	writeFileSync(join(out, 'rebased.wasm'), wasmTools(['parse', '-o', '/dev/stdout'], withExport));
	const imp = /\(import "env" "base" \(global \$gbase[^\n]*\)\)/;
	if (!imp.test(withExport)) throw new Error('no imported $gbase to replace');
	writeFileSync(join(out, 'zero.wasm'), wasmTools(['parse', '-o', '/dev/stdout'], withExport.replace(imp, '(global $gbase i32 (i32.const 0))')));
	const folded = withExport.replace(imp, '').replace(/global\.get \$gbase/g, 'i32.const 0');
	if (/\$gbase/.test(folded)) throw new Error('$gbase still used after folding');
	writeFileSync(join(out, 'const0.wasm'), wasmTools(['parse', '-o', '/dev/stdout'], folded));
	// the base moved into each access's offset immediate (a constant, so it is only valid at that base)
	let moved = 0;
	const inOffset = withExport.replace(/global\.get \$gbase\n\s*i32\.add\n((?:\s*local\.get \$tv_\w+\n)?\s*(?:i32|i64|f32|f64)\.(?:load|store)\w*)(?: offset=(\d+))?/g, (_m, op: string, k?: string) => {
		moved++;
		return `${op} offset=${BASE + Number(k ?? 0)}`;
	});
	const reads = withExport.match(/global\.get \$gbase/g)?.length ?? 0;
	if (moved !== reads) throw new Error(`${reads} base reads, ${moved} followed by an access`);
	writeFileSync(join(out, 'offset.wasm'), wasmTools(['parse', '-o', '/dev/stdout'], inOffset.replace(imp, '')));
}

const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]!;
type Run = (n: number) => number;

/** every variant over its own copy of the guest's pristine memory */
function variants(dir: string, only?: string) {
	const guest = () => new WebAssembly.Module(readFileSync(join(dir, 'guest.wasm')));
	// a variant other than orig reads the image from a file, so the guest is not compiled beside it (the code count would print both)
	const image = only && only !== 'orig' ? new Uint8Array(readFileSync(join(dir, 'image.bin'))) : new Uint8Array((new WebAssembly.Instance(guest()).exports.memory as WebAssembly.Memory).buffer).slice();
	const sp = 65536;
	const memoryAt = (base: number) => {
		const memory = new WebAssembly.Memory({ initial: Math.ceil((base + image.length) / 65536) + 1 });
		new Uint8Array(memory.buffer).set(image, base);
		return memory;
	};
	let rebasedModule: WebAssembly.Module | undefined;
	const rebased = () => (rebasedModule ??= new WebAssembly.Module(readFileSync(join(dir, 'rebased.wasm'))));
	const zero = () => new WebAssembly.Module(readFileSync(join(dir, 'zero.wasm')));
	const const0 = () => new WebAssembly.Module(readFileSync(join(dir, 'const0.wasm')));
	const offset = () => new WebAssembly.Module(readFileSync(join(dir, 'offset.wasm')));
	const base = (v: number) => new WebAssembly.Global({ value: 'i32', mutable: false }, v);
	type Exports = Record<string, (...a: number[]) => number>;
	const make = {
		orig: () => {
			const o = new WebAssembly.Instance(guest()).exports as Exports;
			return (n: number) => o.run!(n);
		},
		rebased: () => {
			const a = new WebAssembly.Instance(rebased(), { env: { memory: memoryAt(BASE), base: base(BASE) } }).exports as Exports;
			return (n: number) => a.f_run!(sp, n);
		},
		"rebased-direct": () => {
			const b = new WebAssembly.Instance(rebased(), { env: { memory: memoryAt(BASE), base: base(BASE) } }).exports as Exports;
			return (n: number) => b.d_run!(n);
		},
		imp0: () => {
			const c = new WebAssembly.Instance(rebased(), { env: { memory: memoryAt(0), base: base(0) } }).exports as Exports;
			return (n: number) => c.f_run!(sp, n);
		},
		zero: () => {
			const d = new WebAssembly.Instance(zero(), { env: { memory: memoryAt(0) } }).exports as Exports;
			return (n: number) => d.f_run!(sp, n);
		},
		const0: () => {
			const e = new WebAssembly.Instance(const0(), { env: { memory: memoryAt(0) } }).exports as Exports;
			return (n: number) => e.f_run!(sp, n);
		},
		offset: () => {
			const f = new WebAssembly.Instance(offset(), { env: { memory: memoryAt(BASE) } }).exports as Exports;
			return (n: number) => f.f_run!(sp, n);
		}
	};
	return Object.entries(make)
		.filter(([name]) => !only || name === only)
		.map(([name, f]) => ({ name, run: f() as Run }));
}

if (mode === 'sample') {
	const [dir = '', roundsArg = '5', out = ''] = args;
	const rounds = Number(roundsArg);
	const n = Number(process.env.N ?? 2);
	const list = variants(dir);
	const want = list[0]!.run(2) >>> 0;
	for (const v of list) if ((v.run(2) >>> 0) !== want) throw new Error(`${v.name}: run(2) answered ${(v.run(2) >>> 0).toString(16)}, the guest ${want.toString(16)}`);
	const time = (f: () => number) => {
		const t = performance.now();
		f();
		return performance.now() - t;
	};
	const ms = (v: { run: Run }) => time(() => v.run(2 * n)) - time(() => v.run(n));
	for (const v of list) for (let i = 0; i < 3; i++) ms(v);
	const got = new Map(list.map((v) => [v.name, [] as number[]]));
	const loadBefore = loadavg()[0];
	for (let r = 0; r < rounds; r++) for (let i = 0; i < list.length; i++) got.get(list[(i + r) % list.length]!.name)!.push(ms(list[(i + r) % list.length]!));
	const rows = list.map((v) => ({ variant: v.name, ms: median(got.get(v.name)!), rounds: got.get(v.name)!, ratioToOrig: median(got.get(v.name)!) / median(got.get('orig')!) }));
	const result = { node: process.version, v8: process.versions.v8, n, rounds, checksum: want, loadBefore, loadAfter: loadavg()[0], rows };
	if (out) writeFileSync(out, JSON.stringify(result, null, '\t'));
	else console.log(JSON.stringify(result, null, '\t'));
}

if (mode === 'code') {
	const [dir = '', variant = '', index = '', name = ''] = args;
	if (process.env.PART0_CHILD !== '1') {
		const flags = ['--no-liftoff', '--no-wasm-lazy-compilation', '--print-wasm-code', `--print-wasm-code-function-index=${index}`];
		const text = execFileSync(process.execPath, [...flags, '--no-warnings', '--experimental-strip-types', new URL(import.meta.url).pathname, 'code', dir, variant, index, name], { env: { ...process.env, PART0_CHILD: '1' }, maxBuffer: 1 << 28 }).toString();
		// the flag prints every function it compiles, node's own type stripper's module included (unnamed, compiled before
		// this script runs); the variant's functions print under their names
		const block = text.split(/^name: /m).findLast((b) => b.startsWith(`${name}\n`)) ?? '';
		const lines = block.split('\n');
		const arch = process.arch === 'arm64' ? 'arm64' : 'x64';
		const size = block.match(/Instructions \(size = (\d+)\)/)?.[1];
		const compiler = block.match(/compiler: (\w+)/)?.[1];
		console.log(JSON.stringify({ variant, function: name, index: Number(index), compiler, arch, bytes: Number(size), ...countInsns(lines, arch) }));
	} else {
		variants(dir, variant)[0]!.run(1);
	}
}
