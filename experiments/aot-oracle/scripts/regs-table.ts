import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Reads regs-wasm.ts's logs (one per workload and layout) and prints the ladder table and the verdict on
 * which KATYBUG_REGS arm earns the default: exact on every row, faster than regs=0 on the geomean of the
 * workloads by more than their mean spread, and on no workload slower than regs=0 by more than that row's
 * spread. A row's spread is the larger (max - min) / median of the two arms it compares.
 *
 * `regs-table.ts <dir with regs-*.log>`
 */
export interface Row {
	workload: string;
	layout: number;
	arm: string;
	runs: number[];
	median: number;
	spread: number;
	md5: string;
}

export function parse(text: string): Row[] {
	const rows: Row[] = [];
	for (const line of text.split('\n')) {
		const at = line.indexOf('| ');
		if (at < 0 || line.includes('---') || line.includes('workload |')) continue;
		const c = line
			.slice(at)
			.split('|')
			.map((x) => x.trim())
			.slice(1, -1);
		if (c.length < 7) continue;
		rows.push({
			workload: c[0]!,
			layout: Number(c[1]),
			arm: c[2]!,
			runs: c[3]!.split(' ').map(Number),
			median: Number(c[4]),
			spread: parseFloat(c[5]!) / 100,
			md5: c[6]!
		});
	}
	return rows;
}

export interface Compare {
	workload: string;
	layout: number;
	ratio: number;
	spread: number;
}

const geomean = (xs: number[]) => Math.exp(xs.reduce((s, x) => s + Math.log(x), 0) / xs.length);
const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]!;

export function compare(rows: Row[], arm: string, base = 'regs=0'): Compare[] {
	const out: Compare[] = [];
	for (const a of rows.filter((r) => r.arm === arm)) {
		const b = rows.find((r) => r.arm === base && r.workload === a.workload && r.layout === a.layout);
		if (b) out.push({ workload: a.workload, layout: a.layout, ratio: a.median / b.median, spread: Math.max(a.spread, b.spread) });
	}
	return out;
}

export interface Verdict {
	arm: string;
	exact: boolean;
	geomean: number;
	meanSpread: number;
	slower: string[];
	earns: boolean;
}

export function verdict(rows: Row[], arm: string): Verdict {
	const cmp = compare(rows, arm);
	const workloads = [...new Set(cmp.map((c) => c.workload))];
	const per = workloads.map((w) => {
		const mine = cmp.filter((c) => c.workload === w);
		return { ratio: median(mine.map((c) => c.ratio)), spread: median(mine.map((c) => c.spread)) };
	});
	const exact = [...new Set(rows.map((r) => `${r.workload}/${r.layout}`))].every((k) => new Set(rows.filter((r) => `${r.workload}/${r.layout}` === k).map((r) => r.md5)).size === 1);
	const g = per.length ? geomean(per.map((p) => p.ratio)) : NaN;
	const meanSpread = per.length ? per.reduce((s, p) => s + p.spread, 0) / per.length : NaN;
	const slower = cmp.filter((c) => c.ratio > 1 + c.spread).map((c) => `${c.workload}/${c.layout}`);
	return { arm, exact, geomean: g, meanSpread, slower, earns: exact && g < 1 - meanSpread && slower.length === 0 };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
	const dir = process.argv[2] ?? '.';
	const rows = readdirSync(dir)
		.filter((f) => /^regs-\d+-\w+\.log$/.test(f))
		.sort()
		.flatMap((f) => parse(readFileSync(join(dir, f), 'utf8')));
	console.log('| workload | layout | regs=0 | regs=1 | regs=2 | old | regs=1 / regs=0 | regs=2 / regs=0 | regs=2 / regs=1 | regs=2 / old | spread (0, 1, 2, old) | md5 equal |');
	console.log('| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |');
	const keys = [...new Set(rows.map((r) => `${r.workload}\t${r.layout}`))];
	for (const k of keys) {
		const [w, l] = k.split('\t') as [string, string];
		const at = (arm: string) => rows.find((r) => r.workload === w && r.layout === Number(l) && r.arm === arm);
		const [r0, r1, r2, old] = ['regs=0', 'regs=1', 'regs=2', 'old'].map(at);
		const ratio = (a?: Row, b?: Row) => (a && b ? (a.median / b.median).toFixed(4) : '-');
		const pct = (r?: Row) => (r ? (100 * r.spread).toFixed(1) : '-');
		const same = new Set([r0, r1, r2, old].filter(Boolean).map((r) => r!.md5)).size === 1;
		console.log(`| ${w} | ${l} | ${r0?.median ?? '-'} | ${r1?.median ?? '-'} | ${r2?.median ?? '-'} | ${old?.median ?? '-'} | ${ratio(r1, r0)} | ${ratio(r2, r0)} | ${ratio(r2, r1)} | ${ratio(r2, old)} | ${[r0, r1, r2, old].map(pct).join(', ')}% | ${same ? 'yes' : 'NO'} |`);
	}
	for (const arm of ['regs=1', 'regs=2']) {
		const v = verdict(rows, arm);
		console.log(`\n${arm} against regs=0: exact ${v.exact}, geomean ${v.geomean.toFixed(4)} over ${new Set(rows.map((r) => r.workload)).size} workloads (mean spread ${(100 * v.meanSpread).toFixed(1)}%), slower beyond spread: ${v.slower.join(' ') || 'none'}; earns the default: ${v.earns}`);
	}
}
