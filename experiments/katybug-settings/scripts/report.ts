import { readFileSync } from 'node:fs';

/**
 * Tables from run.ts's samples: a layout's time is the minimum wall ms over its clean rounds, an arm's
 * time the mean over its layouts, spread = (slowest - fastest layout) / mean, r = arm time over the
 * guest's native time, delta against the fused arm (the shipped default).
 * `node --no-warnings --experimental-strip-types report.ts <samples.tsv>`
 */
const file = process.argv[2];
if (!file) {
	console.error('usage: report.ts <samples.tsv>');
	process.exit(2);
}
const [head, ...rows] = readFileSync(file, 'utf8').trim().split('\n');
const cols = head!.split('\t');
const samples = rows.map((r) => Object.fromEntries(r.split('\t').map((v, i) => [cols[i]!, v])));
const clean = (s: Record<string, string>) => Number(s.other_ms) <= Math.max(50, 0.03 * Number(s.wall_ms));
const uniq = <T>(xs: T[]) => [...new Set(xs)];
const arches = uniq(samples.map((s) => s.arch!));
const arms = uniq(samples.map((s) => s.arm!));
const workloads = uniq(samples.map((s) => s.workload!)).filter((w) => w !== 'null');
const REF = 'fused';

interface Cell {
	ms: number;
	spread: number;
	rounds: number;
	dirty: number;
	native: number;
}
const cell = (arch: string, w: string, arm: string): Cell | undefined => {
	const all = samples.filter((s) => s.arch === arch && s.workload === w && s.arm === arm);
	if (!all.length) return undefined;
	const mins: number[] = [];
	let spreadRounds = 0;
	for (const l of uniq(all.map((s) => s.layout))) {
		const mine = all.filter((s) => s.layout === l);
		const ok = mine.filter(clean);
		const use = (ok.length ? ok : mine).map((s) => Number(s.wall_ms));
		mins.push(Math.min(...use));
		spreadRounds = Math.max(spreadRounds, (Math.max(...use) - Math.min(...use)) / Math.min(...use));
	}
	const mean = mins.reduce((a, b) => a + b, 0) / mins.length;
	return {
		ms: mean,
		spread: (Math.max(...mins) - Math.min(...mins)) / mean,
		rounds: spreadRounds,
		dirty: all.filter((s) => !clean(s)).length,
		native: Number(all[0]!.native_ms) || 0
	};
};
const pct = (x: number) => `${x >= 0 ? '+' : ''}${(x * 100).toFixed(1)}%`;

for (const arch of arches) {
	console.log(`\n### ${arch}\n`);
	console.log(`Wall seconds per arm (mean over link orders), spread across link orders in brackets, and r (x86_64 only, over native):\n`);
	console.log(`| workload | ${arms.join(' | ')} |`);
	console.log(`| --- | ${arms.map(() => '---').join(' | ')} |`);
	for (const w of workloads) {
		const r = arms.map((a) => {
			const c = cell(arch, w, a);
			if (!c) return '';
			return `${(c.ms / 1000).toFixed(3)} [${(c.spread * 100).toFixed(1)}%]${c.native ? ` r ${(c.ms / c.native).toFixed(0)}` : ''}`;
		});
		console.log(`| ${w} | ${r.join(' | ')} |`);
	}
	console.log(`\nDelta against ${REF} (negative is faster), geomean over workloads:\n`);
	console.log(`| workload | ${arms.join(' | ')} |`);
	console.log(`| --- | ${arms.map(() => '---').join(' | ')} |`);
	const logs: Record<string, number[]> = Object.fromEntries(arms.map((a) => [a, []]));
	for (const w of workloads) {
		const ref = cell(arch, w, REF);
		const r = arms.map((a) => {
			const c = cell(arch, w, a);
			if (!c || !ref) return '';
			logs[a]!.push(Math.log(c.ms / ref.ms));
			return pct(c.ms / ref.ms - 1);
		});
		console.log(`| ${w} | ${r.join(' | ')} |`);
	}
	console.log(`| geomean | ${arms.map((a) => (logs[a]!.length ? pct(Math.exp(logs[a]!.reduce((x, y) => x + y, 0) / logs[a]!.length) - 1) : '')).join(' | ')} |`);
	const noise = workloads.flatMap((w) => arms.map((a) => cell(arch, w, a)?.rounds ?? 0));
	const dirty = workloads.flatMap((w) => arms.map((a) => cell(arch, w, a)?.dirty ?? 0)).reduce((a, b) => a + b, 0);
	console.log(`\nLargest round-to-round range inside one layout: ${pct(Math.max(...noise))}; samples marked dirty: ${dirty}; samples ${samples.filter((s) => s.arch === arch).length}`);
}
