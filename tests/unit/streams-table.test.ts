import { describe, expect, it } from 'vitest';
import { fit, streamsReport } from '../../experiments/serving/scripts/streams-table.ts';

const cell = (k: number, free: number, extra: object = {}) =>
	JSON.stringify({
		kernel: 'kern',
		workload: 'static',
		k,
		freeBoot: 30_000,
		freeSteady: free,
		ok: k,
		oom: null,
		tasks0: 50,
		tasks: 50 + 2 * k,
		freeAfterAbort: 20_000,
		...extra
	});

describe('streams table', () => {
	it('fits free memory against streams and reports the miss', () => {
		const { a, perStream, worst } = fit([
			[1, 19_000],
			[2, 18_000],
			[4, 16_000]
		]);
		expect(a).toBeCloseTo(20_000);
		expect(perStream).toBeCloseTo(1000);
		expect(worst).toBeCloseTo(0);
		const off = fit([
			[1, 19_000],
			[2, 17_000],
			[3, 19_000]
		]);
		expect(off.worst).toBeGreaterThan(0);
	});

	it('gives the drop per stream and a cap from the boot free memory and from the fit', () => {
		const out = streamsReport(
			[cell(0, 20_000, { ok: 0 }), cell(1, 19_000), cell(2, 18_000), cell(4, 16_000)].join(
				'\n'
			),
			4096
		).join('\n');
		expect(out).toContain('| 4 | 16000 | 4000 | 1000.0 | 4/4 | 8 | none | 20000 |');
		expect(out).toContain('1000.0 kB per stream, 20000 kB free at zero streams');
		expect(out).toContain('floor((20000 - 4096) / 1000.0) = 15');
		expect(out).toContain('floor((30000 - 4096) / 1000.0) = 25');
	});

	it('leaves a cell with a refused stream or an OOM kill out of the fit and lists it', () => {
		const out = streamsReport(
			[
				cell(1, 19_000),
				cell(2, 18_000),
				cell(8, 5_000, { ok: 6, oom: 'Out of memory' }),
				cell(12, 1_000, { shellDead: true }),
				JSON.stringify({ kernel: 'kern', workload: 'static', k: 16, failed: true })
			].join('\n')
		).join('\n');
		expect(out).toContain('| 8 | 5000 | - | - | 6/8 |');
		expect(out).toContain('Out of memory');
		expect(out).toContain('shell dead');
		expect(out).toContain('| 16 | cell failed |');
		expect(out).toContain('fit over k = 1, 2:');
	});
});
