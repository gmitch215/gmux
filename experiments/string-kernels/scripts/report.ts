import { readFileSync } from 'node:fs';

/**
 * Reads run.sh's samples.tsv: a layout's time is the minimum over its rounds' clean samples, an arm's
 * is the mean over layouts, spread = (slowest - fastest layout) / mean. r is the arm's wall over the
 * native run's fastest wall (x86-64 guests on an x86-64 host). Dirty samples (a process shared the
 * core after every try) are counted and left out. A workload whose off arm runs under INVALID_WALL
 * seconds did no real work (a guest that failed at once): its cells read "invalid". An arm that is
 * fast against a long off arm is a result, not an invalid cell.
 * `node --experimental-strip-types report.ts <samples.tsv>`
 */
export const INVALID_WALL = 0.05;

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

const mean = (v: number[]) => v.reduce((a, b) => a + b, 0) / v.length;

/** the report's tab-separated lines for the text of a samples.tsv */
export function report(tsv: string): string[] {
	const samples: Sample[] = tsv
		.trim()
		.split('\n')
		.slice(1)
		.map((l) => l.split('\t'))
		.map((c) => ({
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

	const lines = [
		['arch', 'workload', 'arm', 'wall', 'cpu', 'spread', 'vs off', 'r', 'samples', 'dirty', 'max load'].join('\t')
	];
	for (const [k, g] of groups) {
		const native = g.filter((s) => s.arm === 'native' && !s.dirty).map((s) => s.wall);
		const nativeWall = native.length ? Math.min(...native) : NaN;
		const arms = [...new Set(g.map((s) => s.arm))].filter((a) => a !== 'native');
		let offCpu = NaN;
		const off = g.filter((s) => s.arm === 'off' && !s.dirty).map((s) => s.wall);
		const offShort = off.length > 0 && mean(off) < INVALID_WALL;
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
			const tail = [
				clean.length,
				a.length - clean.length,
				Math.max(...a.map((s) => s.load)).toFixed(2)
			];
			if (wall < INVALID_WALL && offShort) {
				lines.push([...k.split('\t'), arm, 'invalid', 'invalid', '-', '-', '-', ...tail].join('\t'));
				continue;
			}
			lines.push(
				[
					...k.split('\t'),
					arm,
					wall.toFixed(3),
					cpu.toFixed(3),
					Number.isNaN(spread) ? '-' : `${(spread * 100).toFixed(1)}%`,
					arm === 'off' || !(offCpu > 0) ? '-' : `${(((cpu - offCpu) / offCpu) * 100).toFixed(1)}%`,
					Number.isNaN(nativeWall) ? '-' : (wall / nativeWall).toFixed(0),
					...tail
				].join('\t')
			);
		}
		if (!Number.isNaN(nativeWall)) lines.push([...k.split('\t'), 'native', nativeWall.toFixed(4)].join('\t'));
	}
	return lines;
}

if (import.meta.main ?? process.argv[1]?.endsWith('report.ts')) {
	const path = process.argv[2];
	if (!path) {
		console.error('usage: report.ts <samples.tsv>');
		process.exit(2);
	}
	console.log(report(readFileSync(path, 'utf8')).join('\n'));
}
