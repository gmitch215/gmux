import { describe, expect, it } from 'vitest';
import { zlibReport } from '../../experiments/library-thunks/scripts/zlib-table.ts';

const head = 'arm\top\titers\trep\tms\tquiet_before\tquiet_after\tok\tdigest\tstatus';
const row = (arm: string, ms: number, q0 = 0.1, ok = 1) =>
	[arm, 'crc', 100, 0, ms, q0, 0.1, ok, 'crc 100 1', arm === 'native' ? '-' : 0].join('\t');

describe('zlib table', () => {
	it('gives r against native and counts smoke and failed samples', () => {
		const tsv = [
			head,
			row('native', 60),
			row('native', 70),
			row('kernel', 130),
			row('kernel', 150, 0.9),
			row('off', 6000, 0.1, 0)
		].join('\n');
		const out = zlibReport(tsv);
		expect(out).toContain('| crc | 100 | native | 2 | 0.070 | 1.17 | 0.10 | 0 | 0 |');
		expect(out).toContain('| crc | 100 | kernel | 2 | 0.150 | 1.15 | 0.90 | 1 | 0 |');
		expect(out).toContain('| crc | 100 | off | 1 | 6.000 | 1.00 | 0.10 | 0 | 1 |');
		expect(out).toContain('| crc | kernel | 2.14 |');
		expect(out).toContain('| crc | off | 85.71 |');
	});

	it('prints no r for an arm without a native sample', () => {
		const out = zlibReport([head, row('kernel', 100)].join('\n'));
		expect(out.join('\n')).not.toMatch(/NaN|Infinity/);
		expect(out.filter((l) => l.startsWith('| crc | kernel | '))).toEqual([]);
	});
});
