import { readFileSync } from 'node:fs';

/**
 * The table of bench.sh's shapes samples: per server and cell the CPU of one request in each run (the
 * run's mean over its rounds), the median over runs, the spread, the cell against the same server's
 * seq cell (new stream per request, the control in every run), and the crossings, steps and guest state
 * per request. The keepalive saving is (seq - keepalive) / seq of the run medians, held against
 * THRESHOLD percent. Samples read quiet above 0.5 are listed apart and left out of the medians.
 * `node --experimental-strip-types shapes-table.ts <shapes.jsonl> [threshold percent]`
 */
interface Sample {
	server: string;
	cell: string;
	run: number;
	quiet: string;
	ok: number;
	out: {
		cpuMs: { mean: number };
		steps: { mean: number };
		perRequest: Record<string, number>;
		steady: { memFreeKb: number; tasks: number; openStreams: number };
	} | null;
}

const median = (v: number[]) => {
	const s = [...v].sort((a, b) => a - b);
	return (s[Math.floor((s.length - 1) / 2)]! + s[Math.floor(s.length / 2)]!) / 2;
};
const noisy = (s: Sample) => Number(s.quiet.split(' ')[1] ?? 0) > 0.5;
const f = (n: number, d = 3) => (Number.isFinite(n) ? n.toFixed(d) : '-');
const order = (cell: string) => (cell === 'seq' ? 0 : cell === 'keepalive' ? 1 : 2 + Number(cell.slice(4)));

/** markdown lines for the text of a bench.sh shapes samples file */
export function shapesReport(jsonl: string, threshold = 10): string[] {
	const samples = jsonl
		.split('\n')
		.filter((line) => line.startsWith('{'))
		.map((line) => JSON.parse(line) as Sample)
		.filter((s) => s.ok === 1 && s.out);
	const out = [
		'| server | cell | runs | CPU ms per request, per run | median ms | spread % | vs seq % | steps | next | send | end | free kB | tasks | quiet above 0.5 |',
		'| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |'
	];
	const lines: string[] = [];
	for (const server of [...new Set(samples.map((s) => s.server))].sort()) {
		const mine = samples.filter((s) => s.server === server);
		const med = (cell: string) =>
			median(mine.filter((s) => s.cell === cell && !noisy(s)).map((s) => s.out!.cpuMs.mean));
		const seq = med('seq');
		for (const cell of [...new Set(mine.map((s) => s.cell))].sort((a, b) => order(a) - order(b))) {
			const rows = mine.filter((s) => s.cell === cell);
			const kept = rows.filter((s) => !noisy(s));
			const cpu = kept.map((s) => s.out!.cpuMs.mean);
			const m = median(cpu);
			const each = (pick: (s: Sample) => number) => f(median(kept.map(pick)), 3);
			out.push(
				`| ${server} | ${cell} | ${kept.length} | ${rows.map((s) => f(s.out!.cpuMs.mean)).join(', ')} | ${f(m)} | ${f(((Math.max(...cpu) - Math.min(...cpu)) / m) * 100, 1)} | ${cell === 'seq' ? '-' : f(((m - seq) / seq) * 100, 1)} | ${each((s) => s.out!.steps.mean)} | ${each((s) => s.out!.perRequest.nextCalls!)} | ${each((s) => s.out!.perRequest.sendCalls!)} | ${each((s) => s.out!.perRequest.endCalls!)} | ${each((s) => s.out!.steady.memFreeKb)} | ${each((s) => s.out!.steady.tasks)} | ${rows.length - kept.length} |`
			);
		}
		if (mine.some((s) => s.cell === 'keepalive')) {
			const saving = ((seq - med('keepalive')) / seq) * 100;
			lines.push(
				`${server}: keepalive saves ${f(saving, 1)}% of a request's CPU (seq ${f(seq)} ms, keepalive ${f(med('keepalive'))} ms); threshold ${threshold}%: ${saving >= threshold ? 'met' : 'not met'}`
			);
		}
	}
	return [...out, '', ...lines];
}

if (import.meta.main) {
	const path = process.argv[2];
	if (!path) {
		console.error('usage: shapes-table.ts <shapes.jsonl> [threshold percent]');
		process.exit(2);
	}
	console.log(shapesReport(readFileSync(path, 'utf8'), Number(process.argv[3] ?? 10)).join('\n'));
}
