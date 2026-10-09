import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
	ending,
	functions,
	opNumbers,
	parse,
	rangesOf,
	shares,
	splitRanges,
	topRanges,
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
const asc = (x: bigint, y: bigint) => (x < y ? -1 : 1);
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

	it('tells a computed jump from a return', () => {
		const table = block(0x4000n, 0x4010n, 5n, [
			ins('MOVI', 32, 0, 0, 0x5339012n),
			ins('ADD', 32, 32, 6),
			ins('LD', 33, 32),
			ins('SEXT', 33, 33),
			ins('ADD', 35, 33, 6),
			ins('FLAGS', 35, 0, 6),
			ins('MOV', 0, 35),
			ins('JMP', 0, 0)
		]);
		expect(ending(table, op)).toBe('computed-jump');
		expect(ending(block(0x4000n, 0x4010n, 1n, [ins('JMP', 0, 7)]), op)).toBe('computed-jump');
		const absolute = block(0x4000n, 0x4010n, 1n, [
			ins('MOVI', 32, 0, 0, 0x5339012n),
			ins('LD', 33, 32),
			ins('JMP', 0, 33)
		]);
		expect(ending(absolute, op)).toBe('computed-jump');
		const pop = block(0x4000n, 0x4010n, 1n, [
			ins('LD', T1, 4),
			ins('MOVI', T5, 0, 0, 8n),
			ins('ADD', 4, 4, T5),
			ins('JMP', 0, T1)
		]);
		expect(ending(pop, op)).toBe('ret');
	});

	it('seeds functions from blocks no call target reaches, even a cycle nothing flows into', () => {
		const orphans = [
			// an indirect-call target: a branch and a return, no block flows into it
			block(0x6000n, 0x6010n, 3n, [ins('ADD', 1, 1, 2), ins('BR')], 0x6020n),
			block(0x6010n, 0x6011n, 3n, ret),
			block(0x6020n, 0x6021n, 1n, ret),
			// a jump table: the dispatcher and the targets only it enters
			block(0x8000n, 0x8010n, 4n, [
				ins('ADD', 35, 33, 6),
				ins('MOV', 0, 35),
				ins('JMP', 0, 0)
			]),
			block(0x8100n, 0x8101n, 2n, ret),
			// a self loop whose block is its own only predecessor
			block(0x7000n, 0x7010n, 50n, [ins('ADD', 1, 1, 2), ins('BR')], 0x7000n),
			// a two block cycle nothing outside flows into, with a block that only it reaches
			block(0x7100n, 0x7110n, 7n, [ins('ADD', 1, 1, 2)]),
			block(0x7110n, 0x7120n, 7n, [ins('ADD', 1, 1, 2), ins('BR')], 0x7100n),
			block(0x7120n, 0x7121n, 1n, ret)
		];
		const all = [...blocks, ...orphans];
		const total = all.reduce((s, b) => s + b.runs * BigInt(b.ins.length), 0n);
		const old = functions(all, op, 0x1000n, false);
		expect(old.map((f) => f.entry).sort(asc)).toEqual([0x1000n, 0x2000n, 0x3000n]);
		const fns = functions(all, op, 0x1000n);
		expect(fns.map((f) => f.entry).sort(asc)).toEqual([
			0x1000n,
			0x2000n,
			0x3000n,
			0x6000n,
			0x7000n,
			0x7100n,
			0x8000n,
			0x8100n
		]);
		const byEntry = new Map(fns.map((f) => [f.entry, f]));
		expect(
			byEntry
				.get(0x6000n)!
				.blocks.map((b) => b.pc)
				.sort(asc)
		).toEqual([0x6000n, 0x6010n, 0x6020n]);
		expect(
			byEntry
				.get(0x7100n)!
				.blocks.map((b) => b.pc)
				.sort(asc)
		).toEqual([0x7100n, 0x7110n, 0x7120n]);
		expect(fns.reduce((n, f) => n + f.blocks.length, 0)).toBe(all.length);
		expect(shares(old, total, [1]).claimed).toBeLessThan(1);
		expect(shares(fns, total, [1, 2])).toEqual({
			claimed: 1,
			top: [
				Number(fns[0]!.self) / Number(total),
				Number(fns[0]!.self + fns[1]!.self) / Number(total)
			]
		});
	});

	it('leaves the functions of a fully covered dump as the call targets made them', () => {
		const a = functions(blocks, op, 0x1000n);
		const b = functions(blocks, op, 0x1000n, false);
		expect(a.map((f) => [f.entry, f.self, f.blocks.length])).toEqual(
			b.map((f) => [f.entry, f.self, f.blocks.length])
		);
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

	it('takes the n functions with the most self ops as one ranges text each, without their callees', () => {
		const fns = functions(blocks, op, 0x1000n);
		expect(topRanges(fns, 1)).toEqual(['0x2000-0x2021']);
		expect(topRanges(fns, 3)).toEqual(['0x2000-0x2021', '0x1000-0x1021', '0x3000-0x3001']);
		expect(topRanges(fns, 9)).toHaveLength(3);
	});

	it('prints them through --emit-top', () => {
		const dir = mkdtempSync(join(tmpdir(), 'fn-'));
		const hot = join(dir, 'd.hot');
		const text = blocks.map((b) => {
			const head = `block ${b.pc.toString(16)} ${b.next.toString(16)} ${b.target.toString(16)} ${b.ins.length} ${b.runs}`;
			return [head, ...b.ins.map((x) => `${x.op} ${x.w} ${x.a} ${x.b} ${x.c} ${x.imm}`)].join(
				'\n'
			);
		});
		writeFileSync(hot, `arch 0\n${text.join('\n')}\n`);
		const run = spawnSync(
			process.execPath,
			[
				'--no-warnings',
				'--experimental-strip-types',
				'experiments/aot-oracle/scripts/functions.ts',
				hot,
				'--emit-top=2'
			],
			{ encoding: 'utf8' }
		);
		expect(run.status).toBe(0);
		expect(run.stdout).toBe('0x2000-0x2021\n0x1000-0x1021\n');
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
