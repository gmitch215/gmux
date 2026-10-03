import { describe, expect, it } from 'vitest';
import {
	analyze,
	symbolic,
	vecWrite,
	type BlockIn,
	type Env,
	type Ins
} from '../../experiments/aot-oracle/scripts/slots.ts';

const NAMES = [
	'MOVI',
	'MOV',
	'ADD',
	'SUB',
	'LD',
	'LDS',
	'ST',
	'BR',
	'JMP',
	'SYSCALL',
	'SSE',
	'EXIT',
	'ZEXT',
	'BRZ',
	'XOR'
];
const op = Object.fromEntries(NAMES.map((n, k) => [n, k])) as Record<string, number>;
const SP = 4;
const T5 = 37;
const env: Env = {
	name: (o) => NAMES[o]!,
	rw: (x) =>
		['MOVI', 'MOV', 'ADD', 'SUB', 'LD', 'LDS', 'ZEXT', 'XOR'].includes(NAMES[x.op]!)
			? { r: [], w: [x.a] }
			: { r: [], w: [] },
	sp: SP,
	zero: 63,
	span: 4080,
	maxSlots: 12
};
const ins = (name: string, w = 8, a = 0, b = 0, c = 0, imm = 0n): Ins => ({
	op: op[name]!,
	w,
	a,
	b,
	c,
	imm
});
const block = (pc: bigint, next: bigint, target: bigint, runs: number, list: Ins[]): BlockIn => ({
	pc,
	next,
	target,
	runs: BigInt(runs),
	ins: list
});
const bump = (d: number) => [
	ins('MOVI', 8, T5, 0, 0, BigInt(Math.abs(d))),
	ins(d < 0 ? 'SUB' : 'ADD', 8, SP, SP, T5)
];
const index = (blocks: BlockIn[]) => new Map(blocks.map((b, j) => [b.pc, j]));

describe('stack slot analysis', () => {
	it('follows rsp through a push, a lea into a temporary and a pop', () => {
		const b = block(0x10n, 0x20n, 0n, 1, [
			...bump(-8),
			ins('ST', 8, 0, SP, 0, 0n),
			ins('ADD', 8, 40, SP, T5),
			ins('LD', 8, 1, 40, 0, 8n),
			...bump(8)
		]);
		const s = symbolic(b, env);
		expect([...s.acc.values()]).toEqual([
			{ off: -8, len: 8, kind: 'st' },
			{ off: -8 + 8 + 8, len: 8, kind: 'ld' }
		]);
		expect(s.exits).toEqual([{ i: -1, to: 0x20n, d: 0 }]);
	});

	it('gives up on rsp after an unknown write and on a base that is not rsp', () => {
		const b = block(0x10n, 0x20n, 0n, 1, [
			ins('LD', 8, 1, 5, 0, 8n),
			ins('XOR', 8, SP, SP, 1),
			ins('LD', 8, 2, SP, 0, 0n)
		]);
		const s = symbolic(b, env);
		expect(s.acc.size).toBe(0);
		expect(s.exits[0]!.d).toBeNull();
	});

	it('reads a jump to a constant as an edge', () => {
		const b = block(0x10n, 0x20n, 0x30n, 1, [
			ins('MOVI', 8, T5, 0, 0, 0x30n),
			ins('JMP', 8, 0, T5)
		]);
		expect(symbolic(b, env).exits).toEqual([{ i: 1, to: 0x30n, d: 0 }]);
	});

	// head loads a slot, the body between does not touch it, the loop closes with a branch
	const loop = () => [
		block(0x10n, 0x20n, 0n, 100, [ins('LD', 8, 1, SP, 0, 8n), ins('BR', 8, 0, 0, 0, 4n)]),
		block(0x20n, 0x10n, 0x10n, 100, [ins('XOR', 8, 2, 2, 2), ins('BR', 8, 0, 0, 0, 4n)])
	];

	it('puts a loop in one frame and passes a slot through the block that leaves it alone', () => {
		const blocks = loop();
		const plan = analyze(blocks, index(blocks), env);
		expect(plan.promoted).toEqual([true, true]);
		expect(plan.comp[0]).toBe(plan.comp[1]);
		expect(plan.slots).toHaveLength(1);
		expect(plan.need[0]).toEqual([0]);
		expect(plan.need[1]).toEqual([0]);
		expect(plan.edge(1, 0, 0)).toBe('carry');
	});

	it('does not pass a slot through a block that stores over part of it', () => {
		const blocks = loop();
		blocks[1]!.ins.unshift(ins('ST', 1, 0, SP, 0, 10n));
		const plan = analyze(blocks, index(blocks), env);
		expect(plan.need[1]).toEqual([]);
		expect(plan.need[0]).toEqual([0]);
	});

	it('starts a new frame when rsp moves differently on two edges into a block', () => {
		const a = block(0x10n, 0x20n, 0x30n, 100, [
			ins('LD', 8, 1, SP, 0, 8n),
			ins('BR', 8, 0, 0, 0, 4n)
		]);
		const b = block(0x20n, 0x30n, 0n, 90, [...bump(-8)]);
		const c = block(0x30n, 0n, 0n, 100, [
			ins('LD', 8, 1, SP, 0, 8n),
			ins('MOVI', 8, T5, 0, 0, 0x10n),
			ins('JMP', 8, 0, T5)
		]);
		const blocks = [a, b, c];
		const plan = analyze(blocks, index(blocks), env);
		const to30 = plan.sym[0]!.exits.find((e) => e.to === 0x30n)!;
		const via20 = plan.sym[1]!.exits[0]!;
		expect(plan.edge(0, 2, to30.d)).toBe('carry');
		expect(plan.edge(1, 2, via20.d)).toBe('stub');
	});

	it('keeps a block with a syscall out and sends edges into promoted blocks through their stubs', () => {
		const a = block(0x10n, 0x20n, 0n, 100, [ins('LD', 8, 1, SP, 0, 8n)]);
		const sys = block(0x20n, 0x10n, 0n, 100, [ins('SYSCALL', 8)]);
		const blocks = [a, sys];
		const plan = analyze(blocks, index(blocks), env);
		expect(plan.promoted).toEqual([true, false]);
		expect(plan.edge(1, 0, 0)).toBe('stub');
		expect(plan.edge(0, 1, 0)).toBe('plain');
	});

	it('treats a vector op as a write only when it can store', () => {
		const sse = (code: number, mem = true) => ins('SSE', 4, 0, 0, mem ? 0x80 : 0, BigInt(code));
		expect(vecWrite('SSE', sse(0x29))).toBe(16);
		expect(vecWrite('SSE', sse(0x28))).toBe(0);
		expect(vecWrite('SSE', sse(0xae))).toBe(512);
		expect(vecWrite('SSE', sse(0x29, false))).toBe(0);
	});
});
