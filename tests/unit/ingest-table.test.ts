import { describe, expect, it } from 'vitest';
import { ingestReport } from '../../experiments/serving/scripts/ingest-table.ts';

const sample = (mib: number, run: number, cpu: number, quiet = 'outside_busy 0.10', ok = 1) =>
	JSON.stringify({ mib, run, quiet, ok, out: { cpuMs: { mean: cpu } } });

describe('ingest table', () => {
	it('fits CPU against body size and bounds the body by the budget', () => {
		const out = ingestReport(
			[
				sample(1, 1, 6),
				sample(1, 2, 7),
				sample(1, 3, 6.5),
				sample(8, 1, 41),
				sample(8, 2, 42),
				sample(8, 3, 43),
				sample(32, 1, 161),
				sample(32, 2, 160),
				sample(32, 3, 162)
			].join('\n'),
			1000,
			2
		).join('\n');
		expect(out).toContain('| 1 | 3 | 6.000, 7.000, 6.500 | 6.500 | 6.500 | 0 |');
		expect(out).toContain('| 32 | 3 | 161.000, 160.000, 162.000 | 161.000 | 5.031 | 0 |');
		const [, slope, base] = /fit: ([\d.]+) ms per MiB, ([\d.]+) ms per request/.exec(out)!;
		expect(Number(slope)).toBeCloseTo(5.0, 0);
		expect(Number(base)).toBeCloseTo(1.5, 0);
		const bound = Math.floor((500 - Number(base)) / Number(slope));
		expect(out).toContain(`= ${bound} MiB`);
	});

	it('lists a smoke sample and a failed one apart from the fit', () => {
		const out = ingestReport(
			[
				sample(1, 1, 6),
				sample(1, 2, 90, 'outside_busy 0.90'),
				sample(8, 1, 41),
				sample(8, 2, 5000, 'outside_busy 0.10', 0)
			].join('\n')
		).join('\n');
		expect(out).toContain('| 1 | 1 | 6.000, 90.000 | 6.000 | 6.000 | 1 |');
		expect(out).toContain('| 8 | 1 | 41.000 | 41.000 | 5.125 | 0 |');
	});
});
