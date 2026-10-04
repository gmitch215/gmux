import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirhPoints, dirSavings, wsPoints } from './lookup.ts';
import { parse, solve, type Row } from './model.ts';

/**
 * The crossing table: what each Katybug crossing costs, from the guest microbenchmarks (`cross-kb.sh
 * table` and `cross-kb.sh ws`, one TSV a host arch each) and the JS and wasm crossings
 * (`cross-js.ts`), each with its spread. The table is written once and frozen; `predict.ts` reads it
 * and nothing here sees the sweep it predicts.
 *
 * Time is wall seconds (the sweep's CPU column has 10 ms steps). Features are in millions and time in
 * ms, so a coefficient reads in ns. Per arm, with F the empty guest's time:
 *
 * - block and op: the alu guest (one block a pass, work per block varies) and the tl guest (segments of
 *   work split by branches that never leave, ops fixed, so a trace holds more ops a block): model A is
 *   t - F = op ops + block blocks; model B adds q ops L, L the ops a block runs (an op that costs more
 *   in a long block). B is the table's block term when A leaves more than 3% on a point and B halves
 *   that, else A;
 * - the lookup: the ws guests hold B blocks and dispatch over H of them (`ws-gen.ts`). The `ind` guests
 *   (indirect jumps, so no block chains) price a whole dispatch, host branch misses included; a build
 *   without chaining saves only the lookup, so with `ws2` rows (the `dirh` guests, direct jumps) a lookup
 *   costs what chaining saves at (B, H), read at a program's blocks held and the blocks that make up
 *   its dispatches (`lookup.ts`); without them, the small-guest lookup plus what the working set adds
 *   to a dispatch over the 16 x 16 `ind` guest;
 * - the branch guest (a hot arm left 0..50% of passes, blocks near fixed): with block from the model
 *   and the small-guest lookup, t - F - block blocks - lookup lookups = op ops + exit exits;
 * - the mapping guest (one load in one mapping, or alternating between two): a miss is the time of
 *   the alternating run over the single-mapping run, per refill, at 0 and 32 extra mappings.
 *
 * A fifth argument `tl` takes the block term from the tl guests alone (model T: the fit pools two guest
 * families whose op costs differ, and leaves 4-10% on the tl guests themselves).
 *
 * `node --experimental-strip-types table.ts <run dir> <cross-js.json> <out.json> [refill counts.json [tl]]`
 * where the run dir holds `table/table-<arch>.tsv`, `ws/ws-<arch>.tsv`, `depth-<arch>.jsonl`,
 * `table/katybug-src.rev` and optionally `ws2/ws2-<arch>.tsv`.
 */
const [dir = '', jsPath = '', outPath = '', refillPath = '', blockPick = ''] = process.argv.slice(2);

interface Est {
	ns: number;
	se: number;
	min: number;
	max: number;
	n: number;
}

const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[xs.length >> 1]!;

/** least squares with standard errors; x in millions, y in ms */
function lsq(x: number[][], y: number[]) {
	const p = x[0]!.length;
	const coef = solve(x, y);
	const rss = y.reduce((s, v, i) => s + (v - x[i]!.reduce((t, xv, j) => t + xv * coef[j]!, 0)) ** 2, 0);
	const dof = Math.max(y.length - p, 1);
	const xtx = Array.from({ length: p }, (_, i) => Array.from({ length: p }, (_, j) => x.reduce((s, r) => s + r[i]! * r[j]!, 0)));
	const se = coef.map((_, i) => {
		const e = Array.from({ length: p }, (_, j) => (i === j ? 1 : 0));
		const inv = solve(xtx, e);
		return Math.sqrt((rss / dof) * Math.max(inv[i]!, 0));
	});
	return { coef, se, rel: y.map((v, i) => (x[i]!.reduce((t, xv, j) => t + xv * coef[j]!, 0) - v) / v) };
}

const est = (xs: Est[]): Est => ({
	ns: median(xs.map((e) => e.ns)),
	se: median(xs.map((e) => e.se)),
	min: Math.min(...xs.map((e) => e.ns)),
	max: Math.max(...xs.map((e) => e.ns)),
	n: xs.length
});
const single = (ns: number, se = 0): Est => ({ ns, se, min: ns, max: ns, n: 1 });
const maxAbs = (xs: number[]) => Math.max(...xs.map(Math.abs));

const traceArms = ['t2', 't4', 't8', 't16', 't32', 't64'];
const arms = ['base', 'chain', 'fuse', ...traceArms];
const M = 1e6;

function arch(rows: Row[], wsRows: Row[], ws2Rows: Row[], depth: unknown[], refills: Record<string, number>) {
	const at = (w: string, a: string) => {
		const r = rows.find((r) => r.workload === w && r.arm === a);
		if (!r) throw new Error(`no ${w} ${a}`);
		return r;
	};
	const ms = (r: Row) => r.wall * 1e3;
	const fixed = Object.fromEntries(arms.map((a) => [a, ms(at('null', a))]));
	const alu = ['a1', 'a4', 'a16', 'a64', 'a64x'];
	const tl = rows.filter((r) => /^tl\d+-\d+$/.test(r.workload) && r.arm === 'base').map((r) => r.workload);
	const grid = [...alu, ...tl];
	// per arm: model A (op, block) and model B (op, block, q ops L) over the alu and tl points
	const fit = (a: string) => {
		const g = grid.map((w) => at(w, a));
		const y = g.map((r) => ms(r) - fixed[a]!);
		const A = lsq(g.map((r) => [r.ops / M, r.blocks / M]), y);
		const B = lsq(g.map((r) => [r.ops / M, r.blocks / M, r.ops ** 2 / r.blocks / M]), y);
		return {
			A: { op: single(A.coef[0]!, A.se[0]!), block: single(A.coef[1]!, A.se[1]!), rel: A.rel, maxRel: maxAbs(A.rel) },
			B: { op: single(B.coef[0]!, B.se[0]!), block: single(B.coef[1]!, B.se[1]!), q: single(B.coef[2]!, B.se[2]!), rel: B.rel, maxRel: maxAbs(B.rel) }
		};
	};
	const perArm = Object.fromEntries(arms.map((a) => [a, fit(a)]));
	// model T: the tl guests alone, where ops are fixed and only the blocks a run takes change
	const tlFit = Object.fromEntries(
		arms.map((a) => {
			const g = tl.map((w) => at(w, a));
			const f = lsq(g.map((r) => [r.ops / M, r.blocks / M]), g.map((r) => ms(r) - fixed[a]!));
			return [a, { op: single(f.coef[0]!, f.se[0]!), block: single(f.coef[1]!, f.se[1]!), rel: f.rel, maxRel: maxAbs(f.rel) }];
		})
	);
	const chosen = blockPick === 'tl' ? 'T' : arms.every((a) => perArm[a]!.A.maxRel <= 0.03 || perArm[a]!.B.maxRel > perArm[a]!.A.maxRel / 2) ? 'A' : 'B';
	const blockModel = Object.fromEntries(
		arms.map((a) => {
			const f = perArm[a]!;
			if (chosen === 'T') return [a, { block: tlFit[a]!.block.ns, q: 0, opScale: tlFit[a]!.op.ns / tlFit.base!.op.ns }];
			return [a, chosen === 'A' ? { block: f.A.block.ns, q: 0 } : { block: f.B.block.ns, q: f.B.q.ns }];
		})
	);
	// the alu guest alone, as the 2026-09-29 table fitted it
	const aluOnly = Object.fromEntries(
		arms.map((a) => {
			const g = alu.map((w) => at(w, a));
			const f = lsq(g.map((r) => [r.ops / M, r.blocks / M]), g.map((r) => ms(r) - fixed[a]!));
			return [a, { op: single(f.coef[0]!, f.se[0]!), block: single(f.coef[1]!, f.se[1]!), rel: f.rel }];
		})
	);

	// the lookup over working sets
	const indPoints = wsPoints(wsRows, 'base');
	const chainPoints = wsPoints(wsRows, 'chain');
	const dir = dirSavings(wsRows);
	const small = dir.find((d) => d.B === 16);
	if (!small) throw new Error('no dir guest over 16 blocks');
	// with dirh rows (a second run) the lookup is what chaining saves at (B, H); else the ind curve
	const dirh = dirhPoints(ws2Rows);
	const lookup0 = dirh.find((p) => p.B === 16 && p.H === 16)?.ns ?? small.ns;
	const lookupWs = {
		lookup0,
		points: dirh.length ? dirh : indPoints,
		indPoints,
		chainPoints,
		dirSavingNs: dir,
		depth,
		spread: Object.fromEntries([...wsRows, ...ws2Rows].filter((r) => r.workload.endsWith('-31')).map((r) => [`${r.workload} ${r.arm}`, r.spread]))
	};

	const branch = ['b0', 'b32', 'b8', 'b4', 'b2'];
	const exitPerArm = Object.fromEntries(
		traceArms.map((a) => {
			const g = branch.map((w) => at(w, a));
			const f = lsq(
				g.map((r) => [r.ops / M, r.exits / M]),
				g.map((r) => ms(r) - fixed[a]! - (blockModel[a]!.block * r.blocks) / M - (blockModel[a]!.q * r.ops ** 2) / r.blocks / M - (lookup0 * r.lookups) / M)
			);
			return [a, { op: single(f.coef[0]!, f.se[0]!), exit: single(f.coef[1]!, f.se[1]!), rel: f.rel }];
		})
	);
	const exit = est(traceArms.map((a) => exitPerArm[a]!.exit));
	// the refill cost is per miss; counts come from the KB_COUNT build (refills a workload run)
	const miss = (hit: string, alt: string) =>
		est(arms.map((a) => single((ms(at(alt, a)) - ms(at(hit, a))) / ((refills[alt]! - refills[hit]!) / M))));
	const near = miss('m0', 'm1');
	const far = miss('m0x', 'm1x');
	return {
		fixedMs: fixed,
		blockModel: { chosen, byArm: blockModel, fits: perArm, tlOnly: tlFit, aluOnly, points: grid },
		lookupWs,
		branchFit: exitPerArm,
		exitNs: exit,
		exitNsByArm: Object.fromEntries(traceArms.map((a) => [a, exitPerArm[a]!.exit])),
		refillNs: { extra0: near, extra32: far, perExtraMapping: single((far.ns - near.ns) / 32) },
		spread: {
			layouts: Object.fromEntries(rows.filter((r) => r.workload !== 'null').map((r) => [`${r.workload} ${r.arm}`, r.spread]))
		}
	};
}

const refills: Record<string, number> = refillPath ? JSON.parse(readFileSync(refillPath, 'utf8')) : {};
const readDepth = (a: string) =>
	existsSync(`${dir}/depth-${a}.jsonl`)
		? readFileSync(`${dir}/depth-${a}.jsonl`, 'utf8')
				.trim()
				.split('\n')
				.map((l) => JSON.parse(l))
		: [];
const table: Record<string, unknown> = {
	kind: 'katybug crossing costs (ns)',
	source: { katybugSourceRev: readFileSync(`${dir}/table/katybug-src.rev`, 'utf8').trim(), refills },
	arch: Object.fromEntries(
		['x86_64', 'aarch64'].map((a) => [
			a,
			arch(
				parse(readFileSync(`${dir}/table/table-${a}.tsv`, 'utf8')),
				parse(readFileSync(`${dir}/ws/ws-${a}.tsv`, 'utf8')),
				existsSync(`${dir}/ws2/ws2-${a}.tsv`) ? parse(readFileSync(`${dir}/ws2/ws2-${a}.tsv`, 'utf8')) : [],
				readDepth(a),
				refills
			)
		])
	),
	js: JSON.parse(readFileSync(jsPath, 'utf8'))
};
writeFileSync(outPath, JSON.stringify(table, null, '\t') + '\n');
const fmt = (e: Est) => `${e.ns.toFixed(2)} ns (se ${e.se.toFixed(2)}, ${e.min.toFixed(2)}-${e.max.toFixed(2)}, ${e.n} arms)`;
for (const [a, t] of Object.entries(table.arch as Record<string, ReturnType<typeof arch>>)) {
	console.log(`${a}: block model ${t.blockModel.chosen}; chain ${JSON.stringify(t.blockModel.byArm.chain)}; fuse ${JSON.stringify(t.blockModel.byArm.fuse)}; t8 ${JSON.stringify(t.blockModel.byArm.t8)}`);
	for (const x of arms) console.log(`  ${x}: A max residual ${(100 * t.blockModel.fits[x]!.A.maxRel).toFixed(1)}%, B ${(100 * t.blockModel.fits[x]!.B.maxRel).toFixed(1)}%`);
	console.log(`${a}: lookup0 ${t.lookupWs.lookup0.toFixed(2)} ns; exit ${fmt(t.exitNs)}`);
	console.log(`${a}: refill 0 extra ${fmt(t.refillNs.extra0)}; 32 extra ${fmt(t.refillNs.extra32)}`);
}
