import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
	ending,
	functions,
	opNumbers,
	parse,
	rangesOf,
	splitRanges,
	type Block,
	type Ins
} from '../../experiments/aot-oracle/scripts/functions.ts';

const op = opNumbers(readFileSync('src/gmux/katybug/kb.h', 'utf8'));
const T1 = 33;
const T5 = 37;
const ins = (name: string, a = 0, b = 0, c = 0, imm = 0n): Ins => ({
	op: op[name]!,
	w: 8,
	a,
	b,
	c,
	imm
});
const call = (to: bigint, back: bigint) => [
	ins('MOVI', T1, 0, 0, back),
	ins('ST', T1, 4),
	ins('MOVI', T5, 0, 0, to),
	ins('JMP', 0, T5)
];
const ret = [ins('LD', T1, 4), ins('JMP', 0, T1)];
const block = (pc: bigint, next: bigint, runs: bigint, body: Ins[], target = 0n): Block => ({
	pc,
	next,
	target,
	runs,
	ins: body
});

// main calls f twice; f loops and calls g; g and f return
const blocks = [
	block(0x1000n, 0x1010n, 1n, call(0x2000n, 0x1010n)),
	block(0x1010n, 0x1020n, 1n, call(0x2000n, 0x1020n)),
	block(0x1020n, 0x1021n, 1n, ret),
	block(0x2000n, 0x2010n, 100n, [ins('ADD', 1, 1, 2), ins('BR')], 0x2000n),
	block(0x2010n, 0x2020n, 2n, call(0x3000n, 0x2020n)),
	block(0x2020n, 0x2021n, 2n, ret),
	block(0x3000n, 0x3001n, 2n, ret)
];

describe('functions', () => {
	it('tells a call, a return, a branch and a jump apart', () => {
		expect(blocks.map((b) => ending(b, op))).toEqual([
			'call',
			'call',
			'ret',
			'branch',
			'call',
			'ret',
			'ret'
		]);
		const jump = block(0x4000n, 0x4010n, 1n, [
			ins('MOVI', T5, 0, 0, 0x4100n),
			ins('JMP', 0, T5)
		]);
		expect(ending(jump, op)).toBe('jump');
		const indirect = block(0x4000n, 0x4010n, 1n, [
			ins('MOVI', T1, 0, 0, 0x4010n),
			ins('ST', T1, 4),
			ins('JMP', 0, 9)
		]);
		expect(ending(indirect, op)).toBe('indirect-call');
	});

	it('partitions blocks by the call targets that reach them, ranked by their own ops', () => {
		const fns = functions(blocks, op, 0x1000n);
		expect(fns.map((f) => f.entry)).toEqual([0x2000n, 0x1000n, 0x3000n]);
		const f = fns[0]!;
		expect(f.blocks.map((b) => b.pc).sort()).toEqual([0x2000n, 0x2010n, 0x2020n]);
		expect(f.self).toBe(100n * 2n + 2n * 4n + 2n * 2n);
		expect(f.calls).toBe(2n);
		expect([...f.callees]).toEqual([[0x3000n, 2n]]);
		expect(fns[1]!.callees.get(0x2000n)).toBe(2n);
	});

	it('merges a function and its hot callees into ranges for the lifter', () => {
		const fns = functions(blocks, op, 0x1000n);
		const total = blocks.reduce((s, b) => s + b.runs * BigInt(b.ins.length), 0n);
		expect(rangesOf(fns, total, 0)).toBe('0x2000-0x2021');
		expect(rangesOf(fns, total, 0, true, 0)).toBe('0x2000-0x2021,0x3000-0x3001');
		expect(rangesOf(fns, total, 0, true, 0.5)).toBe('0x2000-0x2021');
	});

	it('splits a function and its hot callees into one ranges text each, the root first', () => {
		const fns = functions(blocks, op, 0x1000n);
		const total = blocks.reduce((s, b) => s + b.runs * BigInt(b.ins.length), 0n);
		expect(splitRanges(fns, total, 0, 0)).toEqual(['0x2000-0x2021', '0x3000-0x3001']);
		expect(splitRanges(fns, total, 0, 0, 0)).toEqual(['0x2000-0x2021']);
		expect(splitRanges(fns, total, 0, 0.5)).toEqual(['0x2000-0x2021']);
	});

	it('reads the dump format the interpreter writes', () => {
		const text =
			'arch 0\nblock 10 20 30 2 7\n0 8 33 0 0 5\n8 8 0 37 0 0\nexits 1:3\nblock 20 21 0 1 1\n8 8 0 33 0 0\n';
		const got = parse(text);
		expect(got.map((b) => [b.pc, b.next, b.target, b.runs, b.ins.length])).toEqual([
			[0x10n, 0x20n, 0x30n, 7n, 2],
			[0x20n, 0x21n, 0n, 1n, 1]
		]);
		expect(got[0]!.ins[0]).toEqual({ op: 0, w: 8, a: 33, b: 0, c: 0, imm: 5n });
	});
});
