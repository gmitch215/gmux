import { describe, expect, it } from 'vitest';
import {
	keep,
	paired,
	parseSamples,
	perfTable,
	remainder,
	render,
	sharesOf
} from '../../experiments/aot-oracle/scripts/floor-table.ts';

// host, workload, arm, process, round, attempt, ms, quiet, load1, rc
const row = (arm: string, round: string, ms: number, quiet = '0.00', attempt = 1, rc = 0) =>
	['x86', 'gzip', arm, 1, round, attempt, ms, quiet, '0.50', rc].join('\t');

function samples(rounds: Record<string, number[]>) {
	const lines: string[] = [];
	for (const [arm, ms] of Object.entries(rounds)) {
		lines.push(row(arm, 'warm', 999));
		ms.forEach((v, i) => lines.push(row(arm, String(i + 1), v)));
	}
	return lines.join('\n');
}

describe('floor table', () => {
	const text = samples({
		binary: [100, 100, 100],
		interp: [7000, 7000, 7000],
		'a0:0': [500, 520, 480],
		'a1:0': [300, 320, 280],
		'a2:0': [500, 520, 480],
		'a4:0': [250, 260, 240]
	});

	it('reads only the rows of its workload and architecture', () => {
		const mixed = `${text}\n${row('a0:0', '1', 1).replace('gzip', 'bzip2')}\n${row('a0:0', '1', 1).replace('x86', 'v8')}`;
		expect(parseSamples(mixed, 'gzip')).toHaveLength(parseSamples(text, 'gzip').length);
	});

	it('reads one host and one process, and takes a first run as the warm one', () => {
		const v8 = (proc: string, round: string, ms: number) =>
			['v8', 'gzip', 'a0:0', proc, round, 1, ms, '0.00', '0.50', 0]
				.join('\n')
				.replaceAll('\n', '\t');
		const mixed = [
			v8('1', 'first', 900),
			v8('1', '1', 500),
			v8('2', '1', 700),
			row('a0:0', '1', 1)
		].join('\n');
		expect(parseSamples(mixed, 'gzip', 'v8', '1')).toHaveLength(2);
		expect(parseSamples(mixed, 'gzip', 'v8')).toHaveLength(3);
		const kept = keep(parseSamples(mixed, 'gzip', 'v8', '1')).get('a0:0')!;
		expect(kept.warm).toBe(900);
		expect([...kept.ms]).toEqual([[1, 500]]);
	});

	it('keeps the first quiet attempt of a round and counts the noisy ones', () => {
		const kept = keep(
			parseSamples(
				[
					row('a0:0', '1', 900, '1.20', 1),
					row('a0:0', '1', 510, '0.10', 2),
					row('a0:0', '2', 520, '0.90', 1),
					row('a0:0', '2', 530, '0.80', 2),
					row('a0:0', '3', 0, '0.00', 1, 1)
				].join('\n'),
				'gzip'
			)
		).get('a0:0')!;
		expect([...kept.ms]).toEqual([[1, 510]]);
		expect(kept.noisy).toBe(3);
	});

	it('takes a ratio over the rounds both arms kept', () => {
		const kept = keep(parseSamples(`${text}\n${row('a0:0', '4', 600, '2.00')}`, 'gzip'));
		const r = paired(kept.get('a0:0')!, kept.get('binary')!, (x, y) => x / y)!;
		expect(r).toEqual({ median: 5, min: 4.8, max: 5.2, n: 3 });
	});

	it('gives the share of the as-built excess an arm removes, and what is left', () => {
		const kept = keep(parseSamples(text, 'gzip'));
		const [a0, bin] = [kept.get('a0:0')!, kept.get('binary')!];
		expect(sharesOf(kept.get('a1:0')!, a0, bin)!.median).toBeCloseTo(0.5, 5);
		expect(sharesOf(kept.get('a2:0')!, a0, bin)!.median).toBe(0);
		expect(remainder(kept.get('a4:0')!, a0, bin)!.median).toBeCloseTo(0.375, 5);
	});

	it('prints a4 beside the sum of its single arms and names the difference as interaction', () => {
		const names = new Map(
			['binary', 'interp', 'a0', 'a1', 'a2', 'a4'].map((n) => [
				n,
				n === 'binary' || n === 'interp' ? n : `${n}:0`
			])
		);
		const out = render(keep(parseSamples(text, 'gzip')), names);
		expect(out).toContain('| a1 | 50.0% (');
		expect(out).toContain(
			'a4 removes 62.5% against 50.0% for the sum of its single arms (a1 + a2)'
		);
		expect(out).toContain('12.5 points, is interaction');
		expect(out).toContain('a4 against the binary: 2.50');
		expect(out).toContain('(above 1.15)');
	});
});

describe('floor table perf rows', () => {
	it('takes medians of the quiet samples and divides by the guest instructions', () => {
		const csv = [
			'arm,round,quiet,instructions,cycles,branches,branch-misses',
			'a4,1,0.00,3000,1500,600,6',
			'a4,2,0.10,5000,2500,800,8',
			'a4,3,0.20,4000,2000,700,7',
			'a4,4,0.90,99999,9,9,9',
			'binary,1,-,1000,500,100,1'
		].join('\n');
		const out = perfTable(csv, 1000);
		expect(out).toContain('| a4 | 3 | 4.00 | 2.00 | 2.00 | 1.00% |');
		expect(out).toContain('| binary | 1 | 1.00 | 0.50 | 2.00 | 1.00% |');
	});
});
