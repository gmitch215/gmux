import { describe, expect, it } from 'vitest';
import { keep, parseSamples } from '../../experiments/aot-oracle/scripts/floor-table.ts';
import { pool, poolShare, render } from '../../experiments/aot-oracle/scripts/gap-split.ts';

// host, workload, arm, process, round, attempt, ms, quiet, load1, rc
const row = (host: string, proc: string, arm: string, round: number, ms: number) =>
	[host, 'gzip', arm, proc, String(round), 1, ms, '0.00', '0.50', 0].join('\t');

function samples(host: string, proc: string, ms: Record<string, number>, rounds = 3) {
	const lines: string[] = [];
	for (let r = 1; r <= rounds; r++)
		for (const [arm, t] of Object.entries(ms)) lines.push(row(host, proc, arm, r, t));
	return lines;
}

const x86 = samples('x86', '1', {
	binary: 100,
	interp: 7000,
	'a0:0': 400,
	'a1:0': 160,
	'a1w:0': 170
});
const def = (p: string) => samples('v8', p, { binary: 100, int: 9000, 'a0:0': 800, 'a1:0': 340 });
const nb = samples('v8', 'nb', { binary: 100, 'a0:0': 720, 'a1:0': 340 });
const nl = samples('v8', 'nl', { binary: 100, 'a0:0': 800, 'a1:0': 340 });
const text = [...x86, ...def('1'), ...def('2'), ...nb, ...nl].join('\n');

describe('gap split', () => {
	it('pools the processes against their own binary', () => {
		const procs = ['1', '2'].map((p) => keep(parseSamples(text, 'gzip', 'v8', p)));
		const r = pool(procs, 'a0:0')!;
		expect(r).toMatchObject({ r: 8, min: 8, max: 8 });
		expect(r.procs).toEqual([8, 8]);
		expect(poolShare(procs, 'a1:0', 'a0:0')!.median).toBeCloseTo((800 - 340) / 700, 5);
	});

	it('splits the gap into bounds checks, tier-up and the rest', () => {
		const out = render(text, 'gzip', { a0: 'a0', a1: 'a1', forms: [], xw: 'a1w' });
		expect(out).toContain(
			'| a0 | 4.00 (4.00 to 4.00) | 8.00 (8.00 to 8.00) | 2.00 (2.00 to 2.00) |'
		);
		expect(out).toContain(
			"| a1 / a1' | 1.70 (1.70 to 1.70) | 3.40 (3.40 to 3.40) | 2.00 (2.00 to 2.00) |"
		);
		expect(out).toContain('| gap | 4.00 (4.00 to 4.00) | 1.70 (1.70 to 1.70) |');
		expect(out).toContain(
			"| bounds checks (default minus no checks; the default is the engine's own choice) | 0.80 (0.80 to 0.80), 20% of the gap |"
		);
		expect(out).toContain(
			'| tier-up (default minus --no-liftoff) | 0.00 (0.00 to 0.00), 0% of the gap |'
		);
		expect(out).toContain('1.70, 100% of the gap');
	});

	it('leaves a diagnostic that was not run as n/a', () => {
		const out = render([...x86, ...def('1'), ...def('2')].join('\n'), 'gzip', {
			a0: 'a0',
			a1: 'a1',
			forms: [],
			xw: 'a1w'
		});
		expect(out).toContain(
			'| explicit checks (enforced minus default; not the default) | n/a | n/a |'
		);
	});
});
