import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
	evaluate,
	numbersIn,
	render,
	type Row
} from '../../experiments/aot-oracle/scripts/bash-ledger.ts';

let root = '';

beforeAll(() => {
	root = mkdtempSync(join(tmpdir(), 'bash-ledger-'));
	writeFileSync(join(root, 'package.json'), '{}');
	writeFileSync(join(root, 'src.md'), 'alpha 10 and 20 ms\nbeta count 4000 widgets\n');
});

afterAll(() => {
	rmSync(root, { recursive: true, force: true });
});

const base: Row = {
	id: 'base',
	host: 'v8',
	mechanism: 'baseline',
	unit: 'ms',
	status: 'measured',
	source: 'src.md',
	quote: 'beta count 4000 widgets',
	low: 4000,
	high: 4000,
	baseline: true
};

const good: Row = {
	id: 'good',
	host: 'v8',
	mechanism: 'two processes',
	unit: 'ms',
	status: 'measured',
	summed: true,
	source: 'src.md',
	quote: 'alpha 10 and 20 ms',
	low: 10,
	high: 20
};

describe('bash-ledger', () => {
	it('reproduces direct and derived rows and computes the remainder', () => {
		const double: Row = {
			id: 'double',
			host: 'v8',
			mechanism: 'x2',
			unit: 'ms',
			status: 'inferred',
			from: ['good'],
			op: 'mul',
			factor: 2,
			low: 20,
			high: 40
		};
		const ledger = evaluate([base, good, double], root);
		expect(ledger.failures).toEqual([]);
		expect(ledger.results.find((r) => r.row.id === 'double')).toMatchObject({
			low: 20,
			high: 40
		});
		expect(ledger.remainders).toEqual([
			expect.objectContaining({ host: 'v8', low: 3980, high: 3990 })
		]);
	});

	it('refuses a quote that is not in the source', () => {
		const row: Row = { ...good, id: 'miss', quote: 'gamma 5 ms', low: 5, high: 5 };
		expect(evaluate([row], root).failures).toEqual(['miss: quote not found in src.md']);
	});

	it('refuses a figure that the quote does not carry', () => {
		const row: Row = { ...good, id: 'wrong', low: 11 };
		expect(evaluate([row], root).failures).toEqual(['wrong: 11 not in quote']);
	});

	it('lists a row whose source file is missing as pending, not failed', () => {
		const row: Row = {
			id: 'pend',
			host: 'v8',
			mechanism: 'later',
			unit: 'ms',
			status: 'measured',
			source: 'missing/later-result.md',
			quote: 'x',
			low: 1,
			high: 1
		};
		const ledger = evaluate([row], root);
		expect(ledger.failures).toEqual([]);
		expect(ledger.results[0]!.pending).toBe('source missing: missing/later-result.md');
	});

	it('refuses a derived row that does not reproduce its stated figure', () => {
		const row: Row = {
			id: 'bad',
			host: 'v8',
			mechanism: 'x2',
			unit: 'ms',
			status: 'inferred',
			from: ['good'],
			op: 'mul',
			factor: 2,
			low: 21,
			high: 40
		};
		expect(evaluate([good, row], root).failures).toEqual([
			'bad: low recomputes to 20, states 21'
		]);
	});

	it('checks a derived quote against the rounded figure', () => {
		const row: Row = {
			id: 'q',
			host: 'v8',
			mechanism: 'x1',
			unit: 'ms',
			status: 'inferred',
			from: ['good'],
			op: 'mul',
			factor: 1,
			low: 10,
			high: 20,
			source: 'src.md',
			quote: 'beta count 4000 widgets'
		};
		expect(evaluate([good, row], root).failures).toEqual(['q: quote does not carry 10']);
	});

	it('refuses to sum two rows that name the same overlap', () => {
		const other: Row = { ...good, id: 'other', overlaps: ['good'] };
		expect(() => evaluate([good, other], root)).toThrow('overlaps: [good, other]');
	});

	it('finds the figures in a quote, with their decimals', () => {
		expect(numbersIn('0.009 x `int` 16,103 ms = 145 ms (5.9%)')).toEqual([
			{ n: 0.009, d: 3 },
			{ n: 16103, d: 0 },
			{ n: 145, d: 0 },
			{ n: 5.9, d: 1 }
		]);
	});

	it('renders a pending row and the remainder', () => {
		const pend: Row = {
			id: 'pend',
			host: 'v8',
			mechanism: 'later',
			unit: 'ms',
			status: 'pending',
			source: 'build/none.md'
		};
		const text = render(evaluate([base, good, pend], root));
		expect(text).toContain('- v8: 3,980 to 3,990 ms unattributed');
		expect(text).toContain('- pend: status is pending');
	});
});
