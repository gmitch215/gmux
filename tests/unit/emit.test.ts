import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { emitRegions, L, layoutOf } from '../../experiments/aot-oracle/scripts/emit.ts';
import { opNumbers } from '../../experiments/aot-oracle/scripts/functions.ts';
import {
	findLoops,
	FK,
	parse,
	selectBlocks
} from '../../experiments/aot-oracle/scripts/region-ir.ts';

const op = opNumbers(readFileSync('src/gmux/katybug/kb.h', 'utf8'));
const T0 = 32;

type Ins = [string, number, number, number, number, number];
interface Blk {
	pc: number;
	next: number;
	target?: number;
	ins: Ins[];
	pcs?: number[];
}
const dump = (blocks: Blk[]) =>
	[
		'arch 0',
		...blocks.flatMap((b) => [
			`block ${b.pc.toString(16)} ${b.next.toString(16)} ${(b.target ?? 0).toString(16)} ${b.ins.length} 5`,
			...b.ins.map(([name, w, a, bb, c, imm]) => `${op[name]} ${w} ${a} ${bb} ${c} ${imm}`),
			...(b.pcs ? [`pcs ${b.pcs.join(' ')}`] : [])
		]),
		''
	].join('\n');

function emit(blocks: Blk[], mutate = '', extra: Partial<Parameters<typeof emitRegions>[1]> = {}) {
	return emitMany([blocks], mutate, extra);
}
// one region per list of blocks, each from a dump of its own
function emitMany(
	regions: Blk[][],
	mutate = '',
	extra: Partial<Parameters<typeof emitRegions>[1]> = {}
) {
	const dir = mkdtempSync(join(tmpdir(), 'emit-'));
	const ins = regions.map((blocks, k) => {
		const path = join(dir, `d${k}.hot`);
		writeFileSync(path, dump(blocks));
		const { all, chosen } = selectBlocks(path, undefined, 1);
		return { all, chosen };
	});
	return { ...emitRegions(ins, { flags: 'live', mutate, ...extra }), dir };
}

// a block that adds two registers into a temporary and zero-extends it to 32 bits, then branches back to itself
const spin: Blk[] = [
	{
		pc: 0x1000,
		next: 0x2000,
		target: 0x1000,
		ins: [
			['ADD', 8, T0, 3, 4, 0],
			['ZEXT', 4, 3, T0, 0, 0],
			['BRZ', 8, 3, 0, 0, 1]
		]
	},
	{ pc: 0x2000, next: 0x2001, ins: [['JMP', 8, 0, 5, 0, 0]] }
];
// three blocks in a loop: a forward edge, and a branch back from the last to the first
const ring: Blk[] = [
	{ pc: 0x1000, next: 0x2000, ins: [['ADD', 8, 1, 1, 2, 0]] },
	{ pc: 0x2000, next: 0x3000, ins: [['ADD', 8, 2, 2, 1, 0]] },
	{ pc: 0x3000, next: 0x4000, target: 0x1000, ins: [['BRZ', 8, 1, 0, 0, 1]] }
];

const has = (tool: string) => spawnSync(tool, ['--version']).status === 0;
const tools = has('llvm-mc') && has('wasm-ld') && has('wasm-tools');

describe('emit', () => {
	it('writes a loop and a loop entry switch for a loop of several blocks', () => {
		const { asm, reports } = emit(ring);
		expect(asm).toMatch(/\tloop\n/);
		expect(asm).toMatch(/\tend_loop\n/);
		expect(asm).toMatch(/\tbr_table\t\{/);
		expect(reports[0]!.loops).toBe(1);
		expect(reports[0]!.emitted).toBe(3);
	});

	it('keeps a block of a loop that is its own header without an entry switch', () => {
		const { asm } = emit(spin);
		expect(asm).toMatch(/\tloop\n/);
		expect(asm).not.toMatch(/\tbr_table/);
	});

	it('clears the entry selector where a one-block loop starts, so a stale position cannot steer a later switch', () => {
		const { asm } = emit(spin);
		expect(asm).toMatch(/\tloop\n\ti32\.const\t-1\n\tlocal\.set\t\d+\n\t# block 1000/);
	});

	it('stores every region register, the flags and the direction flag at an exit, and returns the pc', () => {
		const { asm } = emit(ring);
		for (const r of [1, 2]) expect(asm).toContain(`\ti64.store\t${L.cpuR + 8 * r}:p2align=0\n`);
		for (const off of [L.cpuN, L.cpuZ, L.cpuC, L.cpuV, L.cpuP, L.cpuDf])
			expect(asm).toContain(`\ti32.store\t${off}:p2align=0\n`);
		expect(asm).toMatch(/local\.get\t1\n\tend_function/);
	});

	it('computes an add that only a 32-bit zero extension reads in 32 bits', () => {
		const { reports } = emit(spin);
		expect(reports[0]!.narrowStatic).toBeGreaterThanOrEqual(2);
	});

	it('keeps a sum that an address reads in 64 bits, and the width mutant does not', () => {
		const wide: Blk[] = [
			{
				pc: 0x1000,
				next: 0x2000,
				ins: [
					['ADD', 8, T0, 3, 4, 0],
					['LD', 8, 5, T0, 0, 0]
				]
			},
			{ pc: 0x2000, next: 0x2001, ins: [['JMP', 8, 0, 5, 0, 0]] }
		];
		const count = (text: string) => text.split('\ti32.add\n').length;
		expect(count(emit(wide, 'width').asm)).toBeGreaterThan(count(emit(wide).asm));
	});

	it('leaves a block with an op it does not take out of the region and says why', () => {
		const { reports } = emit([
			{ pc: 0x1000, next: 0x2000, ins: [['ADD', 8, 1, 1, 2, 0]] },
			{
				pc: 0x2000,
				next: 0x2001,
				ins: [
					['UDIV', 8, 1, 1, 2, 0],
					['JMP', 8, 0, 5, 0, 0]
				]
			}
		]);
		expect(reports[0]!.exits).toEqual([{ pc: 0x2000n, why: 'UDIV' }]);
		expect(reports[0]!.emitted).toBe(1);
	});

	it('writes the tables the runtime attaches blocks through', () => {
		const { tables } = emit(ring);
		expect(tables).toContain('void kb_aot_attach(');
		expect(tables).toContain('r0_run');
		expect(tables).toMatch(/aot_table\[\] = \{\s*\{0x1000ull,/);
	});

	it('keeps the instruction offsets of each block in the table and compares them when attaching', () => {
		const { tables } = emit([
			{
				pc: 0x1000,
				next: 0x2000,
				ins: [
					['ADD', 8, 1, 1, 2, 0],
					['ADD', 8, 2, 2, 1, 0]
				],
				pcs: [0, 4]
			},
			{ pc: 0x2000, next: 0x2001, ins: [['JMP', 8, 0, 5, 0, 0]] }
		]);
		expect(tables).toContain('static const uint32_t r0_p0[] = {0u, 4u};');
		expect(tables).toMatch(/r0_i0, r0_p0\}/);
		expect(tables).toMatch(/r0_i1, NULL\}/);
		expect(tables).toContain('memcmp(e->pcs, b->pcs, (size_t) e->n * sizeof *e->pcs)');
	});

	it('stops the build when a struct the emitted code reads has moved', () => {
		const { tables } = emit(ring);
		expect(tables).toContain(`_Static_assert(offsetof(struct kb_cpu, ipc) == ${L.cpuIpc}, `);
		expect(tables).toContain(
			`_Static_assert(offsetof(struct kb_cpu, sigreturned) == ${L.cpuSigreturned}, `
		);
		expect(tables).toContain(`_Static_assert(sizeof(struct kb_ic) == ${L.icSize}, `);
		expect(tables).toContain(`_Static_assert(offsetof(struct kb_block, ic) == ${L.blkIc}, `);
	});

	it('orders a loop header first and every forward edge forward', () => {
		const succ = [[1], [2], [0, 3], []];
		const { loops } = findLoops(succ, [5n, 5n, 5n, 5n]);
		const items = layoutOf(succ, loops, [5n, 5n, 5n, 5n]);
		expect(items[0]!.kind).toBe('loop');
		expect(items[1]).toEqual({ kind: 'block', j: 3 });
	});

	it.skipIf(!tools)('assembles, links and validates', () => {
		const { asm, dir } = emit(ring);
		const sym = (n: string, size: number) =>
			`\t.section\t.bss.${n},"",@\n\t.globl\t${n}\n\t.hidden\t${n}\n\t.type\t${n},@object\n${n}:\n\t.skip\t${size}\n\t.size\t${n}, ${size}\n`;
		writeFileSync(join(dir, 'r.s'), asm);
		writeFileSync(
			join(dir, 'stub.s'),
			sym('r0_ok', 64) + sym('r0_blk', 256) + sym('r0_win', 1024)
		);
		for (const f of ['r', 'stub'])
			expect(
				spawnSync('llvm-mc', [
					'-triple=wasm32',
					'-filetype=obj',
					join(dir, `${f}.s`),
					'-o',
					join(dir, `${f}.o`)
				]).status
			).toBe(0);
		const link = spawnSync('wasm-ld', [
			'--no-entry',
			'-shared',
			'--allow-undefined',
			'--export=r0_run',
			join(dir, 'r.o'),
			join(dir, 'stub.o'),
			'-o',
			join(dir, 'r.wasm')
		]);
		expect(link.status).toBe(0);
		expect(spawnSync('wasm-tools', ['validate', join(dir, 'r.wasm')]).status).toBe(0);
	});

	it('emits a region of thousands of blocks', () => {
		const blocks: Blk[] = Array.from({ length: 4000 }, (_, i) => ({
			pc: 0x1000 + 0x10 * i,
			next: 0x1000 + 0x10 * (i + 1),
			ins: [['ADD', 8, 1, 1, 2, 0]] as Ins[]
		}));
		const { asm, reports } = emit(blocks);
		expect(reports[0]!.emitted).toBe(4000);
		expect(asm.split('\n').length).toBeGreaterThan(130_000);
	});

	it('resolves a window for reading when it only loads and for writing when it stores', () => {
		const load: Blk[] = [
			{
				pc: 0x1000,
				next: 0x2000,
				ins: [
					['LD', 8, 5, 3, 0, 0],
					['JMP', 8, 0, 5, 0, 0]
				]
			}
		];
		const store: Blk[] = [
			{
				pc: 0x1000,
				next: 0x2000,
				ins: [
					['ST', 8, 5, 3, 0, 0],
					['JMP', 8, 0, 5, 0, 0]
				]
			}
		];
		const rights = (asm: string) =>
			[...asm.matchAll(/i32\.const\t(\d+)\n\tcall\tkb_host_ic_at\n/g)].map((m) => m[1]);
		expect(rights(emit(load).asm)).toEqual(['1']);
		expect(rights(emit(store).asm)).toEqual(['2']);
		expect(rights(emit(store, 'storeread').asm)).toEqual(['1']);
		expect(emit(store).asm).not.toContain('call\tkb_host_ic\n');
	});

	it('counts every operator it writes under one category, a guest access under guest and a helper call under helpers', () => {
		const mem: Blk[] = [
			{
				pc: 0x1000,
				next: 0x2000,
				ins: [
					['LD', 8, 5, 3, 0, 0],
					['ST', 8, 5, 3, 0, 8],
					['JMP', 8, 0, 5, 0, 0]
				]
			}
		];
		const done = emit(mem);
		const cats = done.reports[0]!.cats;
		const written = done.asm
			.split('\n')
			.filter(
				(l) =>
					/^\t[a-z]/.test(l) &&
					!/^\t(end|block|loop|local\.|i32\.const|i64\.const|drop)/.test(l)
			).length;
		expect(Object.values(cats).reduce((s, v) => s + v.static, 0)).toBe(written);
		expect(cats.guest!.static).toBeGreaterThanOrEqual(4);
		expect(cats.helpers!.static).toBeGreaterThanOrEqual(2);
		expect(cats.guards!.static).toBeGreaterThan(0);
		expect(cats.state!.static).toBeGreaterThan(0);
	});

	it('computes everything in 64 bits when asked to', () => {
		expect(emit(spin).reports[0]!.narrowStatic).toBeGreaterThan(0);
		const wide = emit(spin, '', { wide: true });
		expect(wide.reports[0]!.narrowStatic).toBe(0);
	});

	it('swaps bytes in 32 bits for a 4-byte swap and takes the block in', () => {
		const swap = (w: number): Blk[] => [
			{
				pc: 0x1000,
				next: 0x2000,
				ins: [
					['LD', 4, 3, 4, 0, 0],
					['BSWAP', w, 5, 3, 0, 0],
					['ST', 4, 5, 4, 0, 0],
					['JMP', 8, 0, 5, 0, 0]
				]
			}
		];
		expect(emit(swap(4)).reports[0]!.exits).toEqual([]);
		expect(emit(swap(4)).asm).toContain('\ti32.rotl\n');
		expect(emit(swap(8)).asm).toContain('\ti64.rotl\n');
		expect(emit(swap(4), '', { wide: true }).asm).toContain('\ti64.rotl\n');
	});

	// the caller pushes its return address and jumps to the callee's first block; the callee returns through a register
	const call: Blk[][] = [
		[
			{
				pc: 0x1000,
				next: 0x1100,
				ins: [
					['MOVI', 8, 7, 0, 0, 0x1100],
					['MOVI', 8, 6, 0, 0, 0x2000],
					['JMP', 8, 0, 6, 0, 0]
				]
			},
			{
				pc: 0x1100,
				next: 0x1200,
				ins: [
					['ADD', 8, 3, 3, 3, 0],
					['JMP', 8, 0, 5, 0, 0]
				]
			}
		],
		[
			{
				pc: 0x2000,
				next: 0x2001,
				ins: [
					['ADD', 8, 1, 1, 2, 0],
					['JMP', 8, 0, 7, 0, 0]
				]
			}
		]
	];

	it('leaves at an edge into another region unless direct calls are on', () => {
		const { asm } = emitMany(call);
		expect(asm).not.toContain('r1_go');
		expect(asm).not.toContain('call\tr1');
	});

	it('calls the other region with its registers as parameters and takes back the ones it writes', () => {
		const { asm } = emitMany(call, '', { calls: 'live' });
		expect(asm).toContain('call\tr1_go\n');
		// a callee's text comes first, and its entry for any other caller reads the cpu and calls it
		expect(asm.indexOf('r1_go:')).toBeLessThan(asm.indexOf('r0_run:'));
		expect(asm).toMatch(/r1_run \(i32, i64\) -> \(i64\)/);
		const sig = /\.functype\tr1_go \(([^)]*)\) -> \(([^)]*)\)/.exec(asm)!;
		const params = sig[1]!.split(', ');
		const results = sig[2]!.split(', ');
		// cpu, pc, the registers the region holds (0, 1, 2, 7 and the helpers' rax and rdx), six flags and the generation
		expect(params.length).toBe(2 + 4 + 7);
		// the pc, what it writes (r1 and nothing else it reads), six flags and the generation
		expect(results.length).toBe(1 + 1 + 7);
		expect(emitMany(call, '', { calls: 'all' }).asm).toMatch(/r1_go \([^)]*\) -> \((i64, ){5}/);
	});

	it('continues at the return address a block pushed and leaves through the region at any other pc', () => {
		const { asm } = emitMany(call, '', { calls: 'live' });
		const site = asm.slice(asm.indexOf('call\tr1_go'));
		expect(site).toContain('i64.const\t4352\n\ti64.eq');
		expect(site).toMatch(/\tbr\t\d+\n\tend_if/);
	});

	it('does not hand the callee back to a caller with the noreturn mutant', () => {
		const live = emitMany(call, '', { calls: 'live' }).asm;
		const mutant = emitMany(call, 'noreturn', { calls: 'live' }).asm;
		expect(mutant.split('\tdrop\n').length).toBeGreaterThan(live.split('\tdrop\n').length);
	});

	it('does not call a region that makes a system call', () => {
		const sys: Blk[][] = [
			call[0]!,
			[{ pc: 0x2000, next: 0x2001, ins: [['SYSCALL', 8, 0, 0, 0, 0]] }]
		];
		expect(emitMany(sys, '', { calls: 'live' }).asm).not.toContain('call\tr1_go');
	});

	describe('flags as recipes', () => {
		const kind = (name: string) => FK.indexOf(name);
		const SUB = kind('SUB');
		const ADC = kind('ADC');
		const JL = 12;
		const JZ = 4;
		// a compare, a store that can fault, and a signed branch; the two successors read no flags
		const cmpBranch = (next: Blk): Blk[] => [
			{
				pc: 0x1000,
				next: 0x2000,
				target: 0x3000,
				ins: [
					['SUB', 8, T0, 1, 2, 0],
					['FLAGS', 8, T0, 1, 2, SUB],
					['ST', 8, 3, 5, 0, 0],
					['BR', 8, 0, 0, 0, JL]
				]
			},
			next,
			{ pc: 0x3000, next: 0x3001, ins: [['FLAGS', 8, 3, 3, 3, kind('LOGIC')]] }
		];
		// a block that writes every flag before it reads one, so nothing reaches it
		const quiet: Blk = {
			pc: 0x2000,
			next: 0x2001,
			ins: [['FLAGS', 8, 3, 3, 3, kind('LOGIC')]]
		};
		const recipe = { flags: 'recipe' as const };

		it('keeps a compare as its operands and branches on them', () => {
			const r = emit(cmpBranch(quiet), '', recipe);
			expect(r.reports[0]!.flagOps).toMatchObject({ eager: 0, predicates: 1 });
			expect(r.reports[0]!.flagOps.recipe).toBeGreaterThanOrEqual(1);
			// a signed compare of the operands, not the sign and overflow flags
			expect(r.asm).toContain('i64.lt_s');
			// the parity of the result is only in the stubs that make the flags for a fault or an exit
			expect(r.asm.split('i64.popcnt').length - 1).toBe(r.reports[0]!.flagOps.stubs);
			expect(r.reports[0]!.flagOps.stubs).toBeGreaterThan(1);
			const live = emit(cmpBranch(quiet));
			expect(live.asm).toContain('i64.popcnt');
			expect(live.asm).not.toContain('i64.lt_s');
		});

		it('computes the flags where the next block reads them', () => {
			const reader: Blk = {
				pc: 0x2000,
				next: 0x2001,
				target: 0x3000,
				ins: [['BR', 8, 0, 0, 0, JZ]]
			};
			const { reports, asm } = emit(cmpBranch(reader), '', recipe);
			expect(reports[0]!.flagOps).toMatchObject({ eager: 1, why: { 'live-in': 1 } });
			expect(asm).not.toContain('i64.lt_s');
		});

		describe('across an edge', () => {
			const edge = { flags: 'recipe' as const, edge: true };
			const reader: Blk = {
				pc: 0x2000,
				next: 0x2001,
				target: 0x3000,
				ins: [['BR', 8, 0, 0, 0, JZ]]
			};
			const ADD = kind('ADD');

			it('leaves a recipe a block that reads flags takes in as it is, and says so in the report', () => {
				const off = emit(cmpBranch(reader), '', recipe);
				expect(off.reports[0]!.edge).toBeUndefined();
				const on = emit(cmpBranch(reader), '', edge);
				expect(on.reports[0]!.flagOps).toMatchObject({ eager: 0 });
				expect(on.reports[0]!.flagOps.why['live-in']).toBeUndefined();
				expect(on.reports[0]!.edge).toMatchObject({
					entries: 1,
					passed: 1,
					materialized: 0
				});
			});

			it('reads the recipe when an edge entered the block and the five locals when the interpreter did', () => {
				const { asm } = emit(cmpBranch(reader), '', edge);
				// the block the interpreter enters clears the entry state before it branches into the block
				expect(asm).toMatch(
					/\ti32\.const\t0\n\tlocal\.set\t(\d+)\n\ti32\.const\t-1\n\tlocal\.set\t\d+\n\tbr/
				);
				// and the reader takes either: the zero flag from the operands when warm, from its local otherwise
				expect(asm).toMatch(
					/\tlocal\.get\t\d+\n\tif\ti32\n\tlocal\.get\t\d+\n\ti64\.eqz\n\telse\n\tlocal\.get\t\d+\n\tend_if/
				);
				const stale = emit(cmpBranch(reader), 'warmstale', edge);
				expect(stale.asm).not.toBe(asm);
				expect(stale.asm).not.toMatch(
					/\ti32\.const\t0\n\tlocal\.set\t\d+\n\ti32\.const\t-1\n\tlocal\.set\t\d+\n\tbr/
				);
			});

			it('computes the flags at an edge from a block whose recipe is another kind, and the edgeskip mutant leaves them out', () => {
				const mixed: Blk[] = [
					{
						pc: 0x1000,
						next: 0x2000,
						target: 0x4000,
						ins: [
							['SUB', 8, T0, 1, 2, 0],
							['FLAGS', 8, T0, 1, 2, SUB],
							['BR', 8, 0, 0, 0, JL]
						]
					},
					{
						pc: 0x2000,
						next: 0x4000,
						ins: [
							['ADD', 8, T0, 1, 2, 0],
							['FLAGS', 8, T0, 1, 2, ADD]
						]
					},
					{ pc: 0x4000, next: 0x4001, target: 0x5000, ins: [['BR', 8, 0, 0, 0, JZ]] },
					{ pc: 0x5000, next: 0x5001, ins: [['FLAGS', 8, 3, 3, 3, kind('LOGIC')]] }
				];
				const ok = emit(mixed, '', edge);
				expect(ok.reports[0]!.edge).toMatchObject({
					entries: 1,
					passed: 1,
					materialized: 1
				});
				const skip = emit(mixed, 'edgeskip', edge);
				expect(skip.asm).not.toBe(ok.asm);
				expect(skip.asm.split('\n').length).toBeLessThan(ok.asm.split('\n').length);
			});

			it('keeps the flags in their locals for a block that a helper or a partial flags op comes first in', () => {
				const shifts: Blk = {
					pc: 0x2000,
					next: 0x2001,
					ins: [
						['FLAGS', 8, 3, 3, 4, kind('SHL')],
						['BR', 8, 0, 0, 0, JZ]
					],
					target: 0x3000
				};
				const r = emit(cmpBranch(shifts), '', edge);
				expect(r.reports[0]!.edge).toMatchObject({
					entries: 0,
					passed: 0,
					materialized: 1
				});
			});
		});

		it('takes the carry in from the recipe an add with carry replaces, and the adc mutant drops it', () => {
			const chain: Blk[] = [
				{
					pc: 0x1000,
					next: 0x2000,
					ins: [
						['SUB', 8, T0, 1, 2, 0],
						['FLAGS', 8, T0, 1, 2, SUB],
						['CARRY', 8, T0 + 1, 0, 0, 0],
						['ADD', 8, 3, 3, T0 + 1, 0],
						['FLAGS', 8, 3, 3, T0 + 1, ADC],
						['BR', 8, 0, 0, 0, JZ]
					]
				},
				quiet
			];
			chain[0]!.target = 0x2000;
			const ok = emit(chain, '', recipe);
			expect(ok.reports[0]!.flagOps).toMatchObject({ dead: 0, eager: 0 });
			expect(ok.reports[0]!.flagOps.recipe).toBeGreaterThanOrEqual(2);
			const mutant = emit(chain, 'adc', recipe);
			expect(mutant.asm).not.toBe(ok.asm);
			expect(mutant.asm).toContain('\tdrop\n\ti64.const\t0\n\tlocal.set');
		});

		it('leaves the zero flag out of a stub with the stubflag mutant', () => {
			const sets = (asm: string) => asm.split('\tlocal.set\t').length;
			expect(sets(emit(cmpBranch(quiet), 'stubflag', recipe).asm)).toBeLessThan(
				sets(emit(cmpBranch(quiet), '', recipe).asm)
			);
		});

		it('writes a push after the store with the rspfirst mutant swapping the two', () => {
			const push: Blk[] = [
				{
					pc: 0x1000,
					next: 0x2000,
					ins: [
						['ST', 8, 3, 4, 0, -8],
						['MOVI', 8, T0 + 5, 0, 0, 8],
						['SUB', 8, 4, 4, T0 + 5, 0]
					]
				},
				quiet
			];
			expect(emit(push, 'rspfirst').asm).not.toBe(emit(push).asm);
		});
	});

	describe('loc', () => {
		const strip = (asm: string) => asm.replace(/\t\.(loc|file)\t[^\n]*\n/g, '');
		it('adds nothing unless asked, and only .loc and .file lines when asked', () => {
			const plain = emit(ring).asm;
			expect(plain).not.toContain('\t.loc\t');
			const loc = emit(ring, '', { loc: true }).asm;
			expect(loc).toContain('\t.file\t1 "arith"\n');
			expect(strip(loc)).toBe(plain);
		});

		it('names the category as the file and the guest pc as the line, once per run', () => {
			const { asm } = emit(ring, '', { loc: true });
			expect(asm).toMatch(/\t\.loc\t1 4096 0\n/);
			const locs = asm.split('\n').filter((l) => l.startsWith('\t.loc\t'));
			locs.forEach((l, k) => expect(l).not.toBe(locs[k - 1]));
			expect(locs.length).toBeGreaterThan(3);
		});

		it('gives an access its address, guard and guest ops three different files', () => {
			const ld: Blk[] = [
				{ pc: 0x1000, next: 0x2000, ins: [['LD', 8, 3, 4, 0, 16]] },
				{ pc: 0x2000, next: 0x2001, ins: [['JMP', 8, 0, 5, 0, 0]] }
			];
			const { asm } = emit(ld, '', { loc: true });
			const files = new Set(
				asm
					.split('\n')
					.filter((l) => l.startsWith('\t.loc\t'))
					.map((l) => l.split(/\s/)[2])
			);
			// address 4, guards 5, guest 6
			for (const f of ['4', '5', '6']) expect(files).toContain(f);
		});
	});

	it('parses back the dump it was given', () => {
		const dir = mkdtempSync(join(tmpdir(), 'emit-'));
		writeFileSync(join(dir, 'd.hot'), dump(ring));
		expect(parse(join(dir, 'd.hot')).map((b) => b.pc)).toEqual([0x1000n, 0x2000n, 0x3000n]);
	});
});
