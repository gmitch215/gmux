import { readFileSync } from 'node:fs';

// samples.tsv from load-floor.sh; a round's ratio is median(A) / median(B) over that round's samples
// `node --experimental-strip-types table.ts <samples.tsv>`
const CONDITIONS = ['base', 'same', 'other', 'sib'];
const CELLS = ['comp', 'mem'];
// a third of the smallest reported effect (2.7%); a preference, not a measured limit
const RATIO_BAND = 0.009;
const IQR_LIMIT = 0.018;

export interface Sample {
	cond: string;
	cell: string;
	round: number;
	arm: string;
	seconds: number;
	rc: number;
	quiet: number;
	load: number;
}

export interface Row {
	cond: string;
	cell: string;
	rounds: number;
	median: number;
	min: number;
	max: number;
	iqr: number;
	beyond1: number;
	beyond2: number;
	secsA: number;
	secsB: number;
	quiet: number;
	load: number;
	ok: boolean;
}

export function parse(tsv: string): Sample[] {
	return tsv
		.trim()
		.split('\n')
		.slice(1)
		.map((line) => {
			const [cond, cell, round, , arm, seconds, rc, quiet, load] = line.split('\t');
			return {
				cond: cond!,
				cell: cell!,
				round: Number(round),
				arm: arm!,
				seconds: Number(seconds),
				rc: Number(rc),
				quiet: Number(quiet),
				load: Number(load),
			};
		});
}

// linear interpolation between order statistics (type 7)
export function quantile(values: number[], p: number): number {
	const s = [...values].sort((a, b) => a - b);
	const h = (s.length - 1) * p;
	const lo = Math.floor(h);
	return s[lo]! + (s[Math.ceil(h)]! - s[lo]!) * (h - lo);
}

const median = (values: number[]) => quantile(values, 0.5);

export function summarize(samples: Sample[]): Row[] {
	const rows: Row[] = [];
	for (const cond of CONDITIONS) {
		for (const cell of CELLS) {
			const here = samples.filter((s) => s.cond === cond && s.cell === cell);
			const timesOf = (arm: string, round?: number) =>
				here
					.filter((s) => s.arm === arm && (round === undefined || s.round === round))
					.map((s) => s.seconds);
			const rounds = [...new Set(here.map((s) => s.round))]
				.sort((x, y) => x - y)
				.filter((r) => timesOf('A', r).length > 0 && timesOf('B', r).length > 0);
			if (rounds.length === 0) continue;
			const ratios = rounds.map((r) => median(timesOf('A', r)) / median(timesOf('B', r)));
			const iqr = quantile(ratios, 0.75) - quantile(ratios, 0.25);
			const med = median(ratios);
			const beyond = (band: number) =>
				ratios.filter((x) => Math.abs(x - 1) > band).length / ratios.length;
			rows.push({
				cond,
				cell,
				rounds: rounds.length,
				median: med,
				min: Math.min(...ratios),
				max: Math.max(...ratios),
				iqr,
				beyond1: beyond(0.01),
				beyond2: beyond(0.02),
				secsA: median(timesOf('A')),
				secsB: median(timesOf('B')),
				quiet: median(here.map((s) => s.quiet)),
				load: median(here.map((s) => s.load)),
				ok: Math.abs(med - 1) <= RATIO_BAND && iqr <= IQR_LIMIT,
			});
		}
	}
	return rows;
}

export function verdicts(rows: Row[]): Map<string, boolean> {
	const out = new Map<string, boolean>();
	for (const cond of CONDITIONS) {
		const mine = rows.filter((r) => r.cond === cond);
		if (mine.length === 0) continue;
		out.set(cond, CELLS.every((cell) => mine.some((r) => r.cell === cell && r.ok)));
	}
	return out;
}

const signed = (x: number) => `${x >= 0 ? '+' : ''}${(x * 100).toFixed(2)}%`;
const pct = (x: number, d = 2) => `${(x * 100).toFixed(d)}%`;

export function report(tsv: string): string {
	const rows = summarize(parse(tsv));
	const lines = [
		'| condition | cell | rounds | median ratio | min | max | IQR | beyond 1% | beyond 2% | median A s | median B s | median quiet | median load | ok |',
		'| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |',
	];
	for (const r of rows) {
		lines.push(
			`| ${r.cond} | ${r.cell} | ${r.rounds} | ${signed(r.median - 1)} | ${signed(r.min - 1)} | ${signed(r.max - 1)} | ${pct(r.iqr)} | ${pct(r.beyond1, 0)} | ${pct(r.beyond2, 0)} | ${r.secsA.toFixed(3)} | ${r.secsB.toFixed(3)} | ${r.quiet.toFixed(2)} | ${r.load.toFixed(2)} | ${r.ok ? 'yes' : 'no'} |`,
		);
	}
	for (const [cond, ok] of verdicts(rows)) {
		lines.push(`verdict ${cond}: ${ok ? 'acceptable' : 'not acceptable'}`);
	}
	return lines.join('\n') + '\n';
}

if (process.argv[1]?.endsWith('table.ts')) {
	process.stdout.write(report(readFileSync(process.argv[2]!, 'utf8')));
}
