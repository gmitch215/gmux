import { readFileSync } from 'node:fs';

/**
 * Reads run.sh's samples.tsv: a layout's time is the minimum over its rounds' clean samples, an arm's
 * is the mean over layouts, spread = (slowest - fastest layout) / mean. r is the arm's wall over the
 * native run's fastest wall (x86-64 guests on an x86-64 host). Dirty samples (a process shared the
 * core after every try) are counted and left out.
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
interface Sample {
	arch: string;
	workload: string;
	arm: string;
	layout: string;
	wall: number;
	cpu: number;
	load: number;
	tries: number;
	dirty: boolean;
}
const samples: Sample[] = rows.map((c) => ({
	arch: c[0]!,
	workload: c[1]!,
	arm: c[2]!,
	layout: c[3]!,
	wall: Number(c[5]),
	cpu: Number(c[6]),
	load: Math.max(Number(c[9]), Number(c[10])),
	tries: Number(c[11]),
	dirty: c[12] === '1'
}));

const key = (s: Sample) => `${s.arch}\t${s.workload}`;
const groups = new Map<string, Sample[]>();
for (const s of samples) groups.set(key(s), [...(groups.get(key(s)) ?? []), s]);

const mean = (v: number[]) => v.reduce((a, b) => a + b, 0) / v.length;
console.log(
	['arch', 'workload', 'arm', 'wall', 'cpu', 'spread', 'vs off', 'r', 'samples', 'dirty', 'max load'].join('\t')
);
for (const [k, g] of groups) {
	const native = g.filter((s) => s.arm === 'native' && !s.dirty).map((s) => s.wall);
	const nativeWall = native.length ? Math.min(...native) : NaN;
	const arms = [...new Set(g.map((s) => s.arm))].filter((a) => a !== 'native');
	let offCpu = NaN;
	for (const arm of arms) {
		const a = g.filter((s) => s.arm === arm);
		const clean = a.filter((s) => !s.dirty);
		const layouts = [...new Set(clean.map((s) => s.layout))];
		const perLayout = layouts.map((l) => {
			const c = clean.filter((s) => s.layout === l);
			return { wall: Math.min(...c.map((s) => s.wall)), cpu: Math.min(...c.map((s) => s.cpu)) };
		});
		const wall = mean(perLayout.map((p) => p.wall));
		const cpu = mean(perLayout.map((p) => p.cpu));
		const cpus = perLayout.map((p) => p.cpu);
		const spread = (Math.max(...cpus) - Math.min(...cpus)) / cpu;
		if (arm === 'off') offCpu = cpu;
		console.log(
			[
				...k.split('\t'),
				arm,
				wall.toFixed(3),
				cpu.toFixed(3),
				`${(spread * 100).toFixed(1)}%`,
				arm === 'off' ? '-' : `${(((cpu - offCpu) / offCpu) * 100).toFixed(1)}%`,
				Number.isNaN(nativeWall) ? '-' : (wall / nativeWall).toFixed(0),
				clean.length,
				a.length - clean.length,
				Math.max(...a.map((s) => s.load)).toFixed(2)
			].join('\t')
		);
	}
	if (!Number.isNaN(nativeWall)) console.log([...k.split('\t'), 'native', nativeWall.toFixed(4)].join('\t'));
}
