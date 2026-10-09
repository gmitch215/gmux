import { describe, expect, it } from 'vitest';
import { nativeReport, v8Report } from '../../experiments/string-kernels/scripts/hash-report.ts';
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

describe('hash report', () => {
	const nativeHead =
		'tool\tinput\tarm\tlayout\trep\twall\tcpu\tcore_ms\tsibling_ms\tload_before\tload_after\tdirty\tquiet_before\tquiet_after\tok\ttries';
	const nrow = (input: string, arm: string, layout: number, wall: number, quiet = 0.1, ok = 1) =>
		['md5sum', input, arm, layout, 0, wall, 0, 0, 0, 0, 0, 0, quiet, quiet, ok, 1].join('\t');

	it('reads r whole and net of start-up, spread, smoke samples and failed checks', () => {
		const tsv = [
			nativeHead,
			nrow('in0', 'native', 0, 0.001),
			nrow('in0', 'kernel', 0, 0.002),
			nrow('in64', 'native', 0, 0.064),
			nrow('in64', 'kernel', 0, 0.2),
			nrow('in64', 'kernel', 1, 0.22, 0.9),
			nrow('in64', 'kernel', 2, 0.2, 0.1, 0)
		].join('\n');
		const out = nativeReport(tsv);
		const kernel = out.find((l) => l.startsWith('| md5sum | in64 | kernel | 3'))!;
		expect(kernel).toContain('| 0.200 | 0.200-0.220 | 335.5 | 9.7% | 0.90 | 1 | 1 |');
		const r = out.find((l) => l.startsWith('| md5sum | in64 | kernel | 3.13'))!;
		expect(r).toContain('| 3.13 | 3.14 | 0.002 / 0.001 |');
		expect(out.join('\n')).not.toMatch(/NaN|Infinity/);
	});

	it('reads the machine samples net of the read floor, and prints - for a missing arm', () => {
		const vrow = (arm: string, tool: string, mib: number, ms: number) =>
			[arm, tool, mib, 0, ms, 0.1, 0.1, 1].join('\t');
		const tsv = [
			'arm\ttool\tmib\trep\tms\tquiet_before\tquiet_after\tok',
			vrow('gen-native', 'dd', 64, 50),
			vrow('gen-guest', 'dd', 64, 400),
			vrow('native', 'md5sum', 0, 5),
			vrow('native', 'md5sum', 64, 115),
			vrow('kernel', 'md5sum', 0, 100),
			vrow('kernel', 'md5sum', 64, 1000)
		].join('\n');
		const out = v8Report(tsv);
		expect(out.find((l) => l.startsWith('| md5sum | 64 | kernel'))).toBe(
			'| md5sum | 64 | kernel | 8.70 | 8.18 | 9.23 |'
		);
		expect(out.some((l) => l.startsWith('| md5sum | 1 |'))).toBe(false);
		expect(out.join('\n')).not.toMatch(/NaN|Infinity/);
	});
});
