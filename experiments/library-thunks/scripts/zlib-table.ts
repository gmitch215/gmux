import { readFileSync } from 'node:fs';

/**
 * The table of zlib-wasm.ts's samples: per op and arm the samples kept, the median wall, its spread (highest
 * over lowest), the highest quiet reading with the count of samples above 0.5 (a smoke run) and the failed checks,
 * then r, an arm's median wall over native's.
 * `node --experimental-strip-types zlib-table.ts <samples.tsv>`
 */
const median = (v: number[]) => [...v].sort((a, b) => a - b)[Math.floor(v.length / 2)]!;
const f = (n: number, d = 3) => (Number.isFinite(n) ? n.toFixed(d) : '-');

interface Cell {
	wall: number[];
	quiet: number;
	smoke: number;
	failed: number;
}

/** markdown rows for the text of a zlib-wasm.ts samples file */
export function zlibReport(tsv: string): string[] {
	const cells = new Map<string, Cell>();
	const order: string[] = [];
	for (const line of tsv.trim().split('\n').slice(1)) {
		const [arm, op, iters, , ms, q0, q1, ok] = line.split('\t') as string[];
		const key = [op, iters, arm].join('\t');
		if (!cells.has(key)) order.push(key);
		const c = cells.get(key) ?? { wall: [], quiet: 0, smoke: 0, failed: 0 };
		c.wall.push(Number(ms) / 1000);
		const q = Math.max(Number(q0), Number(q1));
		c.quiet = Math.max(c.quiet, q);
		if (q > 0.5) c.smoke++;
		if (ok !== '1') c.failed++;
		cells.set(key, c);
	}
	const out = [
		'| op | iterations | arm | n | wall median s | highest over lowest | max quiet | smoke | failed |',
		'| --- | --- | --- | --- | --- | --- | --- | --- | --- |'
	];
	for (const key of order) {
		const [op, iters, arm] = key.split('\t') as [string, string, string];
		const c = cells.get(key)!;
		const spread = Math.max(...c.wall) / Math.min(...c.wall);
		out.push(`| ${op} | ${iters} | ${arm} | ${c.wall.length} | ${f(median(c.wall))} | ${f(spread, 2)} | ${f(c.quiet, 2)} | ${c.smoke} | ${c.failed} |`);
	}
	out.push('', '| op | arm | wall r |', '| --- | --- | --- |');
	for (const key of order) {
		const [op, iters, arm] = key.split('\t') as [string, string, string];
		const base = cells.get([op, iters, 'native'].join('\t'));
		if (arm !== 'native' && base) out.push(`| ${op} | ${arm} | ${f(median(cells.get(key)!.wall) / median(base.wall), 2)} |`);
	}
	return out;
}

if (import.meta.main) {
	const path = process.argv[2];
	if (!path) {
		console.error('usage: zlib-table.ts <samples.tsv>');
		process.exit(2);
	}
	console.log(zlibReport(readFileSync(path, 'utf8')).join('\n'));
}
