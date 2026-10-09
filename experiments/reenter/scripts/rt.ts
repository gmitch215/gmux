import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { loadavg } from 'node:os';
import { join } from 'node:path';
import { isoWat, nopsWat } from '../../promotion-cut/scripts/tau.ts';
import { dispatchWat } from './link.ts';
import { createVm, type Vm } from './vm.ts';

/**
 * The crossing priced without JavaScript, per direction and arity (parameters including the stack pointer).
 *
 * - `assemble <out dir>` (needs wasm-tools): writes the isolated guests, the native loops, the dispatcher and the nop
 *   functions as .wasm, so a host without wasm-tools can time
 * - `sample <wasm dir> <re-entry wasm3.wasm> <default wasm3.wasm> <round> [out.json]`: one paired round of every arm, as
 *   experiments/promotion-cut/scripts/tau.ts iso times it (a loop with the crossing against the same loop without it, n
 *   and 2n, arms interleaved, three warm-up calls first); the caller holds the lock and the quiet reading
 *
 * Down is interpreted code calling a native function: glued-default is the committed interpreter and burrow's own glue,
 * glued-patched the re-entry build with the same glue, pure the re-entry build with host_direct answered by a dispatcher
 * module (a br_table on the id). Up is native code calling an interpreted function: glued through a JavaScript function
 * around burrow_call_at, pure by importing the interpreter's burrow_call_at export.
 */
const ks = [2, 3, 5, 7];
const [mode = '', ...args] = process.argv.slice(2);
const wasmTools = (a: string[], input?: string) => execFileSync('wasm-tools', a, { input, maxBuffer: 1 << 28 });
const params = (k: number) => Array.from({ length: k }, () => 'i32').join(' ');

/** native loops: `up<k>` calls the interpreter through call_at with a function handle, `empty<k>` is the same loop without the call */
export function upWat(arities: number[]) {
	const fns = arities.map((k) => {
		const zeros = Array.from({ length: 8 - k }, () => '(i32.const 0)').join(' ');
		return `
	(func (export "empty${k}") (param $n i32) (param $h i32) (result i32)
		(local $i i32) (local $s i32)
		(loop $next
			(local.set $s (i32.add (local.get $s) (i32.const 1)))
			(local.set $i (i32.add (local.get $i) (i32.const 1)))
			(br_if $next (i32.lt_u (local.get $i) (local.get $n))))
		(local.get $s))
	(func (export "up${k}") (param $n i32) (param $h i32) (result i32)
		(local $i i32) (local $s i32)
		(loop $next
			(local.set $s (call $ca (local.get $h) (i32.const 1024)${' (local.get $s)'.repeat(k - 1)} ${zeros}))
			(local.set $i (i32.add (local.get $i) (i32.const 1)))
			(br_if $next (i32.lt_u (local.get $i) (local.get $n))))
		(local.get $s))`;
	});
	return `(module
	(import "i" "call_at" (func $ca (param i32 i32 i32 i32 i32 i32 i32 i32 i32) (result i32)))
	${fns.join('')}
)`;
}

/** the interpreted side of an up crossing: the same nop the native side has for a down crossing */
export const ieWat = (arities: number[]) => `(module
	(global $sp (mut i32) (i32.const 0))
	${arities.map((k) => `(func (export "ie${k}") (param ${params(k)}) (result i32)
		(global.set $sp (local.get 0))
		${k > 1 ? '(i32.add (local.get 1) (i32.const 1))' : '(i32.const 1)'})`).join('\n\t')}
)`;

const files = {
	down: 'down.wasm',
	nops: 'nops.wasm',
	dispatch: 'dispatch.wasm',
	up: 'up.wasm',
	ie: 'ie.wasm'
};

if (mode === 'assemble') {
	const [out = ''] = args;
	mkdirSync(out, { recursive: true });
	const put = (name: string, wat: string) => writeFileSync(join(out, name), wasmTools(['parse', '-o', '/dev/stdout'], wat));
	put(files.down, isoWat(ks, 0, 0));
	put(files.nops, nopsWat());
	put(files.dispatch, dispatchWat(ks.map((k) => ({ arity: k, returns: true })), false));
	put(files.up, upWat(ks));
	put(files.ie, ieWat(ks));
}

interface Arm {
	id: string;
	dir: 'down' | 'up';
	impl: string;
	k: number;
	kind: 'cross' | 'empty';
	run: (n: number) => number;
	n: number;
}

const time = (f: () => number) => {
	const t = performance.now();
	f();
	return performance.now() - t;
};

if (mode === 'sample') {
	const [dir = '', patched = '', plain = '', roundArg = '0', out = ''] = args;
	if (!dir || !patched || !plain) throw new Error('usage: rt.ts sample <wasm dir> <re-entry wasm3.wasm> <default wasm3.wasm> <round> [out.json]');
	const bytes = (name: string) => new Uint8Array(readFileSync(join(dir, name)));
	const mod = (name: string) => new WebAssembly.Module(bytes(name));
	const n = Number(process.env.RT_N ?? 1_000_000);
	const wanted = process.env.RT_KS ? process.env.RT_KS.split(',').map(Number) : ks;
	const only = process.env.RT_ARMS?.split(',');
	const nops = new WebAssembly.Instance(mod(files.nops)).exports as Record<string, (...a: number[]) => number>;
	const arms: Arm[] = [];
	const add = (dirName: 'down' | 'up', impl: string, k: number, run: (kind: string) => (n: number) => number) => {
		if (only && !only.includes(`${dirName}/${impl}`)) return;
		for (const kind of ['empty', 'cross'] as const) arms.push({ id: `${dirName}/${impl}/${kind}${k}`, dir: dirName, impl, k, kind, run: run(kind), n });
	};

	// down: an interpreted loop calling a native nop
	const downGuest = (vm: Vm, how: 'glued' | 'direct') =>
		how === 'glued'
			? vm.load(bytes(files.down), { glued: { native: Object.fromEntries(ks.map((k) => [`t${k}`, { signature: `i(${'i'.repeat(k)})`, fn: ((counter) => (...a: number[]) => (counter.n++, nops[`n${k}`]!(...a)))({ n: 0 }) }])) } })
			: vm.load(bytes(files.down), { direct: ks.map((k) => ({ module: 'native', field: `t${k}`, signature: `i(${'i'.repeat(k)})` })) });
	const vmDefault = await createVm(plain);
	const gDefault = downGuest(vmDefault, 'glued');
	const vmGlued = await createVm(patched);
	const gGlued = downGuest(vmGlued, 'glued');
	const dispatcher = new WebAssembly.Instance(mod(files.dispatch), { native: Object.fromEntries(ks.map((k, i) => [`f${i}`, nops[`n${k}`]])) });
	const vmPure = await createVm(patched, { hostDirect: dispatcher.exports.host_direct as (...a: number[]) => number });
	const gPure = downGuest(vmPure, 'direct');
	for (const k of wanted) {
		add('down', 'glued-default', k, (kind) => (c) => gDefault.call(`${kind}${k}`, c) >>> 0);
		add('down', 'glued-patched', k, (kind) => (c) => gGlued.call(`${kind}${k}`, c) >>> 0);
		add('down', 'pure', k, (kind) => (c) => gPure.call(`${kind}${k}`, c) >>> 0);
	}

	// up: a native loop calling an interpreted nop through burrow_call_at
	const vmUpGlued = await createVm(patched);
	const gUpGlued = vmUpGlued.load(bytes(files.ie));
	const upGlued = new WebAssembly.Instance(mod(files.up), { i: { call_at: (...a: number[]) => (vmUpGlued.shim.burrow_call_at as (...x: number[]) => number)(...a) } }).exports as Record<string, (n: number, h: number) => number>;
	const vmUpPure = await createVm(patched);
	const gUpPure = vmUpPure.load(bytes(files.ie));
	const upPure = new WebAssembly.Instance(mod(files.up), { i: { call_at: vmUpPure.shim.burrow_call_at as unknown as WebAssembly.ImportValue } }).exports as Record<string, (n: number, h: number) => number>;
	for (const k of wanted) {
		const hGlued = gUpGlued.handle(`ie${k}`);
		const hPure = gUpPure.handle(`ie${k}`);
		add('up', 'glued', k, (kind) => (c) => upGlued[`${kind === 'cross' ? 'up' : 'empty'}${k}`]!(c, hGlued) >>> 0);
		add('up', 'pure', k, (kind) => (c) => upPure[`${kind === 'cross' ? 'up' : 'empty'}${k}`]!(c, hPure) >>> 0);
	}

	// every loop adds one per iteration whether or not it crosses, so a thousand iterations must answer a thousand
	for (const a of arms) {
		const got1000 = a.run(1000);
		if (got1000 !== 1000) throw new Error(`${a.id}: run(1000) answered ${got1000}`);
	}
	const perIter = (a: Arm) => ((time(() => a.run(2 * a.n)) - time(() => a.run(a.n))) * 1e6) / a.n;
	for (const a of arms) for (let i = 0; i < 3; i++) perIter(a);
	const round = Number(roundArg);
	const got = new Map<string, number>();
	const t0 = loadavg()[0];
	for (let i = 0; i < arms.length; i++) {
		const a = arms[(i + round * 3) % arms.length]!;
		got.set(a.id, perIter(a));
	}
	const rows = arms
		.filter((a) => a.kind === 'cross')
		.map((a) => {
			const e = got.get(a.id.replace('/cross', '/empty'))!;
			const x = got.get(a.id)!;
			return { dir: a.dir, impl: a.impl, arity: a.k, ns: x - e, crossNs: x, emptyNs: e };
		});
	const result = { node: process.version, v8: process.versions.v8, round, n, loadBefore: t0, loadAfter: loadavg()[0], unit: 'ns per crossing, cross loop less the same loop without the crossing', rows };
	if (out) writeFileSync(out, JSON.stringify(result, null, '\t'));
	else console.log(JSON.stringify(result, null, '\t'));
}
