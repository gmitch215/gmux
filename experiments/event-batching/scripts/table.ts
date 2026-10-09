import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

/**
 * The CPU table of time.sh: per workload and arm, the median of each run's medians with the range of
 * those run medians, the ring-on over ring-off ratio per run, and how many samples were kept, noisy
 * (quiet reading above 0.5) or failed.
 * `node --no-warnings --experimental-strip-types experiments/event-batching/scripts/table.ts <samples dir>`
 */
const dir = process.argv[2];
if (!dir) throw new Error('usage: table.ts <samples dir>');
type Sample = {
	workload: string;
	arm: 'on' | 'off';
	run: number;
	round: number;
	quiet: string;
	ok: number;
	out: { cpuMs: number; wallMs: number; consolePuts: number } | null;
};
const median = (xs: number[]) => {
	const s = [...xs].sort((a, b) => a - b);
	return s.length % 2 ? s[(s.length - 1) / 2]! : (s[s.length / 2 - 1]! + s[s.length / 2]!) / 2;
};
const noisy = (s: Sample) => Number(/([\d.]+)/.exec(s.quiet)?.[1] ?? 0) > 0.5;
const rows: string[] = [
	'| workload | arm | samples | noisy | failed | cpu ms (median of run medians) | run medians range | wall ms |',
	'| --- | --- | --- | --- | --- | --- | --- | --- |'
];
const ratios: string[] = ['| workload | on/off cpu per run | median | on/off wall per run | median |', '| --- | --- | --- | --- | --- |'];
for (const file of readdirSync(dir).filter((f) => f.endsWith('.jsonl')).sort()) {
	const all: Sample[] = readFileSync(join(dir, file), 'utf8')
		.split('\n')
		.filter((l) => l.startsWith('{'))
		.map((l) => JSON.parse(l));
	const workload = file.replace('.jsonl', '');
	const byArm = new Map<string, Map<number, { cpu: number[]; wall: number[] }>>();
	for (const arm of ['off', 'on']) {
		const kept = all.filter((s) => s.arm === arm && s.ok && s.out);
		const runs = new Map<number, { cpu: number[]; wall: number[] }>();
		for (const s of kept) {
			const r = runs.get(s.run) ?? { cpu: [], wall: [] };
			r.cpu.push(s.out!.cpuMs);
			r.wall.push(s.out!.wallMs);
			runs.set(s.run, r);
		}
		byArm.set(arm, runs);
		const cpu = [...runs.values()].map((r) => median(r.cpu));
		const wall = [...runs.values()].map((r) => median(r.wall));
		rows.push(
			`| ${workload} | ${arm} | ${kept.length} | ${kept.filter(noisy).length} | ${all.filter((s) => s.arm === arm && !s.ok).length} | ${cpu.length ? median(cpu).toFixed(1) : '-'} | ${cpu.length ? `${Math.min(...cpu).toFixed(1)}-${Math.max(...cpu).toFixed(1)}` : '-'} | ${wall.length ? median(wall).toFixed(1) : '-'} |`
		);
	}
	const on = byArm.get('on')!;
	const off = byArm.get('off')!;
	const shared = [...on.keys()].filter((r) => off.has(r)).sort((a, b) => a - b);
	const cpu = shared.map((r) => median(on.get(r)!.cpu) / median(off.get(r)!.cpu));
	const wall = shared.map((r) => median(on.get(r)!.wall) / median(off.get(r)!.wall));
	ratios.push(
		`| ${workload} | ${cpu.map((x) => x.toFixed(3)).join(', ')} | ${cpu.length ? median(cpu).toFixed(3) : '-'} | ${wall.map((x) => x.toFixed(3)).join(', ')} | ${wall.length ? median(wall).toFixed(3) : '-'} |`
	);
}
console.log(rows.join('\n'));
console.log();
console.log(ratios.join('\n'));
