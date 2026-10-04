import { lookupNs } from './lookup.ts';
import type { Row } from './model.ts';

/** blocks a program holds in the cache, and the number its dispatches spread over (`hot.sh`: a cover count or the perplexity), per sweep arm */
export interface Hot {
	held: number;
	spread: number;
}

export interface Cell {
	workload: string;
	arm: string;
	measured: number;
	predicted: number;
	error: number;
	spread: number;
	parts: { blocks: number; lookups: number; exits: number; refills: number; rf: number };
	lookupNs: number;
}

const M = 1e6;
export const traceArms = ['t2', 't4', 't8', 't16', 't32', 't64'];

/** ns a lookup costs a row: the table's one number, or (a table with `lookupWs`) its working set's */
export function lookupFor(t: any, r: Row, hot?: Hot) {
	if (!t.lookupWs) return t.lookupNs.ns as number;
	if (!hot) throw new Error(`no hot-set row for ${r.workload} ${r.arm}`);
	return lookupNs(t.lookupWs, hot.held, hot.spread);
}

/** ns a block costs: by arm in a table of one block cost each, or from the table's block model */
export function blockFor(t: any, r: Row) {
	if (t.blockModel) return t.blockModel.byArm[r.arm].block as number;
	const a = r.arm;
	return a === 'base' || a === 'chain' ? t.blockNs.chain.ns : a === 'fuse' ? t.blockNs.fuse.ns : t.blockNs.trace.ns;
}

/** ns more an op costs in the arm's blocks as they are long (the block model's q ops L; 0 in a table without it) */
export function longBlockFor(t: any, r: Row) {
	return t.blockModel ? (t.blockModel.byArm[r.arm].q as number) * (r.ops / r.blocks) : 0;
}

/** an arm's per-op cost over the base arm's (the tl guests' op term by arm; 1 in a table without it) */
export function opScaleFor(t: any, r: Row) {
	return (t.blockModel?.byArm[r.arm].opScale as number | undefined) ?? 1;
}

/**
 * The sweep's arms predicted from a frozen crossing table, nothing fitted to the sweep. The one number taken
 * from a workload is its per-op cost, read off the `base` arm (F + op ops + block blocks + lookup
 * lookups + refill refills, solved for op); every other arm is then predicted and set against its
 * measurement. `rows` are the sweep rows of one arch with counters.
 */
export function predictArch(
	t: any,
	rows: Row[],
	refills: (workload: string, arm: string) => number,
	hotOf: (workload: string, arm: string) => Hot | undefined,
	refillNs: number,
	lookupOf?: (workload: string) => number | undefined
): Cell[] {
	const exit = (a: string) => (traceArms.includes(a) ? (t.exitNsByArm[a].ns as number) : 0);
	const parts = (r: Row) => {
		const rf = refills(r.workload, r.arm);
		const lk = lookupOf?.(r.workload) ?? lookupFor(t, r, hotOf(r.workload, r.arm));
		return {
			p: {
				blocks: (blockFor(t, r) * r.blocks) / M,
				lookups: (lk * r.lookups) / M,
				exits: (exit(r.arm) * r.exits) / M,
				refills: (refillNs * rf) / M,
				rf
			},
			lk
		};
	};
	const out: Cell[] = [];
	for (const w of [...new Set(rows.map((r) => r.workload))]) {
		const base = rows.find((r) => r.workload === w && r.arm === 'base')!;
		const pb = parts(base).p;
		const opNs = (base.wall * 1e3 - t.fixedMs.base - pb.blocks - pb.lookups - pb.refills) / (base.ops / M) - longBlockFor(t, base);
		for (const r of rows.filter((r) => r.workload === w && r.arm !== 'base')) {
			const { p, lk } = parts(r);
			const predicted = t.fixedMs[r.arm] + ((opNs * opScaleFor(t, r) + longBlockFor(t, r)) * r.ops) / M + p.blocks + p.lookups + p.exits + p.refills;
			const measured = r.wall * 1e3;
			out.push({ workload: w, arm: r.arm, measured, predicted, error: (predicted - measured) / measured, spread: r.spread, parts: p, lookupNs: lk });
		}
	}
	return out;
}

/** a program's own ns a lookup: the time chaining saves over the lookups it avoids, from its base and chain arms */
export function ownLookupNs(rows: Row[]) {
	const out = new Map<string, number>();
	for (const w of new Set(rows.map((r) => r.workload))) {
		const b = rows.find((r) => r.workload === w && r.arm === 'base');
		const c = rows.find((r) => r.workload === w && r.arm === 'chain');
		if (b && c && b.lookups > c.lookups) out.set(w, ((b.wall - c.wall) * 1e9) / (b.lookups - c.lookups));
	}
	return out;
}

/** rows with no counters (a program that closed katybug's stderr) take them from a run that kept it, keeping their own timings */
export function withCounters(rows: Row[], counted: Row[]): Row[] {
	return rows.map((r) => {
		if (r.blocks) return r;
		const c = counted.find((o) => o.arch === r.arch && o.workload === r.workload && o.arm === r.arm);
		return c ? { ...r, blocks: c.blocks, exits: c.exits, ops: c.ops, lookups: c.lookups, held: c.held } : r;
	});
}
