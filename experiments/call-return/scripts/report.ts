import { readFileSync } from 'node:fs';

/**
 * Reads run.sh's samples.tsv: a layout's time is the minimum cpu over its rounds' clean samples, an arm's
 * is the mean over layouts, spread = (slowest - fastest layout) / mean. "vs off" is the arm's mean over
 * off's; "paired" is the same per layout, lowest to highest; off2 is off run a second time, so its
 * "vs off" is what noise alone does. Dirty samples (a process shared the core after every try) are
 * counted and left out.
 * `node --experimental-strip-types report.ts <samples.tsv>`
 */
const path = process.argv[2];
if (!path) {
	console.error('usage: report.ts <samples.tsv>');
	process.exit(2);
}
const rows = readFileSync(path, 'utf8')
	.trim()
	.split('\n')
	.slice(1)
	.map((l) => l.split('\t'));
const samples = rows.map((c) => ({
	key: `${c[0]}\t${c[1]}`,
	arm: c[2]!,
	layout: c[3]!,
	cpu: Number(c[6]),
	load: Math.max(Number(c[9]), Number(c[10])),
	dirty: c[12] === '1'
}));

const mean = (v: number[]) => v.reduce((a, b) => a + b, 0) / v.length;
const pct = (v: number) => `${(v * 100).toFixed(1)}%`;
console.log(['arch', 'workload', 'arm', 'cpu', 'spread', 'vs off', 'paired', 'clean', 'dirty', 'max load'].join('\t'));
for (const key of new Set(samples.map((s) => s.key))) {
	const g = samples.filter((s) => s.key === key);
	const best = (arm: string) => {
		const clean = g.filter((s) => s.arm === arm && !s.dirty);
		const layouts = [...new Set(clean.map((s) => s.layout))].sort();
		return new Map(layouts.map((l) => [l, Math.min(...clean.filter((s) => s.layout === l).map((s) => s.cpu))]));
	};
	const off = best('off');
	for (const arm of ['off', 'on', 'off2', 'native']) {
		if (!g.some((s) => s.arm === arm)) continue;
		const b = best(arm);
		const all = g.filter((s) => s.arm === arm);
		const cpus = [...b.values()];
		const m = mean(cpus);
		const paired = [...b].filter(([l]) => off.has(l)).map(([l, v]) => v / off.get(l)! - 1);
		console.log(
			[
				...key.split('\t'),
				arm,
				m.toFixed(3),
				pct((Math.max(...cpus) - Math.min(...cpus)) / m),
				arm === 'off' ? '-' : pct(m / mean([...off.values()]) - 1),
				arm === 'off' ? '-' : `${pct(Math.min(...paired))}..${pct(Math.max(...paired))}`,
				all.filter((s) => !s.dirty).length,
				all.filter((s) => s.dirty).length,
				Math.max(...all.map((s) => s.load)).toFixed(2)
			].join('\t')
		);
	}
}
