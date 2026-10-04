import { describe, expect, it } from 'vitest';
import { parse, verdict } from '../../experiments/aot-oracle/scripts/regs-table.ts';
import { floor, settle } from '../../experiments/katybug-profile/scripts/epoch-table.ts';

const line = (w: string, l: number, arm: string, runs: number[], md5: string, loads: number[]) => {
	const sorted = [...runs].sort((a, b) => a - b);
	const med = sorted[Math.floor(sorted.length / 2)]!;
	const spread = ((sorted[sorted.length - 1]! - sorted[0]!) * 100) / med;
	return `12:00:01 load1 1.00 | ${w} | ${l} | ${arm} | ${runs.join(' ')} | ${med} | ${spread.toFixed(1)}% | ${md5} | ${loads.join(' ')} |`;
};

describe('epoch table', () => {
	it('drops a run taken above the load limit and recomputes the row', () => {
		const rows = parse(line('a', 0, 'off', [100, 300, 102, 101, 103], 'x', [2, 5, 2, 3, 2]));
		expect(rows[0]!.loads).toEqual([2, 5, 2, 3, 2]);
		const { rows: kept, dropped } = settle(rows);
		expect(dropped).toBe(1);
		expect(kept[0]).toMatchObject({ runs: [100, 102, 101, 103], median: 102 });
		expect(kept[0]!.spread).toBeCloseTo(3 / 102);
	});

	it('keeps a row whose runs all sit above the limit rather than emptying it', () => {
		const rows = parse(line('a', 0, 'off', [100, 101, 102], 'x', [6, 6, 6]));
		expect(settle(rows).rows[0]!.runs).toHaveLength(3);
	});

	it('measures the build-noise floor as off at each layout over off at layout 0', () => {
		const rows = parse(
			[
				line('a', 0, 'off', [1000], 'x', [1]),
				line('a', 1, 'off', [1050], 'x', [1]),
				line('a', 2, 'off', [980], 'x', [1])
			].join('\n')
		);
		expect(floor(rows, 'off').map((f) => f.ratio)).toEqual([1.05, 0.98]);
	});

	it('judges on against off, and a native md5 that differs breaks exactness', () => {
		const text = [
			line('a', 0, 'off', [1000, 1000, 1000], 'x', [1, 1, 1]),
			line('a', 0, 'on', [900, 900, 900], 'x', [1, 1, 1]),
			line('a', 0, 'native', [0], 'x', [])
		].join('\n');
		expect(verdict(parse(text), 'on', 'off')).toMatchObject({ exact: true, earns: true });
		const wrong = text.replace(
			/\| native \| 0 \| 0 \| \w+% \| x/,
			'| native | 0 | 0 | 0.0% | y'
		);
		expect(wrong).not.toBe(text);
		expect(verdict(parse(wrong), 'on', 'off').exact).toBe(false);
	});
});
