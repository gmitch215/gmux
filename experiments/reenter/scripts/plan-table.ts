import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * The table for the planned-ladder cells (sweep.sh `pl` and `en`): per guest and form, each rung's ratio to the untouched
 * module in V8 and to the native -O2 and -O3native controls (median [min-max] over the samples, paired by index), its
 * boundary share, and the counted crossings from count.ts.
 *
 * `plan-table.ts <sample dir> <counts dir>`. Boundary share per rung, as a fraction of the rung's unit time: the crossings
 * a unit makes times a price, over the unit time, as a lower bound (the smallest isolated price: 11.3 ns down, 14.2 ns up)
 * and an upper bound (107 ns each way, the in-run direct figure). A directed edge is hot when its upper-bound share is at or
 * above HOT; the three hottest are listed.
 */
const [samples = '', counts = ''] = process.argv.slice(2);
const DOWN_LO = 11.3e-9;
const UP_LO = 14.2e-9;
const PRICE_HI = 107e-9;
const HOT = 0.01;
const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]!;
const span = (xs: number[], digits = 3) => `${median(xs).toFixed(digits)} [${Math.min(...xs).toFixed(digits)}-${Math.max(...xs).toFixed(digits)}]`;
const spread = (xs: number[]) => `${((100 * (Math.max(...xs) - Math.min(...xs))) / median(xs)).toFixed(1)}%`;
const pct = (x: number) => `${(100 * x).toFixed(2)}%`;

type Row = { rung: number; label: string; share: number; ms: number; down: number; up: number };
type Pl = { n: number; v8ms: number; rows: Row[] };
type Count = { label: string; n: number; mismatched: number; rows: { edge: string; side: string; counted: number; predicted: number; ok: boolean }[]; missing: string[] };
const existing = (name: string) => (existsSync(join(samples, name)) ? (JSON.parse(readFileSync(join(samples, name), 'utf8')) as Pl) : undefined);
const nativeMs = (i: number, g: string) => {
	const file = join(samples, `en-${g}-${i}.json`);
	if (!existsSync(file)) return {} as Record<string, number>;
	const out: Record<string, number> = {};
	for (const line of readFileSync(file, 'utf8').split('\n').filter(Boolean)) {
		const row = JSON.parse(line) as { variant: string; ms: number };
		out[row.variant] = row.ms;
	}
	return out;
};

for (const g of ['zlib', 'zstd']) {
	for (const form of ['base', 'mem0']) {
		const runs = [1, 2, 3, 4, 5].map((i) => ({ i, pl: existing(`pl-${g}-${form}-${i}.json`) })).filter((x): x is { i: number; pl: Pl } => !!x.pl);
		if (!runs.length) continue;
		const rungs = runs[0]!.pl.rows.map((r) => r.rung);
		console.log(`\n### ${g}, ${form} (${runs.length} samples)\n`);
		console.log('| rung | label | closed share (ladder count) | r vs untouched V8 | spread | r vs native -O2 | r vs native -O3native | boundary share, lower to upper | hottest directed edges (upper share) | counted exact |');
		console.log('| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |');
		for (const k of rungs) {
			const per = runs.map(({ i, pl }) => ({ i, pl, row: pl.rows.find((r) => r.rung === k)! }));
			const label = per[0]!.row.label;
			const rV8 = per.map(({ pl, row }) => row.ms / pl.v8ms);
			const nat = (variant: string) => per.map(({ i, row }) => row.ms / (nativeMs(i, g)[variant] ?? NaN));
			const cfile = join(counts, `${g}-${form}-${k}.json`);
			const c = existsSync(cfile) ? (JSON.parse(readFileSync(cfile, 'utf8')) as Count) : undefined;
			const n = per[0]!.pl.n;
			const unit = (ms: number) => ms / 1e3;
			let lo = 'n/a';
			let hi = 'n/a';
			let hot = 'n/a';
			let exact = 'n/a';
			if (c) {
				const dn = c.rows.filter((r) => r.side === 'down').reduce((s, r) => s + r.counted, 0);
				const up = c.rows.filter((r) => r.side === 'up').reduce((s, r) => s + r.counted, 0);
				const t = unit(per[0]!.row.ms);
				// counted is per unit, the timed pair is n units
				const lowShare = (n * (dn * DOWN_LO + up * UP_LO)) / t;
				const hiShare = (n * (dn + up) * PRICE_HI) / t;
				lo = pct(lowShare);
				hi = pct(hiShare);
				const edges = c.rows
					.map((r) => ({ edge: r.edge, share: (n * r.counted * PRICE_HI) / t }))
					.sort((a, b) => b.share - a.share)
					.slice(0, 3);
				hot = edges.map((e) => `${e.edge} ${pct(e.share)}${e.share >= HOT ? ' (hot)' : ''}`).join('; ') || 'none';
				exact = c.mismatched === 0 ? `yes (${c.rows.length} sites)` : `NO: ${c.mismatched}`;
			}
			console.log(
				`| ${k} | ${label} | ${pct(per[0]!.row.share)} | ${span(rV8)} | ${spread(rV8)} | ${span(nat('O2'), 3)} | ${span(nat('O3native'), 3)} | ${lo} to ${hi} | ${hot} | ${exact} |`
			);
		}
	}
}
