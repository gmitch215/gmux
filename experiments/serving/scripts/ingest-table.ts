import { readFileSync } from 'node:fs';

/**
 * The table of bench.sh's ingest samples: per body size the CPU of one request in each run (the run's
 * mean over its rounds), the median over runs and its cost per MiB, then a line fit of CPU against
 * size (the slope is ms per MiB, the intercept what any request costs) and the largest body whose
 * ingest stays within BUDGET_MS once the host's speed is scaled by SLOWDOWN. Samples read quiet above
 * 0.5 are listed apart and left out of the fit.
 * `node --experimental-strip-types ingest-table.ts <ingest.jsonl> [budget ms] [slowdown]`
 */
interface Sample {
	mib: number;
	run: number;
	quiet: string;
	ok: number;
	out: { cpuMs: { mean: number } } | null;
}

const median = (v: number[]) => {
	const s = [...v].sort((a, b) => a - b);
	return (s[Math.floor((s.length - 1) / 2)]! + s[Math.floor(s.length / 2)]!) / 2;
};
const noisy = (s: Sample) => Number(s.quiet.split(' ')[1] ?? 0) > 0.5;
const f = (n: number, d = 3) => (Number.isFinite(n) ? n.toFixed(d) : '-');

/** markdown lines for the text of a bench.sh ingest samples file */
export function ingestReport(jsonl: string, budgetMs = 10_000, slowdown = 7.4): string[] {
	const samples = jsonl
		.split('\n')
		.filter((line) => line.startsWith('{'))
		.map((line) => JSON.parse(line) as Sample)
		.filter((s) => s.ok === 1 && s.out);
	const out = [
		'| MiB | runs | CPU ms per request, per run | median ms | median ms per MiB | quiet above 0.5 |',
		'| --- | --- | --- | --- | --- | --- |'
	];
	const points: [number, number][] = [];
	const sizes = [...new Set(samples.map((s) => s.mib))].sort((a, b) => a - b);
	for (const mib of sizes) {
		const rows = samples.filter((s) => s.mib === mib);
		const kept = rows.filter((s) => !noisy(s));
		const cpu = kept.map((s) => s.out!.cpuMs.mean);
		if (cpu.length) points.push([mib, median(cpu)]);
		out.push(
			`| ${mib} | ${kept.length} | ${rows.map((s) => f(s.out!.cpuMs.mean)).join(', ')} | ${f(median(cpu))} | ${f(median(cpu) / mib)} | ${rows.length - kept.length} |`
		);
	}
	if (points.length < 2) return [...out, '', 'fit: fewer than two sizes'];
	const mx = points.reduce((s, [x]) => s + x, 0) / points.length;
	const my = points.reduce((s, [, y]) => s + y, 0) / points.length;
	const slope =
		points.reduce((s, [x, y]) => s + (x - mx) * (y - my), 0) /
		points.reduce((s, [x]) => s + (x - mx) ** 2, 0);
	const base = my - slope * mx;
	return [
		...out,
		'',
		`fit: ${f(slope)} ms per MiB, ${f(base)} ms per request`,
		`largest body within ${budgetMs} ms at ${slowdown}x: floor((${budgetMs} / ${slowdown} - ${f(base)}) / ${f(slope)}) = ${Math.floor((budgetMs / slowdown - base) / slope)} MiB`
	];
}

if (import.meta.main) {
	const path = process.argv[2];
	if (!path) {
		console.error('usage: ingest-table.ts <ingest.jsonl> [budget ms] [slowdown]');
		process.exit(2);
	}
	console.log(
		ingestReport(
			readFileSync(path, 'utf8'),
			Number(process.argv[3] ?? 10_000),
			Number(process.argv[4] ?? 7.4)
		).join('\n')
	);
}
