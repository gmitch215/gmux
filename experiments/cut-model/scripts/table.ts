import { readFileSync, writeFileSync } from 'node:fs';
import { parse, solve, type Row } from './model.ts';

/**
 * The crossing table: what each Katybug crossing costs, from the guest microbenchmark (`cross-kb.sh
 * table`, one TSV a host arch) and the JS and wasm crossings (`cross-js.ts`), each with its spread.
 * The table is written once and frozen; `predict.ts` reads it and nothing here sees the sweep it
 * predicts.
 *
 * Time is wall seconds (the sweep's CPU column has 10 ms steps). Features are in millions and time in
 * ms, so a coefficient reads in ns. Per arm, with F the empty guest's time:
 *
 * - alu (one block a pass, work per block varies): t - F = op ops + block blocks;
 * - the branch guest (a hot arm left 0..50% of passes, blocks near fixed): with block from alu and
 *   lookup from base - chain, t - F - block blocks - lookup lookups = op ops + exit exits;
 * - the mapping guest (one load in one mapping, or alternating between two): a miss is the time of
 *   the alternating run over the single-mapping run, per refill, at 0 and 32 extra mappings.
 *
 * `node --experimental-strip-types table.ts <table dir> <cross-js.json> <out.json> [refill counts.json]`
 */
const [dir = '', jsPath = '', outPath = '', refillPath = ''] = process.argv.slice(2);

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

const traceArms = ['t2', 't4', 't8', 't16', 't32', 't64'];
const arms = ['base', 'chain', 'fuse', ...traceArms];
const M = 1e6;

function arch(rows: Row[], refills: Record<string, number>) {
	const at = (w: string, a: string) => {
		const r = rows.find((r) => r.workload === w && r.arm === a);
		if (!r) throw new Error(`no ${w} ${a}`);
		return r;
	};
	const ms = (r: Row) => r.wall * 1e3;
	const fixed = Object.fromEntries(arms.map((a) => [a, ms(at('null', a))]));
	const alu = ['a1', 'a4', 'a16', 'a64', 'a64x'];
	const perArm = Object.fromEntries(
		arms.map((a) => {
			const g = alu.map((w) => at(w, a));
			const f = lsq(
				g.map((r) => [r.ops / M, r.blocks / M]),
				g.map((r) => ms(r) - fixed[a]!)
			);
			return [a, { op: single(f.coef[0]!, f.se[0]!), block: single(f.coef[1]!, f.se[1]!), rel: f.rel }];
		})
	);
	const block = {
		base: perArm.base!.block,
		chain: perArm.chain!.block,
		fuse: perArm.fuse!.block,
		trace: est(traceArms.map((a) => perArm[a]!.block))
	};
	const lookup = single(block.base.ns - block.chain.ns, Math.hypot(block.base.se, block.chain.se));
	const blockOf = (a: string) => (a === 'base' ? block.chain.ns : a === 'chain' ? block.chain.ns : a === 'fuse' ? block.fuse.ns : block.trace.ns);
	const branch = ['b0', 'b32', 'b8', 'b4', 'b2'];
	const exitPerArm = Object.fromEntries(
		traceArms.map((a) => {
			const g = branch.map((w) => at(w, a));
			const f = lsq(
				g.map((r) => [r.ops / M, r.exits / M]),
				g.map((r) => ms(r) - fixed[a]! - (blockOf(a) * r.blocks) / M - (lookup.ns * r.lookups) / M)
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
		alu: Object.fromEntries(arms.map((a) => [a, perArm[a]])),
		blockNs: block,
		lookupNs: lookup,
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
const table: Record<string, unknown> = {
	kind: 'katybug crossing costs (ns)',
	source: { katybugSourceRev: readFileSync(`${dir}/katybug-src.rev`, 'utf8').trim(), refills },
	arch: Object.fromEntries(['x86_64', 'aarch64'].map((a) => [a, arch(parse(readFileSync(`${dir}/table-${a}.tsv`, 'utf8')), refills)])),
	js: JSON.parse(readFileSync(jsPath, 'utf8'))
};
writeFileSync(outPath, JSON.stringify(table, null, '\t') + '\n');
const fmt = (e: Est) => `${e.ns.toFixed(2)} ns (se ${e.se.toFixed(2)}, ${e.min.toFixed(2)}-${e.max.toFixed(2)}, ${e.n} arms)`;
for (const [a, t] of Object.entries(table.arch as Record<string, ReturnType<typeof arch>>)) {
	console.log(`${a}: block chain ${fmt(t.blockNs.chain)}; fuse ${fmt(t.blockNs.fuse)}; trace ${fmt(t.blockNs.trace)}`);
	console.log(`${a}: lookup ${fmt(t.lookupNs)}; exit ${fmt(t.exitNs)}`);
	console.log(`${a}: refill 0 extra ${fmt(t.refillNs.extra0)}; 32 extra ${fmt(t.refillNs.extra32)}`);
}
