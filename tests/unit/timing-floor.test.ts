import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
	parse,
	quantile,
	report,
	summarize,
	verdicts
} from '../../experiments/timing-floor/scripts/table.ts';

const tsv = readFileSync(new URL('../fixtures/timing-floor-samples.tsv', import.meta.url), 'utf8');

describe('timing-floor table', () => {
	it('parses every sample row', () => {
		const samples = parse(tsv);
		expect(samples).toHaveLength(24);
		expect(samples[0]).toMatchObject({ cond: 'base', cell: 'comp', arm: 'A', rc: 0 });
	});

	it('uses type 7 quantiles', () => {
		expect(quantile([1, 2, 3, 4], 0.5)).toBe(2.5);
		expect(quantile([1, 2, 3, 4], 0.25)).toBe(1.75);
	});

	it('takes the median of per-round ratios and their spread', () => {
		const base = summarize(parse(tsv)).find((r) => r.cond === 'base' && r.cell === 'comp')!;
		expect(base.rounds).toBe(3);
		expect(base.median).toBeCloseTo(1, 9);
		expect(base.min).toBeCloseTo(0.998, 9);
		expect(base.max).toBeCloseTo(1.004, 9);
		expect(base.iqr).toBeCloseTo(0.003, 9);
		expect(base.beyond1).toBe(0);
		expect(base.ok).toBe(true);
	});

	it('marks a condition whose median ratio is off by more than 0.9%', () => {
		const same = summarize(parse(tsv)).find((r) => r.cond === 'same' && r.cell === 'comp')!;
		expect(same.median).toBeCloseTo(1.03, 9);
		expect(same.beyond1).toBe(1);
		expect(same.ok).toBe(false);
	});

	it('gives one verdict per condition', () => {
		const v = verdicts(summarize(parse(tsv)));
		expect(v.get('base')).toBe(true);
		expect(v.get('same')).toBe(false);
		expect(report(tsv)).toContain('verdict same: not acceptable');
	});
});
