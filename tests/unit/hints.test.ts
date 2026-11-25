import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { emitRegions, hintsTsv } from '../../experiments/aot-oracle/scripts/emit.ts';
import {
	opNumbers,
	parse as parseFunctions
} from '../../experiments/aot-oracle/scripts/functions.ts';
import {
	blocksOf,
	counts,
	pick,
	plan,
	readRows,
	type ClassStat,
	type Row
} from '../../experiments/aot-oracle/scripts/hints.ts';
import { type Fn, type Op } from '../../experiments/aot-oracle/scripts/opmap.ts';
import { parse, selectBlocks } from '../../experiments/aot-oracle/scripts/region-ir.ts';
import { hinted } from '../../experiments/wasm-features/scripts/branch-hint.ts';

const op = opNumbers(readFileSync('src/gmux/katybug/kb.h', 'utf8'));
const T0 = 32;

type Ins = [string, number, number, number, number, number];
interface Blk {
	pc: number;
	next: number;
	target?: number;
	runs?: number;
	ins: Ins[];
	// the lines a dump has after the ops
	tail?: string[];
}
const dump = (blocks: Blk[]) =>
	[
		'arch 0',
		...blocks.flatMap((b) => [
			`block ${b.pc.toString(16)} ${b.next.toString(16)} ${(b.target ?? 0).toString(16)} ${b.ins.length} ${b.runs ?? 5}`,
			...b.ins.map(([name, w, a, bb, c, imm]) => `${op[name]} ${w} ${a} ${bb} ${c} ${imm}`),
			...(b.tail ?? [])
		]),
		''
	].join('\n');
const write = (name: string, text: string) => {
	const dir = mkdtempSync(join(tmpdir(), 'hints-'));
	writeFileSync(join(dir, name), text);
	return { dir, path: join(dir, name) };
};

// a loop block that ends in a branch back to itself, and a block with an interior exit
const spin: Blk[] = [
	{
		pc: 0x1000,
		next: 0x2000,
		target: 0x1000,
		runs: 100,
		ins: [
			['ADD', 8, T0, 3, 4, 0],
			['ZEXT', 4, 3, T0, 0, 0],
			['BRZ', 8, 3, 0, 0, 1]
		],
		tail: ['pcs 0 4 8', 'branch 90 10']
	},
	{ pc: 0x2000, next: 0x2001, ins: [['JMP', 8, 0, 5, 0, 0]] }
];
const trace: Blk = {
	pc: 0x3000,
	next: 0x3010,
	target: 0x3100,
	runs: 100,
	ins: [
		['EXIT', 8, 3, 0, 0, 0x100 | 1],
		['EXIT', 8, 4, 0, 0, 0x100 | 1],
		['BRZ', 8, 3, 0, 0, 1]
	],
	tail: ['exits 0:30 1:20', 'branch 10 40']
};

describe('hot dump branch counts', () => {
	it('reads a branch line and the exits, and leaves both unset on a dump from before the line', () => {
		const next = parse(write('n.hot', dump([...spin, trace])).path);
		expect(next[0]!.taken).toBe(90n);
		expect(next[0]!.fall).toBe(10n);
		expect(next[2]!.exits).toEqual(
			new Map([
				[0, 30n],
				[1, 20n]
			])
		);
		const old = parse(
			write(
				'o.hot',
				dump(
					[...spin, trace].map((b) => ({
						...b,
						tail: (b.tail ?? []).filter((l) => !l.startsWith('branch'))
					}))
				)
			).path
		);
		expect(old[0]!.taken).toBeUndefined();
		expect(old[0]!.fall).toBeUndefined();
		expect(old[0]!.pcs).toEqual([0, 4, 8]);
	});

	it('is skipped by the other two dump readers: same table from an old and a new dump', () => {
		const strip = (b: Blk) => ({
			...b,
			tail: (b.tail ?? []).filter((l) => !l.startsWith('branch'))
		});
		const load: Blk = {
			pc: 0x4000,
			next: 0x4001,
			runs: 7,
			ins: [['LD', 8, 3, 4, 0, 16]],
			tail: ['branch 3 4']
		};
		const blocks = [...spin, trace, load];
		const a = write('a.hot', dump(blocks));
		const b = write('b.hot', dump(blocks.map(strip)));
		expect(parseFunctions(readFileSync(a.path, 'utf8')).map((x) => x.runs)).toEqual(
			parseFunctions(readFileSync(b.path, 'utf8')).map((x) => x.runs)
		);
		// the table names a workload by its directory, so both dumps sit in a directory called w
		const prov = (path: string) => {
			const dir = join(mkdtempSync(join(tmpdir(), 'hints-')), 'w');
			mkdirSync(dir);
			writeFileSync(join(dir, 'd.hot'), readFileSync(path));
			return spawnSync(
				'node',
				[
					'--no-warnings',
					'--experimental-strip-types',
					'experiments/aot-oracle/scripts/provenance.ts',
					dir
				],
				{ encoding: 'utf8' }
			);
		};
		const [pa, pb] = [prov(a.path), prov(b.path)];
		expect(pa.status).toBe(0);
		expect(pa.stdout).toContain('| w | 7 |');
		expect(pa.stdout).toBe(pb.stdout);
	});
});

describe('branch counts', () => {
	const blocks = (bs: Blk[]) => blocksOf([write('c.hot', dump(bs)).path]);
	const row = (cls: string, pc: bigint, o: number): Row => ({
		fn: 'f',
		ordinal: 0,
		cls,
		pc,
		op: o
	});

	it('reads a final branch as taken over fall, and an interior exit over the runs that reached it', () => {
		const b = blocks([trace]);
		expect(counts(row('br', 0x3000n, 2), b)).toEqual([10n, 40n]);
		// 100 runs: 30 left at op 0, so 70 reached op 1 and 20 of them left; 50 reached the branch
		expect(counts(row('exit', 0x3000n, 0), b)).toEqual([30n, 70n]);
		expect(counts(row('exit', 0x3000n, 1), b)).toEqual([20n, 50n]);
	});

	it('hints only where the counts differ, and inverts them in inv', () => {
		const b = blocks([
			...spin,
			trace,
			{
				pc: 0x4000,
				next: 0x4001,
				runs: 10,
				ins: [['BRZ', 8, 3, 0, 0, 1]],
				tail: ['branch 5 5']
			},
			{
				pc: 0x5000,
				next: 0x5001,
				runs: 10,
				ins: [['BRZ', 8, 3, 0, 0, 1]],
				tail: ['branch 0 0']
			},
			{ pc: 0x6000, next: 0x6001, runs: 10, ins: [['BRZ', 8, 3, 0, 0, 1]] }
		]);
		const stats = new Map<string, ClassStat>();
		const at = (pc: bigint, o: number, mode: 'dump' | 'inv' | 'none') =>
			pick(row('br', pc, o), b, mode, stats);
		expect(at(0x1000n, 2, 'dump')).toBe(1);
		expect(at(0x1000n, 2, 'inv')).toBe(0);
		expect(at(0x1000n, 2, 'none')).toBeUndefined();
		expect(at(0x3000n, 2, 'dump')).toBe(0);
		expect(at(0x4000n, 0, 'dump')).toBeUndefined();
		expect(at(0x5000n, 0, 'dump')).toBeUndefined();
		expect(at(0x6000n, 0, 'dump')).toBeUndefined();
	});

	it('hints a guard class only in all, from its static guard', () => {
		const b = blocks(spin);
		const guard: Row = { fn: 'f', ordinal: 0, cls: 'slow', guard: 0 };
		const stats = new Map<string, ClassStat>();
		expect(pick(guard, b, 'dump', stats)).toBeUndefined();
		expect(pick(guard, b, 'inv', stats)).toBeUndefined();
		expect(pick(guard, b, 'all', stats)).toBe(0);
		expect(pick({ ...guard, cls: 'ok', guard: 1 }, b, 'all', stats)).toBe(1);
		expect(pick(guard, b, 'allinv', stats)).toBe(1);
		expect(pick({ ...guard, cls: 'ok', guard: 1 }, b, 'allinv', stats)).toBe(0);
		expect(pick(row('br', 0x1000n, 2), b, 'allinv', stats)).toBe(0);
	});

	it('refuses a count it cannot trust', () => {
		const wrapped = blocks([
			{
				pc: 0x7000,
				next: 0x7001,
				runs: 2 ** 32 + 5,
				ins: [['BRZ', 8, 3, 0, 0, 1]],
				tail: ['branch 3 2']
			}
		]);
		expect(() => counts(row('br', 0x7000n, 0), wrapped)).toThrow(/wrapped/);
		const over = blocks([
			{
				pc: 0x7000,
				next: 0x7001,
				runs: 4,
				ins: [['BRZ', 8, 3, 0, 0, 1]],
				tail: ['branch 3 2']
			}
		]);
		expect(() => counts(row('br', 0x7000n, 0), over)).toThrow(/exceeds runs/);
		expect(() => counts(row('br', 0x1234n, 0), blocks(spin))).toThrow(/no block/);
		expect(() => counts(row('br', 0x1000n, 0), blocks(spin))).toThrow(/not a branch/);
		expect(() => counts(row('exit', 0x1000n, 2), blocks(spin))).toThrow(/not an exit/);
	});
});

// two functions of one `if` each: body bytes 00 20 00 04 40 01 0b 20 00 0b, the `if` at offset 3
const body = [0x00, 0x20, 0x00, 0x04, 0x40, 0x01, 0x0b, 0x20, 0x00, 0x0b];
const module = () =>
	new Uint8Array([
		...[0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00],
		...[0x01, 0x06, 0x01, 0x60, 0x01, 0x7f, 0x01, 0x7f],
		...[0x03, 0x03, 0x02, 0x00, 0x00],
		...[0x0a, 0x17, 0x02, 0x0a, ...body, 0x0a, ...body]
	]);
describe('the section', () => {
	const name = [...new TextEncoder().encode('metadata.code.branch_hint')];
	it('writes the section before the code section, sorted, and the engine compiles the module', async () => {
		const out = hinted(
			module(),
			[
				{ index: 1, hints: [[3, 0]] },
				{ index: 0, hints: [[3, 1]] }
			],
			0
		);
		const section = [
			0x00,
			0x25,
			0x19,
			...name,
			0x02,
			0x00,
			0x01,
			0x03,
			0x01,
			0x01,
			0x01,
			0x01,
			0x03,
			0x01,
			0x00
		];
		const plain = module();
		expect([...out]).toEqual([...plain.subarray(0, 21), ...section, ...plain.subarray(21)]);
		await expect(WebAssembly.compile(out)).resolves.toBeInstanceOf(WebAssembly.Module);
	});

	it('throws on a hint at a byte that is not an if or br_if, an unknown function, a repeat or a section already there', () => {
		expect(() => hinted(module(), [{ index: 0, hints: [[2, 1]] }], 0)).toThrow(
			/not an if or br_if/
		);
		expect(() =>
			hinted(
				module(),
				[
					{
						index: 0,
						hints: [
							[3, 1],
							[3, 0]
						]
					}
				],
				0
			)
		).toThrow(/twice/);
		expect(() => hinted(module(), [{ index: 5, hints: [[3, 1]] }], 0)).toThrow(
			/not in the code section/
		);
		expect(() => hinted(module(), [{ index: 0, hints: [[3, 2]] }], 0)).toThrow(/hint value/);
		expect(() =>
			hinted(
				hinted(module(), [{ index: 0, hints: [[3, 1]] }], 0),
				[{ index: 1, hints: [[3, 1]] }],
				0
			)
		).toThrow(/already/);
	});

	it('counts the imported functions the code section does not define', () => {
		const out = hinted(module(), [{ index: 4, hints: [[3, 1]] }], 3);
		expect(out.length).toBeGreaterThan(module().length);
		expect(() => hinted(module(), [{ index: 1, hints: [[3, 1]] }], 3)).toThrow(
			/not in the code section/
		);
	});
});

describe('the plan', () => {
	const mk = (names: string[], base = 0): Op[] =>
		names.map((t, k) => ({ off: base + k, name: t.split(' ')[0]!, text: t }));
	const FUEL =
		'local.get i32.const i32.sub local.tee i32.const i32.lt_s if local.get global.set call local.tee global.set end'.split(
			' '
		);
	const fn = (name: string, index: number, start: number, names: string[]): Fn => ({
		name,
		index,
		start,
		ops: mk(names, start + 1)
	});
	const pre = [
		fn('r0_run', 0, 100, ['local.get', 'if', 'nop', 'end', 'if i32', 'drop', 'end', 'end'])
	];
	const guest = [0n, 0n].map((_, k): Row => ({
		fn: 'r0_run',
		ordinal: k,
		cls: k ? 'slow' : 'br',
		pc: 0x1000n,
		op: 2,
		...(k ? { guard: 0 as const } : {})
	}));
	const blocks = blocksOf([write('p.hot', dump(spin)).path]);

	it('puts each hint on the right if after the passes insert their own', () => {
		// the stack pass's window is inserted before the first op; the added function comes first
		const inst = [
			fn('f0', 0, 40, ['nop', 'end']),
			fn('r0_run', 1, 100, [
				...FUEL,
				'local.get',
				'if',
				'nop',
				'end',
				'if i32',
				'drop',
				'end',
				'end'
			])
		];
		const { entries, stats } = plan(pre, inst, guest, blocks, 'all');
		const ifs = inst[1]!.ops.filter((o) => o.name === 'if');
		expect(ifs.length).toBe(3);
		expect(entries).toEqual([
			{
				index: 1,
				hints: [
					[ifs[1]!.off - 100, 1],
					[ifs[2]!.off - 100, 0]
				]
			}
		]);
		expect(stats.get('br')).toMatchObject({
			sites: 1,
			hinted: 1,
			likely: 1,
			agree: 90n,
			total: 100n
		});
		expect(plan(pre, inst, guest, blocks, 'dump').entries[0]!.hints).toEqual([
			[ifs[1]!.off - 100, 1]
		]);
		expect(plan(pre, inst, guest, blocks, 'inv').entries[0]!.hints).toEqual([
			[ifs[1]!.off - 100, 0]
		]);
	});

	it('throws when the sidecar and the module disagree', () => {
		const inst = [
			fn('f0', 0, 40, ['nop', 'end']),
			fn(
				'r0_run',
				1,
				100,
				pre[0]!.ops.map((o) => o.text)
			)
		];
		expect(() => plan(pre, inst, guest.slice(0, 1), blocks, 'dump')).toThrow(
			/2 ifs in the module, 1 rows/
		);
		expect(() =>
			plan(pre, inst, [...guest, { ...guest[0]!, fn: 'r9_run' }], blocks, 'dump')
		).toThrow(/r9_run/);
	});
});

describe('the emitter sidecar', () => {
	const emit = (bs: Blk[]) => {
		const { path } = write('e.hot', dump(bs));
		const { all, chosen } = selectBlocks(path, undefined, 1);
		return emitRegions([{ all, chosen }], { flags: 'live', mutate: '' });
	};

	it('lists every wasm if of a function in order, the guest branch by its block and op', () => {
		const { asm, hints } = emit(spin);
		const body = asm.slice(asm.indexOf('r0_run:'), asm.indexOf('end_function'));
		const ifs = body.split('\n').filter((l) => l === '\tif' || l.startsWith('\tif\t'));
		expect(hints.map((h) => h.ordinal)).toEqual(ifs.map((_, k) => k));
		const br = hints.filter((h) => h.cls === 'br');
		expect(br).toEqual([
			{ fn: 'r0_run', ordinal: expect.any(Number), cls: 'br', pc: 0x1000n, op: 2 }
		]);
		expect(hints.filter((h) => h.cls === 'ok')).not.toHaveLength(0);
	});

	it('writes a sidecar that reads back', () => {
		const { hints } = emit(spin);
		expect(readRows(hintsTsv(hints))).toEqual(hints);
	});

	it('tags a side exit of a trace', () => {
		const { hints } = emit([
			trace,
			{ pc: 0x3010, next: 0x3011, ins: [['JMP', 8, 0, 5, 0, 0]] }
		]);
		expect(hints.filter((h) => h.cls === 'exit').map((h) => h.op)).toEqual([0, 1]);
	});
});
