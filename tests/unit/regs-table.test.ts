import { describe, expect, it } from 'vitest';
import { compare, parse, verdict } from '../../experiments/aot-oracle/scripts/regs-table.ts';

const log = (rows: [string, number, string, number, number, string][]) =>
	[
		'# start',
		'12:00:00 load1 1.00 | workload | layout | arm | ms per run | median ms | spread | output md5 | load1 after each run |',
		'12:00:00 load1 1.00 | --- | --- | --- | --- | --- | --- | --- | --- |',
		...rows.map(
			([w, l, arm, med, spread, md5]) =>
				`12:00:01 load1 1.00 | ${w} | ${l} | ${arm} | ${med} ${med} ${med} | ${med} | ${spread}% | ${md5} | 1.0 1.0 1.0 |`
		),
		'# end'
	].join('\n');

describe('regs table', () => {
	const faster = parse(
		log([
			['a', 0, 'regs=0', 1000, 1, 'x'],
			['a', 0, 'regs=1', 900, 1, 'x'],
			['b', 0, 'regs=0', 2000, 1, 'y'],
			['b', 0, 'regs=1', 1800, 1, 'y']
		])
	);

	it('reads rows and skips the header and the lock lines', () => {
		expect(faster).toHaveLength(4);
		expect(faster[1]).toMatchObject({
			workload: 'a',
			layout: 0,
			arm: 'regs=1',
			median: 900,
			spread: 0.01,
			md5: 'x'
		});
	});

	it('compares an arm with regs=0 per workload and layout', () => {
		expect(compare(faster, 'regs=1').map((c) => c.ratio)).toEqual([0.9, 0.9]);
	});

	it('gives the default to an arm that is exact and faster beyond the spread', () => {
		expect(verdict(faster, 'regs=1')).toMatchObject({ exact: true, earns: true, slower: [] });
	});

	it('refuses an arm inside the spread, a slower workload, or a different output', () => {
		const inside = parse(
			log([
				['a', 0, 'regs=0', 1000, 5, 'x'],
				['a', 0, 'regs=1', 980, 5, 'x']
			])
		);
		expect(verdict(inside, 'regs=1').earns).toBe(false);
		const slower = parse(
			log([
				['a', 0, 'regs=0', 1000, 1, 'x'],
				['a', 0, 'regs=1', 700, 1, 'x'],
				['b', 0, 'regs=0', 1000, 1, 'y'],
				['b', 0, 'regs=1', 1100, 1, 'y']
			])
		);
		expect(verdict(slower, 'regs=1')).toMatchObject({ earns: false, slower: ['b/0'] });
		const wrong = parse(
			log([
				['a', 0, 'regs=0', 1000, 1, 'x'],
				['a', 0, 'regs=1', 700, 1, 'z']
			])
		);
		expect(verdict(wrong, 'regs=1')).toMatchObject({ exact: false, earns: false });
	});
});
