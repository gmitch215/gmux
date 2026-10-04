import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { follow, type Ins } from '../../experiments/aot-oracle/scripts/bounds.ts';
import { opNumbers } from '../../experiments/aot-oracle/scripts/functions.ts';

const header = readFileSync('src/gmux/katybug/kb.h', 'utf8');
const op = opNumbers(header);
const ins = (name: string, a = 0, b = 0, c = 0, imm = 0n, w = 8): Ins => ({
	op: op[name]!,
	w,
	a,
	b,
	c,
	imm
});
const AE = 3n;
const BELOW = 2n;
// an exit on a condition, to a pc 16 bytes on
const exit = (cond: bigint) => ins('EXIT', 0, 0, 0, cond | (16n << 16n));
const cmp = (b: number, c: number) => ins('FLAGS', 32, b, c, 1n);

// rdi plus an index in rcx, scaled by 8: the address is built in temporaries the way the decoder does
const address = (index: number) => [
	ins('MOVI', 34, 0, 0, 3n),
	ins('SHL', 35, index, 34),
	ins('ADD', 36, 7, 35)
];
const load = ins('LD', 8, 36, 0, 0n);

describe('follow', () => {
	it('keeps the lifter original without bounds: a base and a constant only', () => {
		const code = [ins('ADD', 36, 7, 1), ins('LD', 8, 36, 0, 0n), ins('LD', 9, 7, 0, 24n)];
		expect(follow(code, op, false)).toEqual([
			{ i: 2, store: false, w: 8, root: 7, lo: 24n, hi: 24n }
		]);
	});

	it('bounds an index by a mask, through the scale', () => {
		const code = [ins('MOVI', 32, 0, 0, 0xffn), ins('AND', 33, 1, 32), ...address(33), load];
		expect(follow(code, op, false)).toEqual([]);
		expect(follow(code, op, true)).toEqual([
			{ i: 5, store: false, w: 8, root: 7, lo: 0n, hi: 2040n }
		]);
	});

	it('does not take a mask loaded from memory for a bound', () => {
		const code = [ins('LD', 32, 5, 0, 0n), ins('AND', 33, 1, 32), ...address(33), load];
		expect(follow(code, op, true).filter((f) => f.root === 7)).toEqual([]);
	});

	it('bounds a byte read from memory by 255, and a zero extension by its width', () => {
		const byte = [ins('LD', 33, 5, 0, 0n, 1), ...address(33), load];
		expect(follow(byte, op, true).filter((f) => f.root === 7)).toEqual([
			{ i: 4, store: false, w: 8, root: 7, lo: 0n, hi: 2040n }
		]);
		const word = [ins('ZEXT', 33, 1, 0, 0n, 4), ...address(33), load];
		expect(follow(word, op, true).filter((f) => f.root === 7)).toEqual([
			{ i: 4, store: false, w: 8, root: 7, lo: 0n, hi: 0xffffffffn << 3n }
		]);
	});

	it('takes a constant added to an index and a window from a constant base', () => {
		const code = [
			ins('MOVI', 32, 0, 0, 3n),
			ins('AND', 33, 1, 32),
			ins('MOVI', 34, 0, 0, 3n),
			ins('SHL', 35, 33, 34),
			ins('LD', 8, 35, 0, 0x1000n)
		];
		expect(follow(code, op, true)).toEqual([
			{ i: 4, store: false, w: 8, root: -1, lo: 0x1000n, hi: 0x1018n }
		]);
	});

	it('bounds an index by a compare the trace did not leave on, from there on only', () => {
		const before = ins('LD', 8, 36, 0, 0n);
		const code = [
			ins('MOVI', 33, 0, 0, 100n),
			...address(1),
			before,
			cmp(1, 33),
			exit(AE),
			...address(1),
			ins('LD', 9, 36, 0, 0n)
		];
		const found = follow(code, op, true);
		expect(found.map((f) => [f.i, f.lo, f.hi])).toEqual([[10, 0n, 792n]]);
		expect(follow(code, op, false)).toEqual([]);
	});

	it('learns nothing from an exit on the other side of the compare', () => {
		const code = [ins('MOVI', 33, 0, 0, 100n), cmp(1, 33), exit(BELOW), ...address(1), load];
		expect(follow(code, op, true)).toEqual([]);
	});

	it('drops a compare that something else overwrote the flags after', () => {
		const code = [
			ins('MOVI', 33, 0, 0, 100n),
			cmp(1, 33),
			ins('FLAGS', 32, 1, 33, 0n),
			exit(AE),
			...address(1),
			load
		];
		expect(follow(code, op, true)).toEqual([]);
	});

	it('reads kb.h: a compare is the second flag kind', () => {
		const body = header.match(/enum kb_fk\s*\{([\s\S]*?)\};/)![1]!;
		const kinds = body
			.replace(/\/\*[\s\S]*?\*\//g, '')
			.split(',')
			.map((s) => s.trim())
			.filter(Boolean);
		expect(kinds[1]).toBe('KB_F_SUB');
	});
});
