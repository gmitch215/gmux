import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * What one crossing from wasm3 to a native function costs, measured three ways.
 *
 * - `iso <burrow dist> [rounds]`: an isolated thunk (import, burrow's host_call, JS glue, a V8 export that sets
 *   the stack pointer), per arity, as experiments/cut-model times it (loop with the crossing against the same loop without it,
 *   n and 2n, arms interleaved, paired rounds); also with an interpreted body between crossings that walks a
 *   footprint of guest memory, to test whether a crossing costs more when the caches are not empty
 * - `wat <out dir>`: writes the isolated guests and the native module as .wasm for the deployed worker
 * - `dbl <rungs dir> <rung label> <out.wasm>`: the rung's interpreted module with every thunk calling a same-shape
 *   dummy thunk first (needs wasm-tools)
 * - `marginal <rungs dir> <rung label> <dbl.wasm> <burrow dist> [rounds]`: the rung against its doubled copy in
 *   one process; the difference over the crossings is what one more crossing costs inside that run
 * - `fit <graph.json> <rungs.json> <iso.json | -> <run.json>...`: each rung's residual per crossing from the
 *   ladder's own runs (the ends price the interpreted and native instructions), the through-origin fit over
 *   the rungs with 1,000 or more crossings, and each rung's crossing mix priced with the isolated table
 *
 * Timed modes take no lock; the caller holds one around the whole command.
 */
const [mode = '', ...args] = process.argv.slice(2);
const wasmTools = (a: string[], input?: string) => execFileSync('wasm-tools', a, { input, maxBuffer: 1 << 28 });
const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]!;
const summary = (xs: number[]) => ({ median: median(xs), min: Math.min(...xs), max: Math.max(...xs), spread: (Math.max(...xs) - Math.min(...xs)) / median(xs) });

const params = (k: number) => Array.from({ length: k }, () => 'i32').join(' ');

/** one loop per arity that crosses and one that does not, each optionally followed by an interpreted body over `footprint` bytes */
export function isoWat(ks: number[], footprint: number, work: number) {
	const pages = Math.ceil((footprint + 65536) / 65536) + 1;
	const body = footprint
		? `(func $body (result i32)
		(local $j i32) (local $p i32) (local $s i32)
		(local.set $p (global.get $pos))
		(loop $l
			(local.set $p (i32.and (i32.add (local.get $p) (i32.const 4160)) (i32.const ${footprint - 4})))
			(i32.store (i32.add (local.get $p) (i32.const 65536)) (i32.add (i32.load (i32.add (local.get $p) (i32.const 65536))) (i32.const 1)))
			(local.set $s (i32.add (local.get $s) (local.get $p)))
			(local.set $j (i32.add (local.get $j) (i32.const 1)))
			(br_if $l (i32.lt_u (local.get $j) (i32.const ${work}))))
		(global.set $pos (local.get $p))
		(local.get $s))`
		: '';
	const call = footprint ? '(local.set $s (i32.add (local.get $s) (call $body)))' : '';
	const fns = ks.map(
		(k) => `
	(func (export "empty${k}") (param $n i32) (result i32)
		(local $i i32) (local $s i32)
		(loop $next
			(local.set $s (i32.add (local.get $s) (i32.const 1)))
			${call}
			(local.set $i (i32.add (local.get $i) (i32.const 1)))
			(br_if $next (i32.lt_u (local.get $i) (local.get $n))))
		(local.get $s))
	(func (export "cross${k}") (param $n i32) (result i32)
		(local $i i32) (local $s i32)
		(loop $next
			(local.set $s (call $t${k} (i32.const 1024)${' (local.get $s)'.repeat(k - 1)}))
			${call}
			(local.set $i (i32.add (local.get $i) (i32.const 1)))
			(br_if $next (i32.lt_u (local.get $i) (local.get $n))))
		(local.get $s))`
	);
	return `(module
	${ks.map((k) => `(import "native" "t${k}" (func $t${k} (param ${params(k)}) (result i32)))`).join('\n\t')}
	(memory ${pages})
	(global $pos (mut i32) (i32.const 0))
	${body}
	${fns.join('')}
)`;
}

/** the native side of every thunk: sets the stack pointer, adds one */
export const nopsWat = (max = 16) => `(module
	(global $sp (mut i32) (i32.const 0))
	${Array.from({ length: max }, (_, i) => i + 1)
		.map(
			(k) => `(func (export "n${k}") (param ${params(k)}) (result i32)
		(global.set $sp (local.get 0))
		${k > 1 ? '(i32.add (local.get 1) (i32.const 1))' : '(i32.const 1)'})`
		)
		.join('\n\t')}
)`;

const { createInterpreter } = mode === 'iso' || mode === 'marginal' ? await import(`${args[mode === 'iso' ? 0 : 3]}/interpret.js`) : ({} as never);
const wasm3 = (dist: string) => new WebAssembly.Module(readFileSync(`${dist}/vendor/wasm3.wasm`));

const time = (f: () => number) => {
	const t = performance.now();
	f();
	return performance.now() - t;
};

const ks = [2, 3, 5, 7];
const isoConfigs = [
	{ id: 'bare', footprint: 0, work: 0, n: 400_000 },
	...[16 << 10, 256 << 10, 4 << 20, 32 << 20].map((footprint) => ({ id: `body-${footprint >> 10}K`, footprint, work: 50, n: 50_000 }))
];
/** an isolated guest as bytes: read from ISO_WASM (written by `wat`, for a host without wasm-tools) or assembled */
const isoBytes = (id: string, wat: () => string) =>
	process.env.ISO_WASM ? readFileSync(join(process.env.ISO_WASM, `${id}.wasm`)) : wasmTools(['parse', '-o', '/dev/stdout'], wat());

/** what ladder.ts run hands wasm3 for a promoted function: a counter, a name lookup and rest arguments */
const ladderGlue = (native: Record<string, (...a: number[]) => number>, name: string, counter: { n: number }) => (...a: number[]) => {
	counter.n++;
	return native[`${name}`]!(...a);
};

// #region iso
if (mode === 'iso') {
	const [dist = '', roundsArg = '15'] = args;
	const rounds = Number(roundsArg);
	const wanted = process.env.ISO_CONFIGS?.split(',');
	const configs = isoConfigs.filter((c) => !wanted || wanted.includes(c.id));
	const armKs = process.env.ISO_KS ? process.env.ISO_KS.split(',').map(Number) : ks;
	const nops = new WebAssembly.Instance(new WebAssembly.Module(isoBytes('nops', nopsWat))).exports as Record<string, (...a: number[]) => number>;
	const counter = { n: 0 };
	interface Arm {
		config: string;
		name: string;
		run: (n: number) => number;
		n: number;
	}
	const arms: Arm[] = [];
	for (const c of configs) {
		const vm = await createInterpreter({ module: wasm3(dist) });
		const imports = Object.fromEntries(ks.map((k) => [`t${k}`, { signature: `i(${'i'.repeat(k)})`, fn: ladderGlue(nops, `n${k}`, counter) }]));
		const guest = vm.load(new Uint8Array(isoBytes(c.id, () => isoWat(ks, c.footprint, c.work))), { imports: { native: imports } });
		for (const k of armKs) for (const kind of ['empty', 'cross']) arms.push({ config: c.id, name: `${kind}${k}`, run: (n) => guest.call(`${kind}${k}`, n) >>> 0, n: Number(process.env.ISO_N ?? c.n) });
	}
	const perIter = (a: Arm) => ((time(() => a.run(2 * a.n)) - time(() => a.run(a.n))) * 1e6) / a.n;
	for (const a of arms) for (let i = 0; i < 3; i++) perIter(a);
	const got = new Map(arms.map((a) => [`${a.config}/${a.name}`, [] as number[]]));
	for (let r = 0; r < rounds; r++)
		for (let i = 0; i < arms.length; i++) {
			const a = arms[(i + r * 3) % arms.length]!;
			got.get(`${a.config}/${a.name}`)!.push(perIter(a));
		}
	const rows = configs.flatMap((c) =>
		armKs.map((k) => {
			const x = got.get(`${c.id}/cross${k}`)!;
			const e = got.get(`${c.id}/empty${k}`)!;
			return { config: c.id, footprint: c.footprint, arity: k, ...summary(x.map((v, i) => v - e[i]!)), empty: median(e) };
		})
	);
	console.log(JSON.stringify({ node: process.version, v8: process.versions.v8, rounds, unit: 'ns per crossing, cross loop less the same loop without the crossing', rows }, null, '\t'));
}
// #endregion

// #region wat
if (mode === 'wat') {
	const [out = ''] = args;
	for (const c of isoConfigs) writeFileSync(join(out, `${c.id}.wasm`), wasmTools(['parse', '-o', '/dev/stdout'], isoWat(ks, c.footprint, c.work)));
	writeFileSync(join(out, 'nops.wasm'), wasmTools(['parse', '-o', '/dev/stdout'], nopsWat()));
}
// #endregion

// #region dbl
if (mode === 'dbl') {
	const [dir = '', label = '', out = ''] = args;
	const { rungs } = JSON.parse(readFileSync(join(dir, 'rungs.json'), 'utf8')) as { rungs: { rung: number; label: string; imports: Record<string, string> }[] };
	const rung = rungs.find((r) => r.label === label);
	if (!rung) throw new Error(`no rung labelled ${label}`);
	const lines = wasmTools(['print', join(dir, `rung${rung.rung}.interp.wasm`)]).toString().split('\n');
	const names = Object.keys(rung.imports);
	const at = lines.findLastIndex((l) => /^\s*\(import "native" /.test(l));
	const dummies = names.map((n) => lines.find((l) => l.includes(`"native" "${n}"`))!.replace(`"native" "${n}"`, `"native" "dummy_${n}"`).replace(`$nat_${n}`, `$dummy_${n}`));
	const result: string[] = [];
	for (let i = 0; i < lines.length; i++) {
		result.push(lines[i]!);
		if (i === at) result.push(...dummies);
	}
	// a thunk is the pushes of its arguments and one call; the doubled one pushes them and calls the dummy first
	const out2: string[] = [];
	for (let i = 0; i < result.length; i++) {
		const m = /^(\s*)call \$nat_(\S+)$/.exec(result[i]!);
		if (!m) {
			out2.push(result[i]!);
			continue;
		}
		let start = out2.length;
		while (start > 0 && /^\s*(global\.get \$__stack_pointer|local\.get \d+)$/.test(out2[start - 1]!)) start--;
		const pushes = out2.slice(start);
		const returns = rung.imports[m[2]!]![0] !== 'v';
		out2.push(...pushes, `${m[1]}call $dummy_${m[2]}`, ...(returns ? [`${m[1]}drop`] : []), result[i]!);
	}
	writeFileSync(out, wasmTools(['parse', '-o', '/dev/stdout'], out2.join('\n')));
}
// #endregion

// #region marginal
if (mode === 'marginal') {
	const [dir = '', label = '', dbl = '', dist = '', roundsArg = '7'] = args;
	const rounds = Number(roundsArg);
	const { rungs } = JSON.parse(readFileSync(join(dir, 'rungs.json'), 'utf8')) as { rungs: { rung: number; label: string; imports: Record<string, string> }[] };
	const rung = rungs.find((r) => r.label === label)!;
	const n = Number(process.env.N ?? 2);
	const nops = new WebAssembly.Instance(new WebAssembly.Module(isoBytes('nops', nopsWat))).exports as Record<string, (...a: number[]) => number>;
	const arm = async (interp: Uint8Array, dummy: boolean) => {
		const vm = await createInterpreter({ module: wasm3(dist) });
		const counter = { n: 0 };
		let native: Record<string, (...a: number[]) => number> = {};
		const imports: Record<string, { signature: string; fn: (...a: number[]) => number }> = {};
		for (const [name, signature] of Object.entries(rung.imports)) {
			imports[name] = { signature, fn: (...a) => (counter.n++, native[`f_${name}`]!(...a)) };
			// DUP=real makes the added crossing call the real function again (only for a function that is safe to call twice)
			if (dummy) imports[`dummy_${name}`] = process.env.DUP === 'real' ? { signature, fn: (...a) => (counter.n++, native[`f_${name}`]!(...a)) } : { signature, fn: ladderGlue(nops, `n${signature.length - 3}`, counter) };
		}
		const guest = vm.load(interp, { imports: { native: imports } });
		const memory = (vm as unknown as { shim: { memory: WebAssembly.Memory } }).shim.memory;
		const base = new WebAssembly.Global({ value: 'i32', mutable: false }, guest.memory().byteOffset);
		native = new WebAssembly.Instance(new WebAssembly.Module(readFileSync(join(dir, `rung${rung.rung}.native.wasm`))), { env: { memory, base } }).exports as typeof native;
		return { guest, counter };
	};
	const plain = await arm(new Uint8Array(readFileSync(join(dir, `rung${rung.rung}.interp.wasm`))), false);
	const doubled = await arm(new Uint8Array(readFileSync(dbl)), true);
	const one = (a: { guest: { call: (f: string, n: number) => number }; counter: { n: number } }) => {
		a.counter.n = 0;
		const t1 = time(() => a.guest.call('run', n));
		const c1 = a.counter.n;
		const t2 = time(() => a.guest.call('run', 2 * n));
		return { ms: t2 - t1, crossings: (a.counter.n - 2 * c1) / n };
	};
	for (let i = 0; i < 2; i++) (one(plain), one(doubled));
	const rows: { plain: number; doubled: number; crossings: number; doubledCrossings: number }[] = [];
	for (let r = 0; r < rounds; r++) {
		const first = r % 2 ? doubled : plain;
		const second = r % 2 ? plain : doubled;
		const a = one(first);
		const b = one(second);
		const [p, d] = r % 2 ? [b, a] : [a, b];
		rows.push({ plain: p.ms / n, doubled: d.ms / n, crossings: p.crossings, doubledCrossings: d.crossings });
	}
	if (plain.guest.call('run', 2) !== doubled.guest.call('run', 2)) throw new Error('the doubled module answers differently');
	const marginal = rows.map((x) => ((x.doubled - x.plain) * 1e6) / x.crossings);
	console.log(JSON.stringify({ node: process.version, v8: process.versions.v8, label, n, rounds, unit: 'ns per added crossing, (doubled - plain) ms per unit over crossings per unit', crossingsPerUnit: median(rows.map((x) => x.crossings)), plainMs: summary(rows.map((x) => x.plain)), doubledMs: summary(rows.map((x) => x.doubled)), marginal: summary(marginal), rows }, null, '\t'));
}
// #endregion

// #region fit
if (mode === 'fit') {
	const [graphPath = '', rungsPath = '', isoPath = '-', ...runPaths] = args;
	const graph = JSON.parse(readFileSync(graphPath, 'utf8')) as { nodes: { name: string; params: number; result: boolean }[]; edges: { from: string; to: string; count: number }[] };
	const { total, rungs } = JSON.parse(readFileSync(rungsPath, 'utf8')) as { total: number; rungs: { rung: number; label: string; share: number; promoted: string[] }[] };
	const iso = isoPath === '-' ? null : (JSON.parse(readFileSync(isoPath, 'utf8')) as { rows: { config: string; arity: number; median: number }[] });
	const runs = runPaths.map((p) => JSON.parse(readFileSync(p, 'utf8')) as { n: number; rows: { rung: number; label: string; ms: number; crossings: number }[] });
	const by = new Map(graph.nodes.map((v) => [v.name, v]));
	const isoNs = (arity: number) => iso?.rows.filter((r) => r.config === 'bare' && r.arity === arity)[0]?.median;
	const lines: string[] = ['| rung | label | crossings a unit | all-interpreted ms a unit | residual ms a unit | residual per crossing ns (each repeat) | crossing mix (args incl. sp: count) | isolated price of the mix ns |', '| --- | --- | --- | --- | --- | --- | --- | --- |'];
	const points: { residual: number; crossings: number }[][] = runs.map(() => []);
	for (const r of rungs) {
		const set = new Set(r.promoted);
		const mix = new Map<number, number>();
		for (const e of graph.edges) if (set.has(e.to) && !set.has(e.from) && e.count > 0) mix.set(by.get(e.to)!.params + 1, (mix.get(by.get(e.to)!.params + 1) ?? 0) + e.count);
		const sum = [...mix.values()].reduce((s, v) => s + v, 0);
		const priced = [...mix].map(([k, c]) => (isoNs(k) === undefined ? NaN : isoNs(k)! * c));
		const price = sum ? priced.reduce((s, v) => s + v, 0) / sum : NaN;
		const per = runs.map((run, i) => {
			const row = run.rows.find((x) => x.rung === r.rung)!;
			const sI = run.rows[0]!.ms / run.n / 1e3 / total;
			const sN = run.rows.at(-1)!.ms / run.n / 1e3 / total;
			const nat = r.share * total;
			const resid = row.ms / run.n - (nat * sN + (total - nat) * sI) * 1e3;
			const x = row.crossings / run.n;
			if (x >= 1000) points[i]!.push({ residual: resid, crossings: x });
			return { resid, x };
		});
		const x = median(per.map((p) => p.x));
		lines.push(
			`| ${r.rung} | ${r.label} | ${x.toFixed(0)} | ${median(runs.map((run) => run.rows[0]!.ms / run.n)).toFixed(2)} | ${median(per.map((p) => p.resid)).toFixed(3)} | ${x >= 1 ? per.map((p) => ((p.resid * 1e6) / p.x).toFixed(0)).join(' / ') : 'n/a'} | ${[...mix].map(([k, c]) => `${k}:${c}`).join(' ') || '-'} | ${Number.isNaN(price) ? '-' : price.toFixed(1)} |`
		);
	}
	console.log(lines.join('\n'));
	const fits = points.map((pts) => (pts.length ? (pts.reduce((s, f) => s + f.residual * f.crossings, 0) / pts.reduce((s, f) => s + f.crossings ** 2, 0)) * 1e6 : NaN));
	console.log(`\nthrough-origin fit over the rungs with 1,000 or more crossings a unit, per repeat (ns): ${fits.map((f) => f.toFixed(1)).join(' / ')}; points per repeat ${points.map((p) => p.length).join(' / ')}`);
}
// #endregion
