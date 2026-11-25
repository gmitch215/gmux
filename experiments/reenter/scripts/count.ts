import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { dispatchWat, entriesOf, linkRung, type Rung } from './link.ts';
import { createVm, memoryLimits } from './vm.ts';

/**
 * Counted crossings for one rung, untimed. A down site is an interpreted caller's call of a promoted function, an up site a
 * promoted caller's call of an interpreted one. Each (caller, callee) pair gets one counter bumped at its call sites; the
 * interpreted module answers its counters through an exported `cnt(i)`, the native module exports them as globals.
 *
 * - `instrument <rungs dir> <rung>` (needs wasm-tools): writes rung<k>.{interp,native}.counted.{wat,wasm}
 * - `run <rungs dir> <rung> <wasm3.wasm> <graph.json>`: runs the counted pair direct against V8's checksum, and compares each
 *   crossing pair's count per unit (run(n) divided by n, N env, default 1) with the graph's count for the pair. A crossing
 *   the graph has but no site covers, or a site with no crossing, is a mismatch.
 */
type Pair = { caller: string; callee: string };
type Rec = Rung & { label: string; promoted: string[] };
const [mode = '', dirArg = '', kArg = '', wasm3 = '', graphPath = ''] = process.argv.slice(2);
const wasmTools = (args: string[], input?: string) => execFileSync('wasm-tools', args, { input, maxBuffer: 1 << 28 });
const manifest = (dir: string) => JSON.parse(readFileSync(join(dir, 'rungs.json'), 'utf8')) as { total: number; rungs: Rec[] };
const fnName = (line: string) => line.match(/^ {2}\(func \$(\S+)/)?.[1];
const callee = (line: string) => line.match(/^\s*call \$(\S+)\s*$/)?.[1];
const ident = (p: Pair) => `c_${p.caller}__${p.callee}`.replace(/[^A-Za-z0-9_]/g, '_');

/** the call sites of one side that cross the rung's set, unique by (caller, callee), in order of appearance */
function sites(wat: string, rung: Rec, down: boolean): Pair[] {
	const thunks = new Set(Object.keys(rung.imports));
	const promoted = new Set(rung.promoted);
	const cold = new Set(rung.cold ?? []);
	const seen = new Map<string, Pair>();
	let current = '';
	for (const line of wat.split('\n')) {
		current = fnName(line) ?? current;
		const c = callee(line);
		if (!c || !current) continue;
		const crosses = down ? thunks.has(c) && !promoted.has(current) : cold.has(c) && promoted.has(current);
		if (crosses) seen.set(`${current}>${c}`, { caller: current, callee: c });
	}
	return [...seen.values()];
}

/** a global per pair, bumped before each of its call sites */
function instrument(wat: string, pairs: Pair[], exported: boolean) {
	const keys = new Set(pairs.map((p) => `${p.caller}>${p.callee}`));
	const out: string[] = [];
	let current = '';
	for (const line of wat.split('\n')) {
		current = fnName(line) ?? current;
		const c = callee(line);
		if (c && keys.has(`${current}>${c}`)) {
			const g = ident({ caller: current, callee: c });
			out.push(`    global.get $${g}`, '    i32.const 1', '    i32.add', `    global.set $${g}`);
		}
		out.push(line);
	}
	const globals = pairs.map((p) => `  (global $${ident(p)} ${exported ? `(export "${ident(p)}") ` : ''}(mut i32) (i32.const 0))`);
	// globals follow the imports, so they go ahead of the first function
	const at = out.findIndex((l) => /^ {2}\(func\b/.test(l));
	out.splice(at, 0, ...globals);
	return out;
}

if (mode === 'instrument') {
	const dir = dirArg;
	const k = Number(kArg);
	const rung = manifest(dir).rungs.find((r) => r.rung === k)!;
	const interpWat = wasmTools(['print', join(dir, `rung${k}.interp.wasm`)]).toString();
	const nativeWat = wasmTools(['print', join(dir, `rung${k}.native.wasm`)]).toString();
	const down = sites(interpWat, rung, true);
	const up = sites(nativeWat, rung, false);
	const interpLines = instrument(interpWat, down, false);
	// cnt(i) answers counter i in the order `run` reads the pairs back, or -1
	const getter = [
		'  (func (export "cnt") (param $i i32) (result i32)',
		...down.map((p, i) => `    (if (i32.eq (local.get $i) (i32.const ${i})) (then (return (global.get $${ident(p)}))))`),
		'    (i32.const -1))'
	];
	interpLines.splice(interpLines.lastIndexOf(')'), 0, ...getter);
	const nativeLines = instrument(nativeWat, up, true);
	writeFileSync(join(dir, `rung${k}.interp.counted.wat`), interpLines.join('\n'));
	writeFileSync(join(dir, `rung${k}.native.counted.wat`), nativeLines.join('\n'));
	writeFileSync(join(dir, `rung${k}.interp.counted.wasm`), wasmTools(['parse', '-o', '/dev/stdout'], interpLines.join('\n')));
	writeFileSync(join(dir, `rung${k}.native.counted.wasm`), wasmTools(['parse', '-o', '/dev/stdout'], nativeLines.join('\n')));
	console.log(JSON.stringify({ rung: k, down: down.length, up: up.length }));
}

if (mode === 'run') {
	const dir = dirArg;
	const k = Number(kArg);
	const rung = manifest(dir).rungs.find((r) => r.rung === k)!;
	const graph = JSON.parse(readFileSync(graphPath, 'utf8')) as { edges: { from: string; to: string; count: number }[] };
	const S = new Set(rung.promoted);
	const crossing = (p: Pair) => (!S.has(p.caller) && S.has(p.callee) ? 'down' : S.has(p.caller) && !S.has(p.callee) ? 'up' : '');
	const interpWat = readFileSync(join(dir, `rung${k}.interp.counted.wat`), 'utf8');
	const nativeWat = readFileSync(join(dir, `rung${k}.native.counted.wat`), 'utf8');
	const down = sites(interpWat, rung, true);
	const up = sites(nativeWat, rung, false);
	const dispatcher = new Uint8Array(wasmTools(['parse', '-o', '/dev/stdout'], dispatchWat(entriesOf(rung), true)));
	const table = new WebAssembly.Table({ element: 'anyfunc', initial: entriesOf(rung).length });
	const dispatch = new WebAssembly.Instance(new WebAssembly.Module(dispatcher), { env: { table } });
	const vm = await createVm(wasm3, {
		guest: memoryLimits(new Uint8Array(readFileSync(join(dir, 'guest.wasm')))),
		hostDirect: dispatch.exports.host_direct as (...a: number[]) => number,
		hostWide: dispatch.exports.host_wide as ((...a: number[]) => number) | undefined
	});
	const linked = linkRung(vm, dir, rung, { direct: { table }, suffix: 'counted' });
	const read = () => ({
		down: down.map((_, i) => Number(linked.guest.call('cnt', i))),
		up: up.map((p) => Number((linked.native[ident(p)] as WebAssembly.Global).value))
	});
	const n = Number(process.env.N ?? 1);
	const ref = new WebAssembly.Instance(new WebAssembly.Module(readFileSync(join(dir, 'guest.wasm')))).exports as Record<string, (x: number) => number>;
	const want = ref.run!(n) >>> 0;
	const before = read();
	const got = linked.guest.call('run', n) >>> 0;
	const after = read();
	if (got !== want) throw new Error(`rung ${k}: run(${n}) answered ${got.toString(16)} against v8 ${want.toString(16)}`);
	const pairs = [
		...down.map((p, i) => ({ p, counted: (after.down[i]! - before.down[i]!) / n })),
		...up.map((p, i) => ({ p, counted: (after.up[i]! - before.up[i]!) / n }))
	];
	const rows = pairs.map(({ p, counted }) => {
		const edge = graph.edges.find((e) => e.from === p.caller && e.to === p.callee);
		const predicted = edge?.count ?? 0;
		return { edge: `${p.caller}>${p.callee}`, side: crossing(p) || 'none', counted, predicted, ok: counted === predicted && crossing(p) !== '' };
	});
	const covered = new Set(pairs.map(({ p }) => `${p.caller}>${p.callee}`));
	const missing = graph.edges.filter((e) => crossing(e) && !covered.has(`${e.from}>${e.to}`)).map((e) => `${e.from}>${e.to} ${e.count}`);
	const mismatched = rows.filter((r) => !r.ok).length + missing.length;
	console.log(JSON.stringify({ rung: k, label: rung.label, n, checksum: want, sites: rows.length, mismatched, missing, rows }, null, '\t'));
}
