import { readFileSync } from 'node:fs';

/**
 * Per cell, what a timed sweep's sample files hold: the samples kept (rc 0, quiet reading at most 0.5 or none),
 * the noisy ones (above 0.5), the failed ones, the quiet reading's min, median and max, and the median of the kept
 * times. The warm and first runs count as samples but never as times. The lines are region-time.sh's and
 * region-wasm.ts's: host, workload, arm, process, round, attempt, ms, quiet, load1, rc, tab-separated.
 *
 * `samples-table.ts <samples file>...`
 */
export interface Sample {
	host: string;
	workload: string;
	arm: string;
	proc: string;
	round: string;
	attempt: number;
	ms: number;
	quiet: number | null;
	load: number;
	rc: number;
}

export function parseSamples(text: string): Sample[] {
	return text
		.split('\n')
		.map((l) => l.split('\t'))
		.filter((f) => f.length === 10)
		.map((f) => ({
			host: f[0]!,
			workload: f[1]!,
			arm: f[2]!,
			proc: f[3]!,
			round: f[4]!,
			attempt: Number(f[5]),
			ms: Number(f[6]),
			quiet: f[7] === '-' ? null : Number(f[7]),
			load: Number(f[8]),
			rc: Number(f[9])
		}));
}

const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
const isNoisy = (s: Sample) => s.quiet !== null && s.quiet > 0.5;

export function summarize(samples: Sample[]) {
	const cells = new Map<string, Sample[]>();
	for (const s of samples) {
		const key = [s.host, s.workload, s.proc, s.arm].join('\t');
		cells.set(key, [...(cells.get(key) ?? []), s]);
	}
	return [...cells].map(([key, list]) => {
		const [host, workload, proc, arm] = key.split('\t') as [string, string, string, string];
		const ok = list.filter((s) => s.rc === 0);
		const kept = ok.filter((s) => !isNoisy(s));
		const timed = kept.filter((s) => /^\d+$/.test(s.round));
		const quiet = list.flatMap((s) => (s.quiet === null ? [] : [s.quiet]));
		return {
			host,
			workload,
			proc,
			arm,
			kept: kept.length,
			noisy: ok.length - kept.length,
			failed: list.length - ok.length,
			quietMin: quiet.length ? Math.min(...quiet) : null,
			quietMedian: median(quiet) ?? null,
			quietMax: quiet.length ? Math.max(...quiet) : null,
			ms: median(timed.map((s) => s.ms)) ?? null
		};
	});
}

if (process.argv[1]?.endsWith('samples-table.ts')) {
	const f = (v: number | null) => (v === null ? '-' : String(Math.round(v * 100) / 100));
	console.log('| host | workload | process | arm | kept | noisy | failed | quiet min | quiet median | quiet max | median ms of kept |');
	console.log('| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |');
	for (const path of process.argv.slice(2))
		for (const c of summarize(parseSamples(readFileSync(path, 'utf8'))))
			console.log(`| ${c.host} | ${c.workload} | ${c.proc} | ${c.arm} | ${c.kept} | ${c.noisy} | ${c.failed} | ${f(c.quietMin)} | ${f(c.quietMedian)} | ${f(c.quietMax)} | ${f(c.ms)} |`);
}
