import { describe, expect, it } from 'vitest';
import { report } from '../../experiments/string-kernels/scripts/report.ts';

const head =
	'arch\tworkload\tarm\tlayout\tround\twall\tcpu\tcore_ms\tsibling_ms\tload_before\tload_after\ttries\tdirty';
const row = (workload: string, arm: string, layout: number, wall: number, cpu: number) =>
	['x86_64', workload, arm, layout, 0, wall, cpu, 0, 0, 0.5, 0.5, 1, 0].join('\t');
const cells = (lines: string[], workload: string, arm: string) =>
	lines.map((l) => l.split('\t')).find((c) => c[1] === workload && c[2] === arm)!;

describe('string kernels report', () => {
	it('prints invalid for a workload whose guest failed at once', () => {
		const tsv = [
			head,
			row('tr', 'off', 0, 0.002, 0),
			row('tr', 'off', 1, 0.002, 0),
			row('tr', 'all', 0, 0.002, 0),
			row('tr', 'all', 1, 0.002, 0),
			row('tr', 'native', 0, 0.001, 0)
		].join('\n');
		const out = report(tsv);
		expect(cells(out, 'tr', 'off').slice(3, 8)).toEqual(['invalid', 'invalid', '-', '-', '-']);
		expect(cells(out, 'tr', 'all')[3]).toBe('invalid');
		expect(out.join('\n')).not.toMatch(/NaN|Infinity/);
	});

	it('reports a fast arm against a long off arm, and a zero-cpu spread without NaN', () => {
		const tsv = [
			head,
			row('copy', 'off', 0, 4, 4),
			row('copy', 'off', 1, 4.2, 4.2),
			row('copy', 'thunk', 0, 0.01, 0),
			row('copy', 'thunk', 1, 0.01, 0)
		].join('\n');
		const out = report(tsv);
		const thunk = cells(out, 'copy', 'thunk');
		expect(thunk[3]).toBe('0.010');
		expect(thunk[5]).toBe('-');
		expect(thunk[6]).toBe('-100.0%');
		expect(cells(out, 'copy', 'off')[5]).toBe('4.9%');
		expect(out.join('\n')).not.toMatch(/NaN|Infinity/);
	});

	it('keeps r and the vs-off column for a valid workload', () => {
		const tsv = [
			head,
			row('sort', 'off', 0, 8, 8),
			row('sort', 'off', 1, 8, 8),
			row('sort', 'all', 0, 6.4, 6.4),
			row('sort', 'all', 1, 6.4, 6.4),
			row('sort', 'native', 0, 0.02, 0.02)
		].join('\n');
		const all = cells(report(tsv), 'sort', 'all');
		expect(all.slice(3, 8)).toEqual(['6.400', '6.400', '0.0%', '-20.0%', '320']);
	});
});
