import { describe, expect, it } from 'vitest';
import {
	parseCounts,
	parseNative,
	parseWasm,
	table
} from '../../experiments/aot-oracle/scripts/region-table.ts';

const counts = parseCounts(
	[
		'workload,arm,regs,output,insns,rd,wr,lifted,entries,peak_rss_kib',
		'gzip,fnc,0,exact,741973415,115.1,549.7,80.0%,180,6336',
		'gzip,all,0,abcd1234 DIFFERS from 00000000,1,1,1,99.0%,1,1'
	].join('\n')
);

describe('region table', () => {
	it('keeps only the arms whose output was exact', () => {
		expect([...counts.keys()]).toEqual(['fnc:0']);
		expect(counts.get('fnc:0')).toEqual({ lifted: 0.8, entries: 180 });
	});

	it('reads the rows both timing scripts print, stamps and all', () => {
		const native = [
			'| arm | ms per run | median ms | spread | r | load1 per run |',
			'| --- | --- | --- | --- | --- | --- |',
			'| binary | 60 61 | 60 | 1.6% | 1.00 | 1.0 1.1 |',
			'| interp | 5900 5910 | 5900 | 0.2% | 98.33 | 1.0 1.1 |',
			'| fnc:0 | 1000 1010 | 1000 | 1.0% | 16.67 | 1.0 1.1 |'
		].join('\n');
		expect(parseNative(native).map((r) => [r.arm, r.ms])).toEqual([
			['binary', 60],
			['interp', 5900],
			['fnc:0', 1000]
		]);
		const wasm =
			'21:24:24 load1 3.13 | gzip | fnc:0 | 4200 | 3100 3120 3110 | 3110 | 0.6% | 1b2c3d4e | 1.0 1.0 1.0 | 900, 950 |';
		expect(parseWasm(wasm)).toEqual([{ arm: 'fnc:0', first: 4200, ms: 3110 }]);
	});

	it('gives the lifted part its own multiplier, from the interpreted share it leaves out', () => {
		// 20% interpreted at 5900 ms is 1180 ms; the rest of 1000 ms is not there, so use a slower arm
		const rows = [
			{ arm: 'interp', ms: 5900 },
			{ arm: 'fnc:0', ms: 1180 + 80 * 6, first: 1180 + 80 * 12 }
		];
		const [, line] = table(rows, counts, 60);
		expect(line!.r).toBeCloseTo((1180 + 480) / 60);
		expect(line!.c).toBeCloseTo(480 / (0.8 * 60));
		expect(line!.cFirst).toBeCloseTo(960 / (0.8 * 60));
		expect(table(rows, counts, null)[1]!.c).toBeNull();
	});
});
