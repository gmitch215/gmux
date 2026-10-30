import { mkdirSync, writeFileSync } from 'node:fs';
import {
	FALL,
	FK,
	KB_ZERO,
	SP,
	condReads,
	constJump,
	deadFlags,
	edgesOf,
	findLoops,
	flagLiveness,
	hex,
	inRanges,
	isTemp,
	liveInTemps,
	opName,
	parseRanges,
	regionRegs,
	rw,
	sccs,
	selectBlocks,
	touches,
	windowPlanner,
	type Acc,
	type Block,
	type Hit,
	type Ins,
	type Loop,
	type Ranges,
	type Win
} from './region-ir.ts';

/**
 * A direct wasm emitter for promoted regions: the same regions lift.ts writes as C (a dump's hot blocks, one region per
 * dump), as LLVM wasm assembly. Guest registers and the five flags are locals, flags are computed inline per kind,
 * control flow is structured (loops, blocks, `br`; a block can also be entered from the interpreter anywhere, which a
 * loop's entry switch on `$e` serves), memory is the `--bounds=two --loop-guards` form (windows resolved once per block or per loop
 * entry, across one piece boundary, the checked path with the block's inline cache elsewhere) and every exit and fault
 * stores the cpu words the C route stores. A block with an op this does not take is an exit: the region leaves at it.
 *
 * `emit.ts [--flags=live|all|none] [--wide] [--calls[=live|all]] [--stats] [--loc] [--ranges=<lo>-<hi>,...] <out dir> <coverage 0..1> <dump.hot>[@<lo>-<hi>,...]...`
 * writes `regions.s` (the region functions) and `tables.c` (what the runtime attaches blocks through) into the out dir.
 * `EMIT_MUTATE=skipreg` makes every exit skip restoring one register (`skipret`: register 0), `badpc` returns the pc plus one at
 * every exit, `width` computes a wide value in 32 bits; all are unsound on purpose, so a check can show it fails.
 */

// #region layout (struct offsets, wasm32; kb_aot_layout in src/emit-glue.c is the compiler's own reading of them)
export const L = {
	insSize: 16,
	icSize: 24,
	icLo: 0,
	icSpan: 8,
	icHost: 16,
	icGen: 20,
	cpuR: 0,
	cpuFs: 520,
	cpuN: 536,
	cpuZ: 540,
	cpuC: 544,
	cpuV: 548,
	cpuP: 552,
	cpuDf: 592,
	cpuExited: 600,
	cpuMapgen: 35928,
	cpuFault: 52368,
	cpuIpc: 52528,
	cpuFaultSig: 55316,
	cpuSigreturned: 55324,
	blkIns: 28,
	blkIc: 32
};
// the cpu's `pc` field is read only through the syscall's `cpu->pc = next`
const CPU_PC = 512;
// #endregion

export interface EmitConfig {
	// `live` drops flag writes no later op reads (lift.ts's default); `all` keeps every write; `none` is unsound (measurement only);
	// `recipe` is `live` where a flag op's value reaches an op in the same block, a flag op is kept as its operands (a recipe) and
	// a branch or set computes only the flags it reads from them; a fault or exit stub makes the five flags from the recipe
	flags: 'live' | 'all' | 'none' | 'recipe';
	mutate: string;
	// every value in an i64 local, computed in 64 bits (the control for the 32-bit typing)
	wide?: boolean;
	// `live` makes an edge into another region (one with no syscall) a wasm call that passes the callee's registers and flags as
	// parameters and takes back the ones it writes; `all` takes back every register it holds. Off, every such edge is an exit
	calls?: 'off' | 'live' | 'all';
	// a `.loc` before each run of ops of one category and guest pc, the category as the file name and the pc as the line
	loc?: boolean;
	// with `recipe` flags: a recipe crosses an edge into a block that reads flags (the block takes it as its entry state and reads the
	// five locals when the interpreter entered it), in the regions listed (all of them when true). Off, such an op computes its flags at once
	edge?: boolean | number[];
}
export const LOC_FILES = ['arith', 'state', 'flags', 'address', 'guards', 'guest', 'dispatch', 'calls', 'safepoints'];
export interface RegionIn {
	all: Block[];
	chosen: Block[];
}
export interface RegionReport {
	name: string;
	chosen: number;
	emitted: number;
	// blocks the region leaves at because an op or flag kind is not taken (listed with the reason)
	exits: { pc: bigint; why: string }[];
	// emitted blocks that internal edges enter through the loop entry switch (a loop entered anywhere but its header)
	fallback: number;
	// emitted blocks inside a loop, which the interpreter may also enter anywhere
	interior: number;
	loops: number;
	irOps: number;
	// ALU-class ops computed in 32 bits, as a share of ALU-class ops: static, and weighted by the dump's block runs
	narrowStatic: number;
	aluStatic: number;
	narrowWeighted: bigint;
	aluWeighted: bigint;
	windows: number;
	accesses: number;
	windowed: number;
	// --edge: blocks that take a recipe in, edges that pass one (static, and weighted by the dump's block runs) and edges that compute the flags
	edge?: { entries: number; passed: number; passedW: bigint; materialized: number; materializedW: bigint };
	asmLines: number;
	// FLAGS ops by what the emitter did with them: dropped (no reader), kept as a recipe, computed at once (and why), each weighted
	// by the dump's block runs; cold stubs that make the five flags from a recipe; branches and sets that read a recipe
	flagOps: { total: number; dead: number; recipe: number; eager: number; deadW: bigint; recipeW: bigint; eagerW: bigint; why: Record<string, number>; whyW: Record<string, bigint>; stubs: number; predicates: number };
	// wasm operators by category (constants, local moves and frame markers left out): static, and weighted by the dump's block runs
	// (the prologue, epilogue, dispatch and loop entries lie outside every block and weigh 0)
	cats: Record<string, { static: number; weighted: bigint }>;
}

const SUPPORTED = new Set(
	'MOVI MOV ADD SUB AND OR XOR SHL SHR SAR ROR MUL UMULH SMULH ZEXT SEXT BSWAP INS LD LDS ST RESOLVE FLAGS SETCC SEL BR BRZ EXIT JMP PC CARRY CLZ CTZ POPCNT FSBASE X86MD X86SHD X86FLAGS SSE X87 X86STR SYSCALL'.split(' ')
);
const FLAG_KINDS = new Set('ADD SUB LOGIC INC DEC ADC SBB SHL SHR SAR MULOV NEG SETC ZERO CNT ROL ROR'.split(' '));
// the kinds that give every flag a value from their operands (INC and DEC keep the carry, which a recipe holds in the carry local)
const RECIPE_KINDS = new Set('ADD SUB LOGIC INC DEC ADC SBB NEG'.split(' '));
// why a block cannot be emitted, or undefined
export function unsupported(b: Block): string | undefined {
	for (let i = 0; i < b.ins.length; i++) {
		const x = b.ins[i]!;
		const name = opName(x.op);
		if (!SUPPORTED.has(name)) return name;
		if (name === 'FLAGS' && !FLAG_KINDS.has(FK[Number(x.imm)]!)) return `FLAGS ${FK[Number(x.imm)]}`;
		if ((name === 'SETCC' || name === 'SEL' || name === 'BR') && Number(x.imm) >= 16) return `${name} cond`;
		if (name === 'EXIT' && !(x.imm & 0x100n) && Number(x.imm & 0xffn) >= 16) return 'EXIT cond';
		if ((name === 'LD' || name === 'LDS' || name === 'ST') && ![1, 2, 4, 8].includes(x.w)) return `${name} width`;
		if (name === 'BSWAP' && ![2, 4, 8].includes(x.w)) return 'BSWAP width';
		if (name === 'SYSCALL' && i !== b.ins.length - 1) return 'SYSCALL inside a block';
	}
	return undefined;
}

const HELPERS = [
	'kb_host_ic_at (i32, i32, i64, i64, i32) -> (i32)',
	'kb_load_ic (i32, i32, i64, i32) -> (i64)',
	'kb_store_ic (i32, i32, i64, i64, i32) -> ()',
	'kb_sse (i32, i32) -> (i32)',
	'kb_x87 (i32, i32) -> (i32)',
	'kb_aot_string (i32, i32, i32, i32) -> ()',
	'kb_syscall (i32) -> ()',
	'kb_aot_umulh (i64, i64) -> (i64)',
	'kb_aot_smulh (i64, i64) -> (i64)',
	'kb_aot_md (i32, i32, i32, i64) -> (i32)',
	'kb_aot_unknown (i32, i32) -> ()'
];

const imm = (v: bigint) => BigInt.asIntN(64, v).toString();
const SIGN = (w: number) => 1n << BigInt(8 * w - 1);
const MASK = (w: number) => (w >= 8 ? (1n << 64n) - 1n : (1n << BigInt(8 * w)) - 1n);

// the layout items of a region: blocks and the loops that hold blocks, in an order where every forward edge goes forward
type Item = { kind: 'block'; j: number } | { kind: 'loop'; loop: Loop; items: Item[] };

export function layoutOf(succ: number[][], loops: Loop[], runs: bigint[]): Item[] {
	const n = succ.length;
	const level = (members: number[], parent: number): Item[] => {
		if (!members.length) return [];
		const comps = sccs(members, succ);
		const compOf = new Map<number, number>();
		comps.forEach((c, k) => c.forEach((j) => compOf.set(j, k)));
		const min = comps.map((c) => Math.min(...c));
		const unitOf = comps.map((c): Item => {
			if (c.length === 1 && !succ[c[0]!]!.includes(c[0]!)) return { kind: 'block', j: c[0]! };
			const lp = loops.find((l) => l.parent === parent && l.blocks.size === c.length && c.every((j) => l.blocks.has(j)))!;
			return { kind: 'loop', loop: lp, items: [] };
		});
		// reverse postorder of the unit DAG; the last successor visited comes straight after its block
		const seen = new Set<number>();
		const post: number[] = [];
		const unitsOut = (k: number) => {
			const to: number[] = [];
			for (const j of comps[k]!) for (const t of succ[j]!) if (compOf.has(t) && compOf.get(t) !== k && !to.includes(compOf.get(t)!)) to.push(compOf.get(t)!);
			return to;
		};
		const visit = (root: number) => {
			seen.add(root);
			const stack: { k: number; to: number[]; at: number }[] = [{ k: root, to: unitsOut(root), at: 0 }];
			while (stack.length) {
				const top = stack[stack.length - 1]!;
				if (top.at === top.to.length) {
					post.push(top.k);
					stack.pop();
					continue;
				}
				const t = top.to[top.at++]!;
				if (seen.has(t)) continue;
				seen.add(t);
				stack.push({ k: t, to: unitsOut(t), at: 0 });
			}
		};
		[...comps.keys()].sort((a, b) => min[a]! - min[b]!).forEach((k) => seen.has(k) || visit(k));
		return post.reverse().map((k) => {
			const u = unitOf[k]!;
			if (u.kind === 'loop') {
				const h = u.loop.header;
				u.items = [{ kind: 'block', j: h }, ...level([...u.loop.blocks].filter((j) => j !== h), u.loop.id)];
			}
			return u;
		});
	};
	void runs;
	return level([...Array(n).keys()], -1);
}

interface Rep {
	ty: 'i64' | 'i32';
	// the local holds the whole value (its upper 32 bits are zero), so it widens by zero extension
	fits: boolean;
}

// the narrow readers of a value: ops that look only at its low 32 bits
const FLAGS_RAW = new Set(['SHL', 'SHR', 'SAR', 'ROL', 'ROR', 'MULOV', 'SETC']);
const NARROW_ALU = new Set(['ADD', 'SUB', 'MUL', 'AND', 'OR', 'XOR']);

// the build stops when a struct moved: every offset L holds becomes a compile-time check in tables.c
export function layoutChecks(): string[] {
	const at = (type: string, field: string, want: number) => `_Static_assert(offsetof(struct ${type}, ${field}) == ${want}, "${type}.${field} moved");`;
	const size = (type: string, want: number) => `_Static_assert(sizeof(struct ${type}) == ${want}, "${type} size changed");`;
	return [
		size('kb_ins', L.insSize),
		size('kb_ic', L.icSize),
		at('kb_ic', 'lo', L.icLo),
		at('kb_ic', 'span', L.icSpan),
		at('kb_ic', 'host', L.icHost),
		at('kb_ic', 'gen', L.icGen),
		at('kb_cpu', 'r', L.cpuR),
		at('kb_cpu', 'pc', CPU_PC),
		at('kb_cpu', 'fs', L.cpuFs),
		at('kb_cpu', 'n', L.cpuN),
		at('kb_cpu', 'z', L.cpuZ),
		at('kb_cpu', 'c', L.cpuC),
		at('kb_cpu', 'v', L.cpuV),
		at('kb_cpu', 'p', L.cpuP),
		at('kb_cpu', 'df', L.cpuDf),
		at('kb_cpu', 'exited', L.cpuExited),
		at('kb_cpu', 'mapgen', L.cpuMapgen),
		at('kb_cpu', 'fault', L.cpuFault),
		at('kb_cpu', 'ipc', L.cpuIpc),
		at('kb_cpu', 'fault_sig', L.cpuFaultSig),
		at('kb_cpu', 'sigreturned', L.cpuSigreturned),
		at('kb_block', 'ins', L.blkIns),
		at('kb_block', 'ic', L.blkIc)
	];
}

export function emitRegions(regions: RegionIn[], cfg: EmitConfig): { asm: string; tables: string; reports: RegionReport[] } {
	const asm: string[] = [
		'\t.globaltype\t__memory_base, i32, immutable',
		...HELPERS.map((h) => `\t.functype\t${h.replace(' ', '\t')}`),
		...(cfg.loc ? LOC_FILES.map((f, k) => `\t.file\t${k + 1} "${f}"`) : []),
		'\t.text'
	];
	const tab: string[] = ['#include <stddef.h>', '#include <string.h>', '#include "aot.h"', '', ...layoutChecks(), ''];
	const reports: RegionReport[] = [];
	const entries: { pc: bigint; next: bigint; target: bigint; n: number; region: number; idx: number; name: string; pcs: string }[] = [];
	const sizes: number[] = [];
	const windowsPer: number[] = [];
	// a region of no blocks (a function the run never reached) is dropped unless it is the only one
	const kept = regions.filter((r) => r.chosen.length > 0);
	const live = kept.length ? kept : regions.slice(0, 1);
	// direct calls: an edge into another region that has no syscall (a syscall can fork or switch threads and needs every register
	// in the cpu); an edge that would close a cycle between regions leaves instead, so each callee is emitted before its callers
	const owner = new Map<bigint, number>();
	const emittable = live.map((r) => r.chosen.filter((b) => !unsupported(b)));
	emittable.forEach((bs, k) => bs.forEach((b) => owner.has(b.pc) || owner.set(b.pc, k)));
	const noSyscall = emittable.map((bs) => bs.every((b) => b.ins.every((x) => opName(x.op) !== 'SYSCALL')));
	const calleesOf = emittable.map((bs, k) => {
		const out = new Map<bigint, number>();
		if (cfg.calls && cfg.calls !== 'off')
			for (const b of bs)
				for (const t of edgesOf(b)) {
					const to = owner.get(t);
					if (to !== undefined && to !== k && noSyscall[to]) out.set(t, to);
				}
		return out;
	});
	const order: number[] = [];
	const visiting = live.map(() => 0);
	const visit = (r: number) => {
		visiting[r] = 1;
		for (const [to, c] of [...calleesOf[r]!]) {
			if (visiting[c] === 1) calleesOf[r]!.delete(to);
			else if (visiting[c] === 0) visit(c);
		}
		visiting[r] = 2;
		order.push(r);
	};
	live.forEach((_, r) => visiting[r] || visit(r));
	const called = new Set([...calleesOf].flatMap((m) => [...m.values()]));
	const infos: CalleeInfo[] = [];
	const doneBy: ReturnType<typeof emitRegion>[] = [];
	for (const rn of order) doneBy[rn] = emitRegion(live[rn]!, rn, cfg, calleesOf[rn]!, infos, called.has(rn));
	// a callee's text comes before its callers, so its function type is declared where a call needs it
	for (const rn of order) for (const line of doneBy[rn]!.asm) asm.push(line);
	live.forEach((region, rn) => {
		void region;
		const done = doneBy[rn]!;
		reports.push(done.report);
		sizes.push(done.blocks.length);
		windowsPer.push(done.windows);
		const R = `r${rn}`;
		tab.push(`extern uint64_t ${R}_run(struct kb_cpu*, uint64_t) __attribute__((visibility("hidden")));`);
		tab.push(`unsigned char ${R}_ok[${Math.max(1, done.blocks.length)}] __attribute__((visibility("hidden")));`);
		tab.push(`struct kb_block* ${R}_blk[${Math.max(1, done.blocks.length)}] __attribute__((visibility("hidden")));`);
		tab.push(`struct kb_ic ${R}_win[${Math.max(1, done.windows)}] __attribute__((visibility("hidden")));`);
		done.blocks.forEach((b, j) => {
			tab.push(`static const struct kb_ins ${R}_i${j}[] = {`);
			for (const x of b.ins) tab.push(`\t{${x.op}, ${x.w}, ${x.a}, ${x.b}, ${x.c}, (int64_t) ${hex(x.imm)}},`);
			tab.push('};');
			if (b.pcs) tab.push(`static const uint32_t ${R}_p${j}[] = {${b.pcs.map((v) => `${v >>> 0}u`).join(', ')}};`);
			entries.push({ pc: b.pc, next: b.next, target: b.target, n: b.ins.length, region: rn, idx: j, name: `${R}_i${j}`, pcs: b.pcs ? `${R}_p${j}` : 'NULL' });
		});
	});
	entries.sort((a, b) => (a.pc < b.pc ? -1 : a.pc > b.pc ? 1 : 0));
	tab.push(
		'static const struct aot_entry aot_table[] = {',
		...entries.map((e) => `\t{${hex(e.pc)}, ${hex(e.next)}, ${hex(e.target)}, ${e.n}, ${e.region}, ${e.idx}, ${e.name}, ${e.pcs}},`),
		'};',
		`static unsigned char* const aot_ok[] = {${live.map((_, r) => `r${r}_ok`).join(', ')}};`,
		`static struct kb_block** const aot_blk[] = {${live.map((_, r) => `r${r}_blk`).join(', ')}};`,
		`static const int aot_n[] = {${sizes.join(', ')}};`,
		`static uint64_t (*const aot_run[])(struct kb_cpu*, uint64_t) = {${live.map((_, r) => `r${r}_run`).join(', ')}};`,
		'',
		'void kb_aot_detach(struct kb_block* b) {',
		`\tfor (int r = 0; r < ${live.length}; r++)`,
		'\t\tfor (int i = 0; i < aot_n[r]; i++)',
		'\t\t\tif (aot_blk[r][i] == b) {',
		'\t\t\t\taot_ok[r][i] = 0;',
		'\t\t\t\taot_blk[r][i] = NULL;',
		'\t\t\t}',
		'}',
		'',
		'void kb_aot_attach(struct kb_cpu* cpu, struct kb_block* b) {',
		'\t(void) cpu;',
		`\tint lo = 0, hi = ${entries.length};`,
		'\twhile (lo < hi) {',
		'\t\tint mid = (lo + hi) / 2;',
		'\t\tif (aot_table[mid].pc < b->pc) lo = mid + 1; else hi = mid;',
		'\t}',
		`\tfor (int k = lo; k < ${entries.length} && aot_table[k].pc == b->pc; k++) {`,
		'\t\tconst struct aot_entry* e = &aot_table[k];',
		'\t\tif (e->next != b->next || e->target != b->target || e->n != b->n) continue;',
		'\t\tint same = 1;',
		'\t\tfor (int i = 0; same && i < e->n; i++) {',
		'\t\t\tconst struct kb_ins *x = &e->ins[i], *y = &b->ins[i];',
		'\t\t\tsame = x->op == y->op && x->w == y->w && x->a == y->a && x->b == y->b && x->c == y->c && x->imm == y->imm;',
		'\t\t}',
		'\t\tif (!same) continue;',
		'\t\tif (e->pcs && b->pcs && memcmp(e->pcs, b->pcs, (size_t) e->n * sizeof *e->pcs)) continue;',
		'\t\taot_ok[e->region][e->idx] = 1;',
		'\t\taot_blk[e->region][e->idx] = b;',
		'\t\tb->aot = aot_run[e->region];',
		'\t\treturn;',
		'\t}',
		'}'
	);
	return { asm: `${asm.join('\n')}\n`, tables: `${tab.join('\n')}\n`, reports };
}

// what a caller needs of a region it calls: the registers it takes and the ones it hands back
export interface CalleeInfo {
	name: string;
	params: number[];
	results: number[];
}

function emitRegion(region: RegionIn, rn: number, cfg: EmitConfig, calls: Map<bigint, number>, infos: CalleeInfo[], isCallee: boolean) {
	const R = `r${rn}`;
	const mutate = cfg.mutate;
	const all64 = !!cfg.wide;
	// a block with an op the emitter does not take is an exit: out of the region before anything else is decided
	const exits: { pc: bigint; why: string }[] = [];
	// mutant: a push stores after it moves rsp, as the decoder did before it stored first
	const rspFirst = (b: Block): Block => {
		const ins = [...b.ins];
		for (let i = 0; i + 2 < ins.length; i++) {
			const [s, m, u] = [ins[i]!, ins[i + 1]!, ins[i + 2]!];
			if (opName(s.op) === 'ST' && s.w === 8 && s.b === SP && s.imm === -8n && opName(m.op) === 'MOVI' && opName(u.op) === 'SUB' && u.a === SP && u.b === SP && u.c === m.a) {
				ins[i] = m;
				ins[i + 1] = u;
				ins[i + 2] = { ...s, imm: 0n };
			}
		}
		const swapped = { ...b, ins };
		original.set(swapped, b);
		return swapped;
	};
	// the interpreter's block, whose instructions a region is attached by
	const original = new Map<Block, Block>();
	const chosen = (mutate === 'rspfirst' ? region.chosen.map(rspFirst) : region.chosen).filter((b) => {
		const why = unsupported(b);
		if (why) exits.push({ pc: b.pc, why });
		return !why;
	});
	const n = chosen.length;
	const index = new Map(chosen.map((b, j) => [b.pc, j]));
	const planner = windowPlanner({ identity: false, bounds: true, two: true, big: 1n << 16n, mutate: '' });
	const dumpMap = new Map(region.all.map((b) => [b.pc, b]));
	const recipeMode = cfg.flags === 'recipe';
	const dead = cfg.flags === 'all' ? new Set<string>() : deadFlags(chosen, index, calls, dumpMap, { mode: recipeMode ? 'live' : cfg.flags, mutate: '', identity: false });
	// recipe mode: which FLAGS ops are kept as a recipe. A recipe lives to the next op that defines every flag, so it must not be
	// asked for in the five locals before that: a shift or rotate (it keeps the old flags at a zero count), a helper, a syscall, an
	// indirect jump, a call, or an edge into a block that reads flags (a block is entered with the flags in the locals, whichever
	// edge it came by). Those FLAGS ops stay eager, with the reason
	const recipes = new Set<string>();
	const eagerWhy = new Map<string, string>();
	// edge mode: the flags each block reads at its start (a mask), and below the recipe each one takes in
	const edgeOn = recipeMode && (cfg.edge === true || (Array.isArray(cfg.edge) && cfg.edge.includes(rn)));
	let flagsIn: number[] = [];
	if (recipeMode) {
		const live = flagLiveness(chosen, index, calls, dumpMap, { mode: 'live', mutate: '', identity: false });
		flagsIn = live.live;
		const demand = (pc: bigint) => {
			const k = index.get(pc);
			if (k !== undefined) return live.live[k]! && !edgeOn ? 'live-in' : '';
			return calls.has(pc) ? 'call' : '';
		};
		chosen.forEach((b, j) => {
			b.ins.forEach((x, i) => {
				if (opName(x.op) !== 'FLAGS' || dead.has(`${j}:${i}`) || !RECIPE_KINDS.has(FK[Number(x.imm)]!)) return;
				const lastName = opName(b.ins.at(-1)!.op);
				let why = '';
				let ended = false;
				scan: for (let k = i + 1; k < b.ins.length; k++) {
					const y = b.ins[k]!;
					const name = opName(y.op);
					switch (name) {
						case 'FLAGS': {
							if (dead.has(`${j}:${k}`)) break;
							const kind = FK[Number(y.imm)]!;
							// a full definition replaces the recipe; INC, DEC, ADC and SBB read only the carry, from it
							if (!RECIPE_KINDS.has(kind)) why = 'partial';
							ended = true;
							break scan;
						}
						case 'BR':
						case 'BRZ':
							why = demand(b.target);
							break;
						case 'EXIT':
							why = demand(BigInt.asUintN(64, b.pc + BigInt.asIntN(32, y.imm >> 16n)));
							break;
						case 'JMP': {
							const t = constJump(b);
							why = t === undefined ? 'jump' : demand(t);
							ended = true;
							break scan;
						}
						case 'X86FLAGS':
							if (y.imm === 1n) {
								ended = true;
								break scan;
							}
							if (y.imm <= 4n) why = 'x86flags';
							break;
						case 'X86SHD':
							why = 'partial';
							break;
						case 'X86MD':
						case 'SSE':
						case 'X87':
						case 'X86STR':
							why = 'helper';
							break;
						case 'SYSCALL':
							why = 'syscall';
							ended = true;
							break scan;
					}
					if (why) break;
				}
				if (!why && !ended && lastName !== 'JMP' && lastName !== 'SYSCALL') why = demand(b.next);
				if (why) eagerWhy.set(`${j}:${i}`, why);
				else recipes.add(`${j}:${i}`);
			});
		});
	}
	// edge mode: the recipe a block takes in. A block reads it until its first full definition, so it takes one only if nothing before that
	// reads the five locals (a helper, a partial flags op, a call, an indirect jump). The candidates are the recipes held where a block leaves for
	// one that reads flags, weighted by the leaving block's runs; the heaviest kind and width wins, and the other edges compute the flags
	interface Held {
		kind: string;
		w: number;
	}
	const entryRec: (Held | undefined)[] = chosen.map(() => undefined);
	if (edgeOn) {
		const accepts = (k: number) => {
			const b = chosen[k]!;
			for (let i = 0; i < b.ins.length; i++) {
				const x = b.ins[i]!;
				switch (opName(x.op)) {
					case 'FLAGS':
						if (dead.has(`${k}:${i}`)) break;
						return RECIPE_KINDS.has(FK[Number(x.imm)]!);
					case 'X86FLAGS':
						if (x.imm > 4n) break;
						return x.imm === 1n;
					case 'X86SHD':
					case 'X86MD':
					case 'SSE':
					case 'X87':
					case 'X86STR':
					case 'SYSCALL':
						return false;
					case 'BR':
					case 'BRZ':
						if (calls.has(b.target)) return false;
						break;
					case 'EXIT':
						if (calls.has(BigInt.asUintN(64, b.pc + BigInt.asIntN(32, x.imm >> 16n)))) return false;
						break;
					case 'JMP': {
						const t = constJump(b);
						return t !== undefined && !calls.has(t);
					}
				}
			}
			return !calls.has(b.next);
		};
		const votes = chosen.map(() => new Map<string, bigint>());
		chosen.forEach((b, j) => {
			let held: Held | null = null;
			const vote = (pc: bigint) => {
				const k = index.get(pc);
				if (!held || k === undefined || !flagsIn[k]) return;
				const key = `${held.kind}:${held.w}`;
				votes[k]!.set(key, (votes[k]!.get(key) ?? 0n) + b.runs);
			};
			b.ins.forEach((x, i) => {
				const name = opName(x.op);
				if (name === 'FLAGS') {
					if (!dead.has(`${j}:${i}`)) held = recipes.has(`${j}:${i}`) ? { kind: FK[Number(x.imm)]!, w: x.w } : null;
				} else if (name === 'X86FLAGS' && x.imm === 1n) held = null;
				else if (name === 'BR' || name === 'BRZ') vote(b.target);
				else if (name === 'EXIT') vote(BigInt.asUintN(64, b.pc + BigInt.asIntN(32, x.imm >> 16n)));
			});
			const last = opName(b.ins.at(-1)!.op);
			if (last === 'JMP') {
				const t = constJump(b);
				if (t !== undefined) vote(t);
			} else if (last !== 'SYSCALL') vote(b.next);
		});
		chosen.forEach((_, k) => {
			if (!accepts(k)) return;
			let best = '';
			let most = -1n;
			for (const [key, v] of votes[k]!) if (v > most) [best, most] = [key, v];
			if (best) entryRec[k] = { kind: best.split(':')[0]!, w: Number(best.split(':')[1]) };
		});
	}

	// registers: cross-block state is i64 locals; a temporary read before it is written in a block is state too. A region that calls
	// or is called holds every register a helper reads or writes and every register of its callees, so a register is never in the cpu
	// on one side of a call and in a local on the other
	const direct = !!cfg.calls && cfg.calls !== 'off';
	const regs = regionRegs(chosen, direct);
	const extraCross = new Set<number>();
	for (const c of calls.values())
		for (const r of infos[c]!.params) {
			regs.add(r);
			extraCross.add(r);
		}
	const liveIn = liveInTemps(chosen);
	const cross = (r: number) => !isTemp(r) || liveIn.has(r) || extraCross.has(r);
	const regList = [...regs].filter(cross).sort((a, b) => a - b);
	// the registers some block writes: all a callee has to hand back (the others are the caller's own)
	const written = new Set<number>();
	for (const b of chosen)
		for (const x of b.ins) {
			const name = opName(x.op);
			for (const r of rw(x).w) written.add(r);
			if (name === 'SSE' || name === 'X87' || name === 'X86STR') for (const r of touches(x).w) written.add(r);
			if (name === 'X86MD') [0, 2].forEach((r) => written.add(r));
		}
	for (const c of calls.values()) for (const r of infos[c]!.results) written.add(r);
	const results = cfg.calls === 'all' ? regList : regList.filter((r) => written.has(r));
	infos[rn] = { name: R, params: regList, results };

	// #region locals
	const types: ('i32' | 'i64')[] = [];
	const names = new Map<string, number>();
	const local = (name: string, ty: 'i32' | 'i64') => {
		let at = names.get(name);
		if (at === undefined) {
			at = 2 + types.length;
			types.push(ty);
			names.set(name, at);
		}
		return at;
	};
	const CPU = 0;
	const PC = 1;
	const g = (r: number) => local(`g${r}`, 'i64');
	const h = (r: number) => local(`h${r}`, 'i32');
	// a callee takes its registers, flags and the mapping generation as parameters, which are its first locals
	if (isCallee) regList.forEach(g);
	const fl = { n: local('fn', 'i32'), z: local('fz', 'i32'), c: local('fc', 'i32'), v: local('fv', 'i32'), p: local('fp', 'i32') };
	const dfl = local('df', 'i32');
	const gen = local('gen', 'i32');
	const okb = local('okb', 'i32');
	const blkb = local('blkb', 'i32');
	const winb = local('winb', 'i32');
	const bp = local('bp', 'i32');
	const ic = local('ic', 'i32');
	const eloc = local('e', 'i32');
	const gfs = local('gfs', 'i64');
	const sva = local('sva', 'i64');
	const swp = local('swp', 'i32');
	const sq = local('sq', 'i32');
	const sa = local('sa', 'i64');
	const sb = local('sb', 'i64');
	const sr = local('sr', 'i64');
	const sv = local('sv', 'i64');
	const smd = local('smd', 'i32');
	// #endregion

	const out: string[] = [];
	// each operator (not a constant, a local move or a frame marker) is counted under the category being emitted, weighted by the block's runs
	let cat = 'arith';
	let runsNow = 0n;
	const catStat = new Map<string, { static: number; weighted: bigint }>();
	const classify = (l: string) => {
		const [op = '', arg = ''] = l.split('\t');
		if (op === 'call') return 'helpers';
		if (/^br/.test(op)) return 'dispatch';
		if (/^i(32|64)\.(load|store)/.test(op)) {
			const off = Number(arg.split(':')[0]);
			return off === 0 ? 'guest' : off === L.icHost ? 'address' : 'guards';
		}
		if (op === 'if' || op === 'else' || /\.(eq|ne|eqz|lt_[us]|le_[us]|gt_[us]|ge_[us]|and|or)$/.test(op)) return 'guards';
		return 'address';
	};
	let locPc = 0;
	let locCat = '';
	let locKey = '';
	const o = (...ls: string[]) =>
		ls.forEach((l) => {
			const counted = !/^(#|end|block|loop|local\.|i32\.const|i64\.const|drop)/.test(l);
			const c = cat === 'access' ? classify(l) : cat;
			if (cfg.loc && l[0] !== '#') {
				const lc = counted || cat !== 'access' ? c : locCat || 'address';
				const key = `${lc}:${locPc}`;
				if (key !== locKey) {
					locKey = key;
					locCat = lc;
					out.push(`\t.loc\t${LOC_FILES.indexOf(lc === 'helpers' ? 'calls' : lc) + 1} ${locPc} 0`);
				}
			}
			out.push(`\t${l}`);
			if (!counted) return;
			const e = catStat.get(c) ?? catStat.set(c, { static: 0, weighted: 0n }).get(c)!;
			e.static++;
			e.weighted += runsNow;
		});
	const as = <T>(c: string, f: () => T): T => {
		const p = cat;
		cat = c;
		try {
			return f();
		} finally {
			cat = p;
		}
	};
	const frames: string[] = [];
	const depth = (id: string) => {
		const at = frames.lastIndexOf(id);
		if (at < 0) throw new Error(`no frame ${id}`);
		return frames.length - 1 - at;
	};
	const open = (kind: string, id: string) => {
		o(kind);
		frames.push(id);
	};
	const close = (kind: string) => {
		o(kind);
		frames.pop();
	};
	const br = (id: string) => o(`br\t${depth(id)}`);
	// #region recipes
	// the flags of the latest recipe in this block: kind and width, with its operands in four locals (a, b, result, carry in)
	interface Recipe {
		kind: string;
		w: number;
		// taken in at the block's start (edge mode): the operands hold the flags only while `warm` is set, else the five locals do
		dual?: boolean;
	}
	let cur: Recipe | null = null;
	const fstat = { total: 0, dead: 0, recipe: 0, eager: 0, deadW: 0n, recipeW: 0n, eagerW: 0n, why: {} as Record<string, number>, whyW: {} as Record<string, bigint>, stubs: 0, predicates: 0 };
	const edgeStats = { entries: entryRec.filter(Boolean).length, passed: 0, passedW: 0n, materialized: 0, materializedW: 0n };
	const slot = () => ({ qa: local('qa', 'i64'), qb: local('qb', 'i64'), qr: local('qr', 'i64'), qc: local('qc', 'i64') });
	// one flag of a recipe, as an i32 on the stack (the same arithmetic as the eager flags, on the saved operands)
	const rflag0 = (rc: Recipe, f: 'n' | 'z' | 'c' | 'v' | 'p') => {
		const { qa, qb, qr, qc } = slot();
		const w = rc.w;
		const sg = SIGN(w);
		const mk = MASK(w);
		const signOf = (e: () => void) => {
			e(); i64c(sg); o('i64.and'); o('i64.eqz'); o('i32.eqz');
		};
		const ovAdd = () => signOf(() => {
			lget(qa); lget(qb); o('i64.xor'); i64c(-1n); o('i64.xor'); lget(qa); lget(qr); o('i64.xor'); o('i64.and');
		});
		const ovSub = () => signOf(() => {
			lget(qa); lget(qb); o('i64.xor'); lget(qa); lget(qr); o('i64.xor'); o('i64.and');
		});
		switch (f) {
			case 'z':
				lget(qr); o('i64.eqz');
				return;
			case 'n':
				signOf(() => lget(qr));
				return;
			case 'p':
				lget(qr); i64c(0xffn); o('i64.and'); o('i64.popcnt', 'i32.wrap_i64'); i32c(1); o('i32.and'); o('i32.eqz');
				return;
			case 'c':
				switch (rc.kind) {
					case 'ADD':
						lget(qr); lget(qa); o('i64.lt_u');
						return;
					case 'ADC':
						if (w < 8) {
							lget(qa); lget(qb); o('i64.add'); lget(qc); o('i64.add'); i64c(mk); o('i64.gt_u');
						} else {
							lget(qc); o('i64.eqz');
							o('if\ti32');
							lget(qr); lget(qa); o('i64.lt_u');
							o('else');
							lget(qr); lget(qa); o('i64.le_u');
							o('end_if');
						}
						return;
					case 'SUB':
						lget(qa); lget(qb); o('i64.lt_u');
						return;
					case 'SBB':
						if (w < 8) {
							lget(qa); lget(qb); lget(qc); o('i64.add'); o('i64.lt_u');
						} else {
							lget(qa); lget(qb); o('i64.lt_u');
							lget(qc); o('i64.eqz'); o('i32.eqz'); lget(qa); lget(qb); o('i64.eq'); o('i32.and'); o('i32.or');
						}
						return;
					case 'NEG':
						lget(qb); i64c(0n); o('i64.ne');
						return;
					case 'LOGIC':
						i32c(0);
						return;
					default:
						// INC and DEC keep the carry, which sits in its local
						lget(fl.c);
						return;
				}
			case 'v':
				switch (rc.kind) {
					case 'ADD':
					case 'ADC':
						ovAdd();
						return;
					case 'SUB':
					case 'SBB':
						ovSub();
						return;
					case 'NEG':
						lget(qb); i64c(sg); o('i64.eq');
						return;
					case 'INC':
						lget(qr); i64c(sg); o('i64.eq');
						return;
					case 'DEC':
						lget(qr); i64c(sg - 1n); o('i64.eq');
						return;
					default:
						i32c(0);
						return;
				}
		}
	};
	// a recipe taken in at a block's start holds only when an edge of the region entered the block (`warm`); entered by the interpreter,
	// the five locals hold the flags. The carry of INC and DEC is in its local either way
	const warm = () => local('warm', 'i32');
	const flagLocals5 = { n: fl.n, z: fl.z, c: fl.c, v: fl.v, p: fl.p };
	const rflag = (rc: Recipe, f: 'n' | 'z' | 'c' | 'v' | 'p') => {
		if (!rc.dual || ((rc.kind === 'INC' || rc.kind === 'DEC') && f === 'c')) return rflag0(rc, f);
		lget(warm());
		o('if\ti32');
		rflag0(rc, f);
		o('else');
		lget(flagLocals5[f]);
		o('end_if');
	};
	// a condition code (the x86 ones, 0..15) from the five locals
	const condLocals = (c: number) => {
		const f = (x: number) => lget(x);
		switch (c >> 1) {
			case 0: f(fl.v); break;
			case 1: f(fl.c); break;
			case 2: f(fl.z); break;
			case 3: f(fl.c); f(fl.z); o('i32.or'); break;
			case 4: f(fl.n); break;
			case 5: f(fl.p); break;
			case 6: f(fl.n); f(fl.v); o('i32.xor'); break;
			default: f(fl.z); f(fl.n); f(fl.v); o('i32.xor'); o('i32.or'); break;
		}
		if (c & 1) o('i32.eqz');
	};
	// a condition code (the x86 ones, 0..15) from a recipe: after a compare the signed and unsigned orderings are one comparison of
	// the saved operands
	const rcond = (rc: Recipe, c: number) => {
		if (!rc.dual) return rcond0(rc, c);
		lget(warm());
		o('if\ti32');
		rcond0({ ...rc, dual: false }, c);
		o('else');
		condLocals(c);
		o('end_if');
	};
	const rcond0 = (rc: Recipe, c: number) => {
		const { qa, qb } = slot();
		const sub = rc.kind === 'SUB';
		const cmp = (op: string, signed: boolean) => {
			if (signed && rc.w < 8) {
				const k = BigInt(64 - 8 * rc.w);
				lget(qa); i64c(k); o('i64.shl'); lget(qb); i64c(k); o('i64.shl');
			} else {
				lget(qa); lget(qb);
			}
			o(`i64.${op}`);
		};
		switch (c >> 1) {
			case 0: rflag(rc, 'v'); break;
			case 1: rflag(rc, 'c'); break;
			case 2: rflag(rc, 'z'); break;
			case 3:
				if (sub) cmp('le_u', false);
				else { rflag(rc, 'c'); rflag(rc, 'z'); o('i32.or'); }
				break;
			case 4: rflag(rc, 'n'); break;
			case 5: rflag(rc, 'p'); break;
			case 6:
				if (sub) cmp('lt_s', true);
				else { rflag(rc, 'n'); rflag(rc, 'v'); o('i32.xor'); }
				break;
			default:
				if (sub) cmp('le_s', true);
				else { rflag(rc, 'z'); rflag(rc, 'n'); rflag(rc, 'v'); o('i32.xor'); o('i32.or'); }
				break;
		}
		if (c & 1) o('i32.eqz');
		fstat.predicates++;
	};
	// the five flag locals from a recipe (the stub of a fault or exit)
	const rmaterialize = (rc: Recipe) => {
		if (rc.dual) {
			lget(warm());
			o('if');
			rmaterialize({ ...rc, dual: false });
			o('end_if');
			return;
		}
		for (const [f, local5] of [['n', fl.n], ['z', fl.z], ['c', fl.c], ['v', fl.v], ['p', fl.p]] as const) {
			if (f === 'c' && (rc.kind === 'INC' || rc.kind === 'DEC')) continue;
			if (f === 'z' && mutate === 'stubflag') continue;
			rflag(rc, f);
			lset(local5);
		}
		fstat.stubs++;
	};
	// #endregion
	const exitTo = (pc: bigint) => {
		if (cur) {
			const rc = cur;
			as('flags', () => rmaterialize(rc));
		}
		o(`i64.const\t${imm(pc)}`, `local.set\t${PC}`);
		br('OUT');
	};
	const lget = (i: number) => o(`local.get\t${i}`);
	const lset = (i: number) => o(`local.set\t${i}`);
	const i32c = (v: number) => o(`i32.const\t${v}`);
	const i64c = (v: bigint) => o(`i64.const\t${imm(v)}`);
	const cpuLoad32 = (off: number) => as('state', () => o(`local.get\t${CPU}`, `i32.load\t${off}:p2align=0`));
	const cpuStore32 = (off: number, valueFrom: () => void) =>
		as('state', () => {
			lget(CPU);
			valueFrom();
			o(`i32.store\t${off}:p2align=0`);
		});
	const cpuStore64 = (off: number, valueFrom: () => void) =>
		as('state', () => {
			lget(CPU);
			valueFrom();
			o(`i64.store\t${off}:p2align=0`);
		});
	// the pending-signal flag: kb_pending_flag points at it
	const pending = () => as('safepoints', () => o('global.get\tkb_pending_flag@GOT', 'i32.load\t0:p2align=0', 'i32.load\t0:p2align=0'));

	// #region control structure
	// the return addresses a block pushes (constants that are blocks of this region): a call out of the block can come back to them
	const pushedOf = (b: Block) => [...new Set(b.ins.filter((x) => opName(x.op) === 'MOVI').map((x) => BigInt.asUintN(64, x.imm)))].filter((v) => index.has(v));
	const succ = chosen.map((b) => {
		const to = edgesOf(b);
		const back = to.some((t) => calls.has(t)) ? pushedOf(b) : [];
		return [...to, ...back].map((t) => index.get(t)).filter((k): k is number => k !== undefined);
	});
	const nest = findLoops(succ, chosen.map((b) => b.runs));
	const layout = layoutOf(succ, nest.loops, chosen.map((b) => b.runs));
	// each block's position in the layout (a loop's blocks are contiguous), its loops outer to inner, the item it is in at each level
	const pos: number[] = [];
	const chainOf = chosen.map((_, j) => {
		const c: number[] = [];
		for (let l = nest.of[j]!; l >= 0; l = nest.loops[l]!.parent) c.unshift(l);
		return c;
	});
	const itemAt = new Map<string, number>();
	const itemIsLoop = new Map<string, Loop | undefined>();
	const posRange = new Map<number, [number, number]>();
	let counter = 0;
	const number = (items: Item[], level: number) => {
		items.forEach((it, k) => {
			if (it.kind === 'block') {
				pos[it.j] = counter++;
				itemAt.set(`${level}:${it.j}`, k);
				itemIsLoop.set(`${level}:${k}`, undefined);
			} else {
				const lo = counter;
				number(it.items, it.loop.id);
				posRange.set(it.loop.id, [lo, counter - 1]);
				itemIsLoop.set(`${level}:${k}`, it.loop);
				for (let j = 0; j < n; j++) if (it.loop.blocks.has(j)) itemAt.set(`${level}:${j}`, k);
			}
		});
	};
	number(layout, -1);
	const fallbackBlocks = new Set<number>();
	// an edge from block j to block k: the loop entry switch's selector and the frame to branch to
	const edge = (j: number, k: number, count = true) => {
		const cu = chainOf[j]!;
		const cv = chainOf[k]!;
		let p = 0;
		while (p < cu.length && p < cv.length && cu[p] === cv[p]) p++;
		const lvl = p > 0 ? cu[p - 1]! : -1;
		if (lvl >= 0 && nest.loops[lvl]!.header === k) {
			br(`L${lvl}`);
			return;
		}
		const at = itemAt.get(`${lvl}:${k}`)!;
		const lp = itemIsLoop.get(`${lvl}:${at}`);
		if (lp && lp.header !== k) {
			i32c(pos[k]!);
			lset(eloc);
			if (count) fallbackBlocks.add(k);
		}
		br(`F${lvl}_${at}`);
	};
	// #endregion

	// #region the windows
	const loopWrites = nest.loops.map((l) => {
		const w = new Set<number>();
		for (const j of l.blocks)
			for (const x of chosen[j]!.ins) {
				const name = opName(x.op);
				for (const r of rw(x).w) w.add(r);
				if (name === 'X86STR' || name === 'SSE' || name === 'X87') for (const r of touches(x).w) w.add(r);
				if (name === 'X86MD') [0, 2].forEach((r) => w.add(r));
				if (name === 'SYSCALL') [0, 1, 11].forEach((r) => w.add(r));
			}
		return w;
	});
	let windowCount = 0;
	const loopWins: Win[] = [];
	const loopHits = new Map<number, Map<number, Hit>>();
	const byLoop = new Map<number, number[]>();
	{
		const KEY = 1 << 16;
		const per = new Map<number, Acc[]>();
		chosen.forEach((b, j) => {
			if (nest.of[j]! < 0) return;
			for (const a of planner.accessesOf(b, false)) {
				const owner = chainOf[j]!.find((o2) => a.root < 0 || !loopWrites[o2]!.has(a.root));
				if (owner !== undefined) (per.get(owner) ?? per.set(owner, []).get(owner)!).push({ ...a, i: j * KEY + a.i });
			}
		});
		for (const [owner, list] of [...per].sort((p, q) => p[0] - q[0])) {
			const grouped = planner.group(list);
			const first = loopWins.length;
			byLoop.set(owner, grouped.wins.map((_, k) => first + k));
			for (const w of grouped.wins) {
				w.ic = windowCount;
				windowCount += w.two ? 2 : 1;
				loopWins.push(w);
			}
			for (const [key, hit] of grouped.hits) {
				const j = Math.floor(key / KEY);
				(loopHits.get(j) ?? loopHits.set(j, new Map()).get(j)!).set(key % KEY, { ...hit, win: first + hit.win, loop: true });
			}
		}
	}
	const lw = (k: number) => local(`lw${k}`, 'i32');
	const lx = (k: number) => local(`lx${k}`, 'i32');
	const lva = (k: number) => local(`lva${k}`, 'i64');
	const lbd = (k: number) => local(`lbd${k}`, 'i64');
	// #endregion

	// the flag locals' reads and writes, and the pieces of arithmetic both use
	const icAt = (base: number, idx: number, field: number) => `${base === winb ? '' : ''}${field + idx * L.icSize}`;
	void icAt;
	const q = (base: number, idx: number) => {
		lget(base);
		i32c(idx * L.icSize);
		o('i32.add');
	};

	// #region windows: resolve one into locals
	interface Vars {
		w: number;
		va: number;
		x: number;
		bd: number;
	}
	// the host bytes of [va, va + len) of the window's inline cache `at`, or 0; two-piece windows resolve through both pieces
	const openWindow = (w: Win, v: Vars, at: number) => {
		const len = BigInt(w.hi - w.lo);
		// a window with a store resolves for writing (KB_W 2), the rest for reading (KB_R 1)
		const acc = w.store && mutate !== 'storeread' ? 2 : 1;
		// va = root + lo
		if (w.root < 0) i64c(w.lo);
		else {
			lget(g(w.root));
			i64c(w.lo);
			o('i64.add');
		}
		lset(v.va);
		const field = (idx: number, f: number, ty: 'i32' | 'i64') => o(`local.get\t${winb}`, `${ty}.load\t${f + idx * L.icSize}:p2align=0`);
		const resolve = (idx: number, vaFrom: () => void, lenFrom: () => void, lenConst: bigint | undefined, into: number) => {
			// gen == q.gen && len <= span && va - lo <= span - len ? host + (va - lo) : kb_host_ic_at(cpu, q, va, len, acc)
			field(idx, L.icGen, 'i32');
			lget(gen);
			o('i32.eq');
			vaFrom();
			field(idx, L.icLo, 'i64');
			o('i64.sub');
			field(idx, L.icSpan, 'i64');
			lenFrom();
			o('i64.sub');
			o('i64.le_u');
			o('i32.and');
			lenFrom();
			field(idx, L.icSpan, 'i64');
			o('i64.le_u');
			o('i32.and');
			o('if\ti32');
			field(idx, L.icHost, 'i32');
			vaFrom();
			field(idx, L.icLo, 'i64');
			o('i64.sub', 'i32.wrap_i64', 'i32.add');
			o('else');
			lget(CPU);
			q(winb, idx);
			vaFrom();
			lenFrom();
			i32c(acc);
			o('call\tkb_host_ic_at');
			o('end_if');
			lset(into);
			void lenConst;
		};
		if (!w.two) {
			resolve(at, () => lget(v.va), () => i64c(len), len, v.w);
			return;
		}
		// a two-piece window: piece 0 from va, piece 1 from the end of piece 0 when the window runs over
		const p0 = local('tp0', 'i32');
		const endl = local('tend', 'i64');
		const need = local('tneed', 'i64');
		// piece 0: the host bytes of va (one byte), through the same check
		field(at, L.icGen, 'i32');
		lget(gen);
		o('i32.eq');
		lget(v.va);
		field(at, L.icLo, 'i64');
		o('i64.sub');
		field(at, L.icSpan, 'i64');
		o('i64.lt_u');
		o('i32.and');
		o('if\ti32');
		field(at, L.icHost, 'i32');
		lget(v.va);
		field(at, L.icLo, 'i64');
		o('i64.sub', 'i32.wrap_i64', 'i32.add');
		o('else');
		lget(CPU);
		q(winb, at);
		lget(v.va);
		i64c(1n);
		i32c(acc);
		o('call\tkb_host_ic_at');
		o('end_if');
		lset(p0);
		// the first piece's end
		field(at, L.icLo, 'i64');
		field(at, L.icSpan, 'i64');
		o('i64.add');
		lset(endl);
		i32c(0);
		lset(v.w);
		i32c(0);
		lset(v.x);
		i64c(-1n);
		lset(v.bd);
		lget(p0);
		o('if');
		// the window ends inside piece 0
		lget(v.va);
		i64c(len);
		o('i64.add');
		lget(endl);
		o('i64.le_u');
		o('if');
		lget(p0);
		lset(v.w);
		o('else');
		lget(v.va);
		i64c(len);
		o('i64.add');
		lget(endl);
		o('i64.sub');
		lset(need);
		// piece 1 from the end of piece 0, `need` bytes
		field(at + 1, L.icGen, 'i32');
		lget(gen);
		o('i32.eq');
		lget(need);
		field(at + 1, L.icSpan, 'i64');
		o('i64.le_u');
		o('i32.and');
		lget(endl);
		field(at + 1, L.icLo, 'i64');
		o('i64.sub');
		field(at + 1, L.icSpan, 'i64');
		lget(need);
		o('i64.sub');
		o('i64.le_u');
		o('i32.and');
		o('if\ti32');
		field(at + 1, L.icHost, 'i32');
		lget(endl);
		field(at + 1, L.icLo, 'i64');
		o('i64.sub', 'i32.wrap_i64', 'i32.add');
		o('else');
		lget(CPU);
		q(winb, at + 1);
		lget(endl);
		lget(need);
		i32c(acc);
		o('call\tkb_host_ic_at');
		o('end_if');
		lset(v.x);
		lget(v.x);
		o('if');
		lget(p0);
		lset(v.w);
		lget(endl);
		lset(v.bd);
		o('end_if');
		o('end_if');
		o('end_if');
	};
	// #endregion

	// the loop windows a loop opens when it is entered
	const openLoop = (id: number) => {
		for (const k of byLoop.get(id) ?? []) {
			const w = loopWins[k]!;
			as('access', () => openWindow(w, { w: lw(k), va: lva(k), x: lx(k), bd: lbd(k) }, w.ic!));
		}
	};

	const blockReports = { narrowStatic: 0, aluStatic: 0, narrowWeighted: 0n, aluWeighted: 0n, accesses: 0, windowed: 0 };
	let ownWindows = 0;
	const winSlot = new Map<number, number[]>();

	// #region a block
	const emitBlock = (j: number) => {
		const b = chosen[j]!;
		const lhits = loopHits.get(j);
		const own = planner.windowsOf(b, false, lhits && new Set(lhits.keys()));
		let slots = winSlot.get(j);
		if (!slots) {
			slots = own.wins.map((w) => {
				const at = windowCount;
				windowCount += w.two ? 2 : 1;
				return at;
			});
			winSlot.set(j, slots);
			ownWindows += own.wins.length;
		}
		o(`# block ${b.pc.toString(16)} (${j})`);
		locPc = Number(b.pc & 0x7fffffffn);
		runsNow = b.runs;
		cur = entryRec[j] ? { ...entryRec[j]!, dual: true } : null;
		// per-block state
		const rep = new Map<number, Rep>();
		const isCross = cross;
		const getRep = (r: number): Rep => rep.get(r) ?? { ty: 'i64', fits: false };
		const get64 = (r: number) => {
			if (r === KB_ZERO) return i64c(0n);
			const p = getRep(r);
			if (p.ty === 'i64') return lget(g(r));
			if (!p.fits && mutate !== 'width') throw new Error(`block ${b.pc.toString(16)}: r${r} is a wrapped 32-bit value read as 64 bits`);
			lget(h(r));
			o('i64.extend_i32_u');
		};
		const get32 = (r: number) => {
			if (r === KB_ZERO) return i32c(0);
			const p = getRep(r);
			if (p.ty === 'i32') return lget(h(r));
			lget(g(r));
			o('i32.wrap_i64');
		};
		// a register's low `w` bytes as an i64 (a flag operand is masked to the width)
		const getMasked = (r: number, w: number) => {
			if (w >= 8) return get64(r);
			if (r === KB_ZERO) return i64c(0n);
			const p = getRep(r);
			if (p.ty === 'i32') {
				lget(h(r));
				o('i64.extend_i32_u');
			} else lget(g(r));
			if (w < 4 || p.ty === 'i64') i64c(MASK(w));
			if (w < 4 || p.ty === 'i64') o('i64.and');
		};
		// the value on the stack (i64) into register r, which no later read sees as narrow
		const put64 = (r: number, fits = false) => {
			if (r === KB_ZERO) return o('drop');
			lset(g(r));
			rep.set(r, { ty: 'i64', fits });
		};
		// the value on the stack (i32) into register r: a cross register holds the zero extension, a temporary the i32 local
		const put32 = (r: number, fits: boolean) => {
			if (r === KB_ZERO) return o('drop');
			if (isCross(r)) {
				if (!fits) throw new Error(`block ${b.pc.toString(16)}: a wrapped 32-bit value into cross register r${r}`);
				o('i64.extend_i32_u');
				lset(g(r));
				rep.set(r, { ty: 'i64', fits: true });
			} else {
				lset(h(r));
				rep.set(r, { ty: 'i32', fits });
			}
		};
		const fitsOf = (r: number) => r === KB_ZERO || getRep(r).fits;

		// block-local width recovery: which ALU results only their narrow readers see, so they are computed in 32 bits
		// the constant a shift's count register holds at each op, from the block's MOVIs (a register written any other way is not one)
		const kc: (bigint | undefined)[] = [];
		{
			const kmap = new Map<number, bigint>();
			for (const x of b.ins) {
				kc.push(kmap.get(x.c));
				const name = opName(x.op);
				const writes = [...rw(x).w, ...(name === 'SSE' || name === 'X87' || name === 'X86STR' ? touches(x).w : []), ...(name === 'X86MD' ? [0, 2] : [])];
				for (const r of writes) kmap.delete(r);
				if (name === 'MOVI') kmap.set(x.a, BigInt.asUintN(64, x.imm));
				else if (name === 'MOV' && kmap.has(x.b)) kmap.set(x.a, kmap.get(x.b)!);
			}
		}
		const shlNarrow = (k: number) => opName(b.ins[k]!.op) === 'SHL' && kc[k] !== undefined && kc[k]! < 32n;
		const narrowDef = b.ins.map(() => false);
		const readers = (i: number, d: number): boolean => {
			// whether every read of d after op i (until it is written again) looks only at the low 32 bits
			for (let k = i + 1; k < b.ins.length; k++) {
				const x = b.ins[k]!;
				const name = opName(x.op);
				const { r } = rw(x);
				const reads = name === 'SSE' || name === 'X87' ? touches(x).r.includes(d) || x.b === d : r.includes(d);
				if (reads) {
					let narrow = false;
					if (name === 'ZEXT') narrow = x.w <= 4;
					else if (name === 'SEXT') narrow = x.w <= 4;
					else if (name === 'FLAGS') {
						// a count, a rotate's result and a carry's source are read as they are
						const kind = FLAGS_RAW.has(FK[Number(x.imm)]!) ? FK[Number(x.imm)]! : '';
						narrow = x.w <= 4 && !(kind && x.c === d) && !((kind === 'ROL' || kind === 'ROR') && x.a === d);
					} else if (name === 'ST') narrow = x.w <= 4 && x.a === d && x.b !== d;
					else if (name === 'BSWAP') narrow = x.w <= 4;
					else if (NARROW_ALU.has(name) || name === 'MOV') narrow = narrowDef[k]!;
					else if (name === 'SHL' && kc[k] !== undefined) narrow = x.c === d && x.b !== d ? true : narrowDef[k]!;
					if (!narrow) return false;
				}
				if (rw(x).w.includes(d)) return true;
				if (name === 'SSE' || name === 'X87' || name === 'X86STR') if (touches(x).w.includes(d)) return true;
			}
			return true;
		};
		for (let i = b.ins.length - 1; i >= 0; i--) {
			const x = b.ins[i]!;
			const name = opName(x.op);
			if ((NARROW_ALU.has(name) || name === 'MOV' || shlNarrow(i)) && x.a !== KB_ZERO && !isCross(x.a) && !all64) narrowDef[i] = readers(i, x.a) || mutate === 'width';
		}
		const aluOps = new Set(['ADD', 'SUB', 'AND', 'OR', 'XOR', 'SHL', 'SHR', 'SAR', 'MUL', 'ZEXT', 'SEXT', 'MOV', 'INS']);
		let ipc = b.pc;
		let m = 0;

		// block entry: the block and its inline caches, then the windows
		as('dispatch', () => {
			lget(blkb);
			o(`i32.load\t${j * 4}:p2align=0`);
			lset(bp);
			lget(bp);
			o(`i32.load\t${L.blkIc}:p2align=0`);
			lset(ic);
		});
		// the loop entry switch's selector is spent once a block that is not its loop's header runs
		if (nest.of[j]! >= 0 && itemAt.get(`${nest.of[j]!}:${j}`)! > 0) {
			i32c(-1);
			lset(eloc);
		}
		const slotsOf = own.wins.map((w, k) => ({ w, k, at: slots![k]! }));
		for (const { w, k, at } of slotsOf)
			as('access', () => openWindow(w, { w: local(`bw${k}`, 'i32'), va: local(`bva${k}`, 'i64'), x: local(`bx${k}`, 'i32'), bd: local(`bbd${k}`, 'i64') }, at));

		const fault = (why?: { sig: number; msg: string }) => {
			void why;
			cpuStore64(L.cpuIpc, () => i64c(ipc));
			exitTo(b.pc);
		};
		// a fault leaves with the callee's fault set: if (cpu->fault) leave
		const ifFault = (then: () => void) => {
			cpuLoad32(L.cpuFault);
			open('if', '#if');
			then();
			close('end_if');
		};
		// a direct call into another region: its registers go in as parameters and the ones it writes come back, with the flags and the
		// pc it stopped at; a pc that is a return address this block pushed continues there, any other pc leaves through this region
		const callTo = (to: bigint) => {
			if (cur) throw new Error(`block ${b.pc.toString(16)}: a call inside a recipe`);
			const C = infos[calls.get(to)!]!;
			const pushed = pushedOf(b);
			lget(CPU);
			i64c(to);
			for (const r of C.params) lget(g(r));
			for (const f of [fl.n, fl.z, fl.c, fl.v, fl.p, dfl, gen]) lget(f);
			o(`call\t${C.name}_go`);
			for (const f of [gen, dfl, fl.p, fl.v, fl.c, fl.z, fl.n]) lset(f);
			for (const r of [...C.results].reverse()) {
				if (mutate === 'noreturn') o('drop');
				else {
					lset(g(r));
					rep.set(r, { ty: 'i64', fits: false });
				}
			}
			lset(PC);
			for (const v of pushed) {
				lget(PC);
				i64c(v);
				o('i64.eq');
				open('if', '#if');
				leave(v);
				close('end_if');
			}
			br('OUT');
		};
		// the fall-through or branch edge to `to`: R_ok and the signal flag, then the edge, else leave to the interpreter
		const leave = (to: bigint) =>
			as('dispatch', () => {
				const k = index.get(to);
				if (k === undefined) return calls.has(to) ? callTo(to) : exitTo(to);
				const back = to <= b.pc;
				if (back) {
					pending();
					o('i32.eqz');
				} else i32c(1);
				lget(okb);
				o(`i32.load8_u\t${k}:p2align=0`);
				o('i32.and');
				open('if', '#if');
				if (edgeOn) as('flags', () => carryOver(k));
				edge(j, k);
				close('end_if');
				exitTo(to);
			});
		// edge mode, at an edge into block k: the recipe this block holds goes in if k takes that kind and width in, else the five locals get
		// the flags k reads (and `warm` says which, for a block that takes a recipe in)
		const carryOver = (k: number) => {
			if (!flagsIn[k]) return;
			const want = entryRec[k];
			const spill = () => {
				if (cur && mutate !== 'edgeskip') {
					rmaterialize(cur);
					edgeStats.materialized++;
					edgeStats.materializedW += b.runs;
				}
			};
			if (want && cur && cur.kind === want.kind && cur.w === want.w) {
				if (!cur.dual) {
					i32c(1);
					lset(warm());
				}
				edgeStats.passed++;
				edgeStats.passedW += b.runs;
				return;
			}
			spill();
			if (want) {
				i32c(0);
				lset(warm());
			}
		};
		const cond = (c: number) => as('flags', () => {
			if (cur) return rcond(cur, c);
			const r = c >> 1;
			const f = (x: number) => lget(x);
			switch (r) {
				case 0: f(fl.v); break;
				case 1: f(fl.c); break;
				case 2: f(fl.z); break;
				case 3: f(fl.c); f(fl.z); o('i32.or'); break;
				case 4: f(fl.n); break;
				case 5: f(fl.p); break;
				case 6: f(fl.n); f(fl.v); o('i32.xor'); break;
				default: f(fl.z); f(fl.n); f(fl.v); o('i32.xor'); o('i32.or'); break;
			}
			if (c & 1) o('i32.eqz');
		});
		const setFlag = (x: number) => lset(x);
		// a FLAGS op kept as its operands: the carry in first (from the recipe it replaces), then the operands the kind reads
		const saveRecipe = (kind: string, x: Ins) => {
			const { qa, qb, qr, qc } = slot();
			const w = x.w;
			if (kind === 'ADC' || kind === 'SBB') {
				if (cur) rflag(cur, 'c');
				else lget(fl.c);
				o('i64.extend_i32_u');
				if (mutate === 'adc') {
					o('drop');
					i64c(0n);
				}
				lset(qc);
			} else if ((kind === 'INC' || kind === 'DEC') && cur) {
				rflag(cur, 'c');
				lset(fl.c);
			}
			if (['ADD', 'ADC', 'SUB', 'SBB'].includes(kind)) {
				getMasked(x.b, w);
				lset(qa);
			}
			if (['ADD', 'ADC', 'SUB', 'SBB', 'NEG'].includes(kind)) {
				getMasked(x.c, w);
				lset(qb);
			}
			getMasked(x.a, w);
			lset(qr);
			cur = { kind, w };
		};
		// #region flags
		const flags = (kind: string, w: number, x: Ins) => {
			const mk = MASK(w);
			const sg = SIGN(w);
			const rawB = () => get64(x.c);
			const maskedA = () => getMasked(x.b, w);
			const maskedB = () => getMasked(x.c, w);
			const maskedR = () => getMasked(x.a, w);
			const shiftKind = ['SHL', 'SHR', 'SAR', 'ROL', 'ROR'].includes(kind);
			const body = () => {
				switch (kind) {
					case 'MULOV':
						rawB(); i64c(0n); o('i64.ne'); lset(fl.c); lget(fl.c); lset(fl.v);
						return;
					case 'SETC':
						rawB(); i64c(1n); o('i64.and'); o('i32.wrap_i64'); setFlag(fl.c);
						return;
					case 'ZERO':
						maskedB(); o('i64.eqz'); setFlag(fl.z);
						return;
					case 'CNT':
						maskedB(); o('i64.eqz'); setFlag(fl.c);
						maskedR(); o('i64.eqz'); setFlag(fl.z);
						return;
					case 'ROL':
						get64(x.a); i64c(1n); o('i64.and'); o('i32.wrap_i64'); setFlag(fl.c);
						get64(x.a); i64c(sg); o('i64.and'); o('i64.eqz'); o('i32.eqz'); lget(fl.c); o('i32.xor'); setFlag(fl.v);
						return;
					case 'ROR':
						get64(x.a); i64c(sg); o('i64.and'); o('i64.eqz'); o('i32.eqz'); setFlag(fl.c);
						get64(x.a); i64c(sg); o('i64.and'); o('i64.eqz'); o('i32.eqz');
						get64(x.a); i64c(sg >> 1n); o('i64.and'); o('i64.eqz'); o('i32.eqz'); o('i32.xor'); setFlag(fl.v);
						return;
				}
				// a, b, r masked to the width
				maskedA(); lset(sa);
				maskedB(); lset(sb);
				maskedR(); lset(sr);
				lget(sr); o('i64.eqz'); setFlag(fl.z);
				lget(sr); i64c(sg); o('i64.and'); o('i64.eqz'); o('i32.eqz'); setFlag(fl.n);
				// parity of the low byte: even number of set bits
				lget(sr); i64c(0xffn); o('i64.and'); o('i64.popcnt', 'i32.wrap_i64'); i32c(1); o('i32.and'); o('i32.eqz'); setFlag(fl.p);
				const signOf = (e: () => void) => {
					e(); i64c(sg); o('i64.and'); o('i64.eqz'); o('i32.eqz');
				};
				const ovAdd = () => signOf(() => {
					lget(sa); lget(sb); o('i64.xor'); i64c(-1n); o('i64.xor'); lget(sa); lget(sr); o('i64.xor'); o('i64.and');
				});
				const ovSub = () => signOf(() => {
					lget(sa); lget(sb); o('i64.xor'); lget(sa); lget(sr); o('i64.xor'); o('i64.and');
				});
				switch (kind) {
					case 'ADD':
						lget(sr); lget(sa); o('i64.lt_u'); setFlag(fl.c);
						ovAdd(); setFlag(fl.v);
						break;
					case 'ADC': {
						lget(fl.c); o('i64.extend_i32_u'); lset(sv);
						if (w < 8) {
							lget(sa); lget(sb); o('i64.add'); lget(sv); o('i64.add'); i64c(mk); o('i64.gt_u');
						} else {
							lget(sv); o('i64.eqz');
							o('if\ti32');
							lget(sr); lget(sa); o('i64.lt_u');
							o('else');
							lget(sr); lget(sa); o('i64.le_u');
							o('end_if');
						}
						setFlag(fl.c);
						ovAdd(); setFlag(fl.v);
						break;
					}
					case 'SUB':
						lget(sa); lget(sb); o('i64.lt_u'); setFlag(fl.c);
						ovSub(); setFlag(fl.v);
						break;
					case 'SBB': {
						lget(fl.c); o('i64.extend_i32_u'); lset(sv);
						if (w < 8) {
							lget(sa); lget(sb); lget(sv); o('i64.add'); o('i64.lt_u');
						} else {
							lget(sa); lget(sb); o('i64.lt_u');
							lget(sv); o('i64.eqz'); o('i32.eqz'); lget(sa); lget(sb); o('i64.eq'); o('i32.and'); o('i32.or');
						}
						setFlag(fl.c);
						ovSub(); setFlag(fl.v);
						break;
					}
					case 'LOGIC':
						i32c(0); setFlag(fl.c); i32c(0); setFlag(fl.v);
						break;
					case 'INC':
						lget(sr); i64c(sg); o('i64.eq'); setFlag(fl.v);
						break;
					case 'DEC':
						lget(sr); i64c(sg - 1n); o('i64.eq'); setFlag(fl.v);
						break;
					case 'NEG':
						lget(sb); i64c(0n); o('i64.ne'); setFlag(fl.c);
						lget(sb); i64c(sg); o('i64.eq'); setFlag(fl.v);
						break;
					case 'SHL':
						lget(sb); i64c(BigInt(8 * w)); o('i64.le_u');
						o('if\ti32');
						lget(sa); lget(sb); i64c(1n); o('i64.sub'); o('i64.shl'); i64c(sg); o('i64.and'); o('i64.eqz'); o('i32.eqz');
						o('else');
						i32c(0);
						o('end_if');
						setFlag(fl.c);
						lget(fl.n); lget(fl.c); o('i32.xor'); setFlag(fl.v);
						break;
					case 'SHR':
						lget(sa); lget(sb); i64c(1n); o('i64.sub'); o('i64.shr_u'); i64c(1n); o('i64.and'); o('i32.wrap_i64'); setFlag(fl.c);
						lget(sa); i64c(sg); o('i64.and'); o('i64.eqz'); o('i32.eqz'); setFlag(fl.v);
						break;
					case 'SAR':
						// the sign-extended a, shifted right logically (aot_flags does the same)
						lget(sa);
						if (w < 8) {
							i64c(BigInt(64 - 8 * w));
							o('i64.shl');
							i64c(BigInt(64 - 8 * w));
							o('i64.shr_s');
						}
						lget(sb); i64c(1n); o('i64.sub'); o('i64.shr_u'); i64c(1n); o('i64.and'); o('i32.wrap_i64'); setFlag(fl.c);
						i32c(0); setFlag(fl.v);
						break;
				}
			};
			if (shiftKind) {
				// a shift or rotate by 0 changes no flag
				rawB(); i64c(0n); o('i64.ne');
				open('if', '#if');
				body();
				close('end_if');
			} else body();
		};
		// #endregion

		// #region the ops
		const ext = (r: number, e: () => void) => {
			void r;
			e();
		};
		void ext;
		const spillRegs = (list: number[]) => {
			for (const r of list) {
				if (r === KB_ZERO) continue;
				cpuStore64(L.cpuR + 8 * r, () => get64(r));
			}
		};
		const spillFlags = (t: { flags: boolean; df: boolean } | 'all') => {
			if (t === 'all' || t.flags) {
				cpuStore32(L.cpuN, () => lget(fl.n));
				cpuStore32(L.cpuZ, () => lget(fl.z));
				cpuStore32(L.cpuC, () => lget(fl.c));
				cpuStore32(L.cpuV, () => lget(fl.v));
				cpuStore32(L.cpuP, () => lget(fl.p));
			}
			if (t === 'all' || t.df) cpuStore32(L.cpuDf, () => lget(dfl));
		};
		// a helper's spill and reload: its registers and flags only (the precise form), and the mapping generation after
		const held = (r: number) => r !== KB_ZERO && (regList.includes(r) || (isTemp(r) && !isCross(r)));
		const aroundHelper = (t: ReturnType<typeof touches>, call: () => void) => {
			cpuStore64(L.cpuIpc, () => i64c(ipc));
			spillRegs([...new Set([...t.r, ...t.w])].filter(held));
			spillFlags(t);
			as('helpers', call);
			for (const r of new Set(t.w)) {
				if (!regList.includes(r)) continue;
				lget(CPU);
				as('state', () => o(`i64.load\t${L.cpuR + 8 * r}:p2align=0`));
				lset(g(r));
				rep.set(r, { ty: 'i64', fits: false });
			}
			if (t.flags) {
				for (const [f, off] of [[fl.n, L.cpuN], [fl.z, L.cpuZ], [fl.c, L.cpuC], [fl.v, L.cpuV], [fl.p, L.cpuP]] as const) {
					cpuLoad32(off);
					lset(f);
				}
			}
			cpuLoad32(L.cpuMapgen);
			lset(gen);
			ifFault(() => {
				cpuStore64(L.cpuIpc, () => i64c(ipc));
				exitTo(b.pc);
			});
		};
		// a load or store through the inline cache (the checked path), then through a window when there is one
		const accessVa = (x: Ins) => {
			get64(x.b);
			if (x.imm !== 0n) {
				i64c(x.imm);
				o('i64.add');
			}
			lset(sva);
		};
		// the fast path's host pointer in swp, or 0: the window plus the access's own distance from the window's start
		const fastPtr = (hit: Hit, w: number) => {
			const win = hit.loop ? loopWins[hit.win]! : own.wins[hit.win]!;
			const ids = hit.loop
				? { w: lw(hit.win), va: lva(hit.win), x: lx(hit.win), bd: lbd(hit.win) }
				: { w: local(`bw${hit.win}`, 'i32'), va: local(`bva${hit.win}`, 'i64'), x: local(`bx${hit.win}`, 'i32'), bd: local(`bbd${hit.win}`, 'i64') };
			if (!win.two) {
				// w ? w + off : 0
				lget(ids.w);
				o('if\ti32');
				lget(ids.w);
				if (hit.dyn) {
					lget(sva);
					lget(ids.va);
					o('i64.sub', 'i32.wrap_i64');
				} else i32c(Number(hit.off));
				o('i32.add', 'else');
				i32c(0);
				o('end_if');
				lset(swp);
				return;
			}
			// AOT_PICK2: h0 ? (a >= bd ? h1 + (a - bd) : a + w <= bd ? h0 + (a - va) : 0) : 0
			lget(ids.w);
			o('if\ti32');
			lget(sva);
			lget(ids.bd);
			o('i64.ge_u');
			o('if\ti32');
			lget(ids.x);
			lget(sva);
			lget(ids.bd);
			o('i64.sub', 'i32.wrap_i64', 'i32.add');
			o('else');
			lget(sva);
			i64c(BigInt(w));
			o('i64.add');
			lget(ids.bd);
			o('i64.le_u');
			o('if\ti32');
			lget(ids.w);
			lget(sva);
			lget(ids.va);
			o('i64.sub', 'i32.wrap_i64', 'i32.add');
			o('else');
			i32c(0);
			o('end_if');
			o('end_if');
			o('else');
			i32c(0);
			o('end_if');
			lset(swp);
		};
		const loadOp = (w: number, signed: boolean) =>
			w === 8 ? 'i64.load' : signed ? `i64.load${8 * w}_s` : all64 ? `i64.load${8 * w}_u` : `i32.load${w === 4 ? '' : `${8 * w}_u`}`;
		const memOp = (x: Ins, i: number, name: string) => {
			const hit = lhits?.get(i) ?? own.hits.get(i);
			blockReports.accesses++;
			if (hit) blockReports.windowed++;
			const W = x.w;
			const isLoad = name !== 'ST';
			const signed = name === 'LDS' && W < 8;
			// the destination: a width-4-or-less zero-extended load is a true 32-bit value
			const narrowDest = isLoad && !signed && W < 8 && !all64;
			const store = () => {
				if (narrowDest) put32(x.a, true);
				else put64(x.a, !signed && W < 8);
			};
			accessVa(x);
			if (hit) {
				fastPtr(hit, W);
				lget(swp);
				open('if', '#if');
			}
			if (hit) {
				// the fast path
				lget(swp);
				if (isLoad) {
					o(`${loadOp(W, signed)}\t0:p2align=0`);
					store();
				} else {
					if (W === 8) get64(x.a);
					else get32(x.a);
					o(W === 8 ? 'i64.store\t0:p2align=0' : `i32.store${W === 4 ? '' : 8 * W}\t0:p2align=0`);
				}
				o('else');
			}
			// the checked path: slow when the cache's generation or range does not hold
			q(ic, m);
			lset(sq);
			lget(sq);
			o(`i32.load\t${L.icGen}:p2align=0`);
			lget(gen);
			o('i32.ne');
			lget(sva);
			lget(sq);
			o(`i64.load\t${L.icLo}:p2align=0`);
			o('i64.sub');
			lget(sq);
			o(`i64.load\t${L.icSpan}:p2align=0`);
			i64c(BigInt(W));
			o('i64.sub');
			o('i64.gt_u');
			o('i32.or');
			open('if', '#if');
			if (isLoad) {
				lget(CPU);
				lget(sq);
				lget(sva);
				i32c(W);
				o('call\tkb_load_ic');
				if (signed) {
					// sign extension by shifts: the module is built without the sign-ext feature
					i64c(BigInt(64 - 8 * W));
					o('i64.shl');
					i64c(BigInt(64 - 8 * W));
					o('i64.shr_s');
				} else if (narrowDest) o('i32.wrap_i64');
				store();
				ifFault(() => fault());
			} else {
				lget(CPU);
				lget(sq);
				lget(sva);
				if (W === 8) get64(x.a);
				else {
					get32(x.a);
					o('i64.extend_i32_u');
				}
				i32c(W);
				o('call\tkb_store_ic');
				ifFault(() => fault());
			}
			o('else');
			lget(sq);
			o(`i32.load\t${L.icHost}:p2align=0`);
			lget(sva);
			lget(sq);
			o(`i64.load\t${L.icLo}:p2align=0`);
			o('i64.sub', 'i32.wrap_i64', 'i32.add');
			if (isLoad) {
				o(`${loadOp(W, signed)}\t0:p2align=0`);
				store();
			} else {
				if (W === 8) get64(x.a);
				else get32(x.a);
				o(W === 8 ? 'i64.store\t0:p2align=0' : `i32.store${W === 4 ? '' : 8 * W}\t0:p2align=0`);
			}
			close('end_if');
			if (hit) close('end_if');
			void narrowDest;
			m++;
		};
		// #endregion

		b.ins.forEach((x, i) => {
			if (b.pcs) ipc = BigInt.asUintN(64, b.pc + BigInt(b.pcs[i]!));
			locPc = Number(ipc & 0x7fffffffn);
			const name = opName(x.op);
			cat = ['JMP', 'BR', 'BRZ', 'EXIT'].includes(name) ? 'dispatch' : 'arith';
			// these read or keep the five flags as they are: the recipe was not asked for across them
			if (cur && (['X86MD', 'X86SHD', 'SSE', 'X87', 'X86STR', 'SYSCALL'].includes(name) || (name === 'X86FLAGS' && x.imm !== 1n && x.imm <= 4n) || (name === 'JMP' && constJump(b) === undefined)))
				throw new Error(`block ${b.pc.toString(16)}: ${name} inside a recipe`);
			if (name === 'X86FLAGS' && x.imm === 1n) cur = null;
			const A = x.a;
			const wide = aluOps.has(name);
			if (wide) {
				blockReports.aluStatic++;
				blockReports.aluWeighted += b.runs;
			}
			const noteNarrow = () => {
				if (wide) {
					blockReports.narrowStatic++;
					blockReports.narrowWeighted += b.runs;
				}
			};
			switch (name) {
				case 'MOVI': {
					const v = BigInt.asUintN(64, x.imm);
					if (v < 1n << 32n && !isCross(A) && !all64) {
						i32c(Number(v));
						put32(A, true);
						noteNarrow();
					} else {
						i64c(v);
						put64(A, v < 1n << 32n);
					}
					break;
				}
				case 'MOV':
					if (narrowDef[i]) {
						get32(x.b);
						put32(A, false);
						noteNarrow();
					} else if (getRep(x.b).ty === 'i32' && !isCross(A)) {
						get32(x.b);
						put32(A, fitsOf(x.b));
						noteNarrow();
					} else {
						get64(x.b);
						put64(A, fitsOf(x.b));
					}
					break;
				case 'ADD':
				case 'SUB':
				case 'MUL':
				case 'AND':
				case 'OR':
				case 'XOR': {
					const op32 = { ADD: 'i32.add', SUB: 'i32.sub', MUL: 'i32.mul', AND: 'i32.and', OR: 'i32.or', XOR: 'i32.xor' }[name]!;
					const op64 = op32.replace('i32', 'i64');
					const bothFit = fitsOf(x.b) && fitsOf(x.c);
					const andFit = !all64 && name === 'AND' && (fitsOf(x.b) || fitsOf(x.c));
					const logicFit = !all64 && (name === 'OR' || name === 'XOR') && bothFit;
					if (narrowDef[i]) {
						get32(x.b);
						get32(x.c);
						o(op32);
						put32(A, andFit || logicFit);
						noteNarrow();
					} else if (andFit || logicFit) {
						get32(x.b);
						get32(x.c);
						o(op32);
						put32(A, true);
						noteNarrow();
					} else {
						get64(x.b);
						get64(x.c);
						o(op64);
						put64(A);
					}
					break;
				}
				case 'SHL':
				case 'SHR':
				case 'SAR': {
					const k = kc[i];
					const i64s = name === 'SHL' ? 'i64.shl' : name === 'SHR' ? 'i64.shr_u' : 'i64.shr_s';
					if (!all64 && name === 'SHR' && k !== undefined && fitsOf(x.b)) {
						// a 32-bit value shifted right stays 32 bits
						if (k >= 32n) i32c(0);
						else {
							get32(x.b);
							i32c(Number(k));
							o('i32.shr_u');
						}
						put32(A, true);
						noteNarrow();
					} else if (name === 'SHL' && k !== undefined && k < 32n && !isCross(A) && narrowDef[i]) {
						get32(x.b);
						i32c(Number(k));
						o('i32.shl');
						put32(A, false);
						noteNarrow();
					} else if (k !== undefined) {
						if (name === 'SAR') {
							get64(x.b);
							i64c(k >= 64n ? 63n : k);
							o(i64s);
						} else if (k >= 64n) i64c(0n);
						else {
							get64(x.b);
							i64c(k);
							o(i64s);
						}
						put64(A, name === 'SHR' && fitsOf(x.b));
					} else {
						if (name === 'SAR') {
							// a count of 64 or more shifts by 63
							get64(x.b);
							get64(x.c);
							i64c(64n);
							o('i64.ge_u', 'if\ti64');
							i64c(63n);
							o('else');
							get64(x.c);
							o('end_if');
							o(i64s);
						} else {
							// a count of 64 or more leaves 0
							get64(x.c);
							i64c(64n);
							o('i64.ge_u', 'if\ti64');
							i64c(0n);
							o('else');
							get64(x.b);
							get64(x.c);
							o(i64s, 'end_if');
						}
						put64(A);
					}
					break;
				}
				case 'ROR': {
					// v = b & mask; n = c % bits; n ? ((v >> n) | (v << (bits - n))) & mask : v
					const bits = BigInt(8 * x.w);
					getMasked(x.b, x.w);
					lset(sv);
					get64(x.c);
					i64c(bits);
					o('i64.rem_u');
					lset(sa);
					lget(sa);
					o('i64.eqz', 'if\ti64');
					lget(sv);
					o('else');
					lget(sv);
					lget(sa);
					o('i64.shr_u');
					lget(sv);
					i64c(bits);
					lget(sa);
					o('i64.sub', 'i64.shl', 'i64.or');
					i64c(MASK(x.w));
					o('i64.and', 'end_if');
					put64(A, x.w <= 4);
					break;
				}
				case 'UMULH':
				case 'SMULH':
					get64(x.b);
					get64(x.c);
					as('helpers', () => o(`call\tkb_aot_${name === 'UMULH' ? 'umulh' : 'smulh'}`));
					put64(A);
					break;
				case 'ZEXT':
					if (x.w >= 8) {
						get64(x.b);
						put64(A, fitsOf(x.b));
					} else if (all64) {
						get64(x.b);
						i64c(MASK(x.w));
						o('i64.and');
						put64(A, true);
					} else {
						get32(x.b);
						if (x.w < 4) {
							i32c(Number(MASK(x.w)));
							o('i32.and');
						}
						put32(A, true);
						noteNarrow();
					}
					break;
				case 'SEXT':
					if (x.w >= 8) {
						get64(x.b);
						put64(A);
					} else if (all64) {
						get64(x.b);
						i64c(BigInt(64 - 8 * x.w));
						o('i64.shl');
						i64c(BigInt(64 - 8 * x.w));
						o('i64.shr_s');
						put64(A);
					} else {
						get32(x.b);
						if (x.w === 4) o('i64.extend_i32_s');
						else {
							i32c(32 - 8 * x.w);
							o('i32.shl');
							i32c(32 - 8 * x.w);
							o('i32.shr_s', 'i64.extend_i32_s');
						}
						put64(A);
						noteNarrow();
					}
					break;
				case 'BSWAP':
					if (x.w === 4 && !all64) {
						// rotl 16, then swap the bytes inside each half
						get32(x.b);
						i32c(16);
						o('i32.rotl');
						lset(sq);
						lget(sq);
						i32c(0x00ff00ff);
						o('i32.and');
						i32c(8);
						o('i32.shl');
						lget(sq);
						i32c(8);
						o('i32.shr_u');
						i32c(0x00ff00ff);
						o('i32.and', 'i32.or');
						put32(A, true);
						noteNarrow();
					} else {
						// the 64-bit swap by three rounds, then down to the width
						get64(x.b);
						i64c(32n);
						o('i64.rotl');
						lset(sv);
						for (const [m16, s] of [[0x0000ffff0000ffffn, 16n], [0x00ff00ff00ff00ffn, 8n]] as const) {
							lget(sv);
							i64c(m16);
							o('i64.and');
							i64c(s);
							o('i64.shl');
							lget(sv);
							i64c(s);
							o('i64.shr_u');
							i64c(m16);
							o('i64.and', 'i64.or');
							lset(sv);
						}
						lget(sv);
						if (x.w < 8) {
							i64c(BigInt(64 - 8 * x.w));
							o('i64.shr_u');
						}
						put64(A, x.w < 8);
					}
					break;
				case 'INS': {
					const sh = BigInt(x.imm);
					const mk = MASK(x.w) << sh;
					get64(A);
					i64c(~mk);
					o('i64.and');
					get64(x.b);
					i64c(sh);
					o('i64.shl');
					i64c(mk);
					o('i64.and', 'i64.or');
					put64(A);
					break;
				}
				case 'LD':
				case 'LDS':
				case 'ST':
					as('access', () => memOp(x, i, name));
					break;
				case 'RESOLVE':
					m++;
					break;
				case 'FLAGS': {
					const key = `${j}:${i}`;
					fstat.total++;
					if (dead.has(key)) {
						fstat.dead++;
						fstat.deadW += b.runs;
						break;
					}
					const kind = FK[Number(x.imm)]!;
					if (recipes.has(key)) {
						fstat.recipe++;
						fstat.recipeW += b.runs;
						as('flags', () => saveRecipe(kind, x));
						break;
					}
					fstat.eager++;
					fstat.eagerW += b.runs;
					const why = eagerWhy.get(key) ?? (recipeMode ? 'kind' : 'mode');
					fstat.why[why] = (fstat.why[why] ?? 0) + 1;
					fstat.whyW[why] = (fstat.whyW[why] ?? 0n) + b.runs;
					// an eager op after a recipe: the carry it reads (or keeps) is made first, and the recipe is spent
					if (cur) {
						const rc = cur;
						if (!RECIPE_KINDS.has(kind)) throw new Error(`block ${b.pc.toString(16)}: flags op ${kind} after a recipe`);
						if (kind === 'ADC' || kind === 'SBB' || kind === 'INC' || kind === 'DEC') as('flags', () => { rflag(rc, 'c'); lset(fl.c); });
					}
					cur = null;
					as('flags', () => flags(kind, x.w, x));
					break;
				}
				case 'SETCC':
					cond(Number(x.imm));
					o('i64.extend_i32_u');
					put64(A, true);
					break;
				case 'SEL':
					cond(Number(x.imm));
					o('if\ti64');
					get64(x.b);
					o('else');
					get64(x.c);
					o('end_if');
					put64(A, fitsOf(x.b) && fitsOf(x.c));
					break;
				case 'BR':
					cond(Number(x.imm));
					open('if', '#if');
					leave(b.target);
					close('end_if');
					break;
				case 'BRZ':
					get64(A);
					o('i64.eqz');
					if (x.imm !== 0n) o('i32.eqz');
					// leave when (A != 0) == (imm != 0): imm 0 leaves on A == 0 (eqz), nonzero imm on A != 0
					open('if', '#if');
					leave(b.target);
					close('end_if');
					break;
				case 'EXIT': {
					const to = BigInt.asUintN(64, b.pc + BigInt.asIntN(32, x.imm >> 16n));
					if (x.imm & 0x100n) {
						get64(A);
						o('i64.eqz');
						if (x.imm & 1n) o('i32.eqz');
					} else cond(Number(x.imm & 0xffn));
					open('if', '#if');
					leave(to);
					close('end_if');
					break;
				}
				case 'JMP': {
					const k = constJump(b);
					if (k !== undefined && (index.has(k) || calls.has(k))) {
						leave(k);
					} else {
						get64(x.b);
						lset(PC);
						// an indirect jump goes through the region's dispatch
						lget(PC);
						i64c(b.pc);
						o('i64.le_u');
						open('if', '#if');
						pending();
						open('if', '#if');
						br('OUT');
						close('end_if');
						close('end_if');
						i32c(-1);
						lset(eloc);
						br('D');
					}
					break;
				}
				case 'PC':
					ipc = x.imm;
					break;
				case 'CARRY':
					if (cur) as('flags', () => rflag(cur!, 'c'));
					else lget(fl.c);
					o('i64.extend_i32_u');
					put64(A, true);
					break;
				case 'CLZ':
					getMasked(x.b, x.w);
					o('i64.clz');
					if (x.w < 8) {
						i64c(BigInt(64 - 8 * x.w));
						o('i64.sub');
					}
					put64(A, true);
					break;
				case 'CTZ':
					getMasked(x.b, x.w);
					if (x.w < 8) {
						i64c(1n << BigInt(8 * x.w));
						o('i64.or');
					}
					o('i64.ctz');
					put64(A, true);
					break;
				case 'POPCNT':
					getMasked(x.b, x.w);
					o('i64.popcnt');
					put64(A, true);
					break;
				case 'FSBASE':
					lget(gfs);
					put64(A);
					break;
				case 'X86MD': {
					// rax and rdx go through the cpu for the helper, and come back
					const kind = Number(x.imm);
					cpuStore64(L.cpuIpc, () => i64c(ipc));
					cpuStore64(L.cpuR, () => get64(0));
					cpuStore64(L.cpuR + 16, () => get64(2));
					lget(CPU);
					i32c(kind);
					i32c(x.w);
					get64(x.b);
					as('helpers', () => o('call\tkb_aot_md'));
					lset(smd);
					for (const r of [0, 2]) {
						lget(CPU);
						o(`i64.load\t${L.cpuR + 8 * r}:p2align=0`);
						put64(r);
					}
					if (kind === 4 || kind === 5) {
						lget(smd);
						i32c(1);
						o('i32.shr_u');
						i32c(1);
						o('i32.and');
						lset(fl.c);
						lget(fl.c);
						lset(fl.v);
					} else {
						lget(smd);
						open('if', '#if');
						cpuStore64(L.cpuIpc, () => i64c(ipc));
						exitTo(b.pc);
						close('end_if');
					}
					break;
				}
				case 'X86SHD': {
					const w = x.w;
					const mk = MASK(w);
					const bits = BigInt(8 * w);
					// v = a & m, in = b & m, n = c (the count)
					getMasked(A, w);
					lset(sa);
					getMasked(x.b, w);
					lset(sb);
					get64(x.c);
					lset(sv);
					lget(sv);
					o('i64.eqz', 'i32.eqz');
					open('if', '#if');
					if (x.imm === 0n) {
						// shld: n == bits ? in : ((v << n) | (in >> (bits - n))) & m; cf = (v >> (bits - n)) & 1
						lget(sv);
						i64c(bits);
						o('i64.eq');
						o('if\ti64');
						lget(sb);
						o('else');
						lget(sa);
						lget(sv);
						o('i64.shl');
						lget(sb);
						i64c(bits);
						lget(sv);
						o('i64.sub', 'i64.shr_u', 'i64.or');
						i64c(mk);
						o('i64.and');
						o('end_if');
						lset(sr);
						lget(sa);
						i64c(bits);
						lget(sv);
						o('i64.sub', 'i64.shr_u');
					} else {
						// shrd: ((v >> n) | (in << (bits - n))) & m; cf = (v >> (n - 1)) & 1
						lget(sa);
						lget(sv);
						o('i64.shr_u');
						lget(sb);
						i64c(bits);
						lget(sv);
						o('i64.sub', 'i64.shl', 'i64.or');
						i64c(mk);
						o('i64.and');
						lset(sr);
						lget(sa);
						lget(sv);
						i64c(1n);
						o('i64.sub', 'i64.shr_u');
					}
					i64c(1n);
					o('i64.and', 'i32.wrap_i64');
					lset(sq);
					// flags as KB_F_LOGIC of the result, with the carry
					lget(sr);
					o('i64.eqz');
					setFlag(fl.z);
					lget(sr);
					i64c(SIGN(w));
					o('i64.and', 'i64.eqz', 'i32.eqz');
					setFlag(fl.n);
					lget(sr);
					i64c(0xffn);
					o('i64.and', 'i64.popcnt', 'i32.wrap_i64');
					i32c(1);
					o('i32.and', 'i32.eqz');
					setFlag(fl.p);
					i32c(0);
					setFlag(fl.v);
					lget(sq);
					setFlag(fl.c);
					lget(sr);
					lset(g(A));
					close('end_if');
					rep.set(A, { ty: 'i64', fits: false });
					break;
				}
				case 'X86FLAGS':
					if (x.imm === 0n) {
						// rflags: 0x202 | c | p << 2 | z << 6 | n << 7 | df << 10 | v << 11
						i64c(0x202n);
						for (const [f, sh] of [[fl.c, 0n], [fl.p, 2n], [fl.z, 6n], [fl.n, 7n], [dfl, 10n], [fl.v, 11n]] as const) {
							lget(f);
							o('i64.extend_i32_u');
							if (sh) {
								i64c(sh);
								o('i64.shl');
							}
							o('i64.or');
						}
						put64(A, true);
					} else if (x.imm === 1n) {
						get64(A);
						lset(sv);
						for (const [f, sh] of [[fl.c, 0n], [fl.p, 2n], [fl.z, 6n], [fl.n, 7n], [dfl, 10n], [fl.v, 11n]] as const) {
							lget(sv);
							i64c(sh);
							o('i64.shr_u');
							i64c(1n);
							o('i64.and', 'i32.wrap_i64');
							lset(f);
						}
					} else if (x.imm === 2n) {
						lget(fl.c);
						o('i32.eqz');
						lset(fl.c);
					} else if (x.imm === 3n) {
						i32c(0);
						lset(fl.c);
					} else if (x.imm === 4n) {
						i32c(1);
						lset(fl.c);
					} else if (x.imm === 5n) {
						i32c(0);
						lset(dfl);
					} else {
						i32c(1);
						lset(dfl);
					}
					break;
				case 'SSE':
				case 'X87': {
					const t = touches(x);
					aroundHelper(t, () => {
						lget(CPU);
						lget(bp);
						o(`i32.load\t${L.blkIns}:p2align=0`);
						i32c(L.insSize * i);
						o('i32.add');
						o(`call\t${name === 'SSE' ? 'kb_sse' : 'kb_x87'}`);
						// a helper that refuses its instruction and set no fault raises one
						open('if', '#if');
						cpuLoad32(L.cpuFault);
						o('i32.eqz');
						open('if', '#if');
						lget(CPU);
						i32c(name === 'X87' ? 1 : 0);
						o('call\tkb_aot_unknown');
						close('end_if');
						close('end_if');
					});
					break;
				}
				case 'X86STR': {
					const t = touches(x);
					aroundHelper(t, () => {
						lget(CPU);
						i32c(Number(x.imm));
						i32c(x.w);
						i32c(x.c);
						o('call\tkb_aot_string');
					});
					break;
				}
				case 'SYSCALL':
					cpuStore64(L.cpuIpc, () => i64c(ipc));
					spillRegs(regList);
					spillFlags('all');
					cpuStore64(CPU_PC, () => i64c(b.next));
					lget(CPU);
					as('helpers', () => o('call\tkb_syscall'));
					cpuLoad32(L.cpuExited);
					o('if');
					i64c(0n);
					o('return');
					o('end_if');
					cpuLoad32(L.cpuSigreturned);
					o('if');
					cpuStore32(L.cpuSigreturned, () => i32c(0));
					lget(CPU);
					o(`i64.load\t${CPU_PC}:p2align=0`);
					o('return');
					o('end_if');
					cpuLoad32(L.cpuFault);
					o('if');
					cpuStore64(L.cpuIpc, () => i64c(ipc));
					i64c(b.pc);
					o('return');
					o('end_if');
					i64c(b.next);
					o('return');
					break;
				default:
					throw new Error(`no emission for ${name}`);
			}
		});
		const last = opName(b.ins.at(-1)!.op);
		if (last !== 'JMP' && last !== 'SYSCALL') leave(b.next);
	};
	// #endregion

	// #region the function
	// a loop's entry switch: a block of the loop entered from outside its header comes in with its position in $e
	const entryCheck = (loop: Loop, items: Item[]) => {
		const [lo, hi] = posRange.get(loop.id)!;
		const hdrPos = pos[loop.header]!;
		if (hi === lo) {
			i32c(-1);
			lset(eloc);
			return;
		}
		lget(eloc);
		i32c(0);
		o('i32.ge_s');
		open('if', '#if');
		lget(eloc);
		i32c(hdrPos);
		o('i32.eq');
		open('if', '#if');
		i32c(-1);
		lset(eloc);
		o('else');
		lget(eloc);
		i32c(lo);
		o('i32.sub');
		const target = (p: number) => {
			for (let k = 1; k < items.length; k++) {
				const it = items[k]!;
				const range = it.kind === 'block' ? [pos[it.j]!, pos[it.j]!] : posRange.get(it.loop.id)!;
				if (p >= range[0]! && p <= range[1]!) return `F${loop.id}_${k}`;
			}
			return `F${loop.id}_1`;
		};
		const labels: number[] = [];
		for (let p = lo; p <= hi; p++) labels.push(depth(target(p)));
		o(`br_table\t{${labels.join(', ')}, ${labels.at(-1)}}`);
		close('end_if');
		close('end_if');
	};
	// the items of one level, each after the frame that forward edges to it leave
	const sequence = (items: Item[], level: number, top: boolean, preamble: () => void) => {
		const first = top ? 0 : 1;
		for (let k = items.length - 1; k >= first; k--) open('block', `F${level}_${k}`);
		preamble();
		items.forEach((it, k) => {
			if (k >= first) close('end_block');
			if (k >= first || k === 0) item(it, level);
		});
	};
	const item = (it: Item, level: number) => {
		cat = 'dispatch';
		runsNow = 0n;
		locPc = 0;
		if (it.kind === 'block') return emitBlock(it.j);
		openLoop(it.loop.id);
		open('loop', `L${it.loop.id}`);
		sequence(it.items, it.loop.id, false, () => entryCheck(it.loop, it.items));
		close('end_loop');
		void level;
	};

	// prologue: the state, the data bases
	const hasFs = chosen.some((b) => b.ins.some((x) => opName(x.op) === 'FSBASE'));
	cat = 'state';
	for (const [name, sym] of [
		[okb, `${R}_ok`],
		[blkb, `${R}_blk`],
		[winb, `${R}_win`]
	] as const) {
		o('global.get\t__memory_base', `i32.const\t${sym}@MBREL`, 'i32.add');
		lset(name);
	}
	if (!isCallee) {
		for (const r of regList) {
			lget(CPU);
			o(`i64.load\t${L.cpuR + 8 * r}:p2align=0`);
			lset(g(r));
		}
		for (const [f, off] of [[fl.n, L.cpuN], [fl.z, L.cpuZ], [fl.c, L.cpuC], [fl.v, L.cpuV], [fl.p, L.cpuP], [dfl, L.cpuDf], [gen, L.cpuMapgen]] as const) {
			cpuLoad32(off);
			lset(f);
		}
	}
	if (hasFs) {
		lget(CPU);
		o(`i64.load\t${L.cpuFs}:p2align=0`);
		lset(gfs);
	}
	i32c(-1);
	lset(eloc);
	cat = 'dispatch';
	open('block', 'OUT');
	open('loop', 'D');
	sequence(layout, -1, true, () => {
		// dispatch: the block that starts at pc, if it is attached
		const sorted = chosen.map((b, j) => ({ pc: b.pc, j })).sort((a, c) => (a.pc < c.pc ? -1 : a.pc > c.pc ? 1 : 0));
		const leaf = (e: { pc: bigint; j: number }) => {
			lget(PC);
			i64c(e.pc);
			o('i64.eq');
			open('if', '#if');
			lget(okb);
			o(`i32.load8_u\t${e.j}:p2align=0`);
			open('if', '#if');
			if (entryRec[e.j] && mutate !== 'warmstale') {
				i32c(0);
				lset(warm());
			}
			const lvl = -1;
			const at = itemAt.get(`${lvl}:${e.j}`)!;
			const lp = itemIsLoop.get(`${lvl}:${at}`);
			if (lp && lp.header !== e.j) {
				i32c(pos[e.j]!);
				lset(eloc);
			} else {
				i32c(-1);
				lset(eloc);
			}
			br(`F${lvl}_${at}`);
			close('end_if');
			close('end_if');
		};
		const tree = (lo: number, hi: number) => {
			if (hi - lo <= 3) {
				for (let k = lo; k < hi; k++) leaf(sorted[k]!);
				return;
			}
			const mid = (lo + hi) >> 1;
			lget(PC);
			i64c(sorted[mid]!.pc);
			o('i64.lt_u');
			open('if', '#if');
			tree(lo, mid);
			o('else');
			tree(mid, hi);
			close('end_if');
		};
		tree(0, sorted.length);
		br('OUT');
	});
	close('end_loop');
	close('end_block');
	// epilogue: every exit stores the cpu words the interpreter resumes from
	const skip = mutate === 'skipreg' ? regList.filter((r) => r !== 0 && r !== SP)[0] : mutate === 'skipret' ? 0 : undefined;
	const flagLocals = [fl.n, fl.z, fl.c, fl.v, fl.p, dfl];
	const flagOffs = [L.cpuN, L.cpuZ, L.cpuC, L.cpuV, L.cpuP, L.cpuDf];
	cat = 'state';
	runsNow = 0n;
	locPc = 0;
	if (isCallee) {
		// the pc, the registers it wrote, the flags and the generation go back to the caller
		lget(PC);
		for (const r of results) lget(g(r));
		for (const f of [...flagLocals, gen]) lget(f);
	} else {
		for (const r of regList) {
			if (r === skip) continue;
			cpuStore64(L.cpuR + 8 * r, () => lget(g(r)));
		}
		flagLocals.forEach((f, k) => cpuStore32(flagOffs[k]!, () => lget(f)));
		lget(PC);
		if (mutate === 'badpc') {
			i64c(1n);
			o('i64.add');
		}
	}
	// #endregion

	const np = regList.length + 7;
	const sig = isCallee
		? `${R}_go (${['i32', 'i64', ...regList.map(() => 'i64'), ...flagLocals.map(() => 'i32'), 'i32'].join(', ')}) -> (${['i64', ...results.map(() => 'i64'), ...flagLocals.map(() => 'i32'), 'i32'].join(', ')})`
		: `${R}_run (i32, i64) -> (i64)`;
	const fn = isCallee ? `${R}_go` : `${R}_run`;
	const header = [
		...(isCallee ? [] : [`\t.globl\t${R}_run`]),
		`\t.hidden\t${fn}`,
		`\t.type\t${fn},@function`,
		`${fn}:`,
		`\t.functype\t${sig}`,
		...(types.length > (isCallee ? np : 0) ? [`\t.local\t${types.slice(isCallee ? np : 0).join(', ')}`] : [])
	];
	void condReads;
	void inRanges;
	void parseRanges;
	void selectBlocks;
	// the entry the interpreter and any other caller uses: the full state out of the cpu, into the callee, and back
	const wrapper = !isCallee
		? []
		: [
				`\t.globl\t${R}_run`,
				`\t.hidden\t${R}_run`,
				`\t.type\t${R}_run,@function`,
				`${R}_run:`,
				`\t.functype\t${R}_run (i32, i64) -> (i64)`,
				`\t.local\t${['i64', ...results.map(() => 'i64'), ...flagLocals.map(() => 'i32'), 'i32'].join(', ')}`,
				'\tlocal.get\t0',
				'\tlocal.get\t1',
				...regList.flatMap((r) => ['\tlocal.get\t0', `\ti64.load\t${L.cpuR + 8 * r}:p2align=0`]),
				...flagOffs.flatMap((off) => ['\tlocal.get\t0', `\ti32.load\t${off}:p2align=0`]),
				'\tlocal.get\t0',
				`\ti32.load\t${L.cpuMapgen}:p2align=0`,
				`\tcall\t${R}_go`,
				// locals 2.. in the order the callee returns them: pc, registers, flags, generation
				...[...Array(results.length + 8).keys()].reverse().map((k) => `\tlocal.set\t${2 + k}`),
				...results.flatMap((r, k) => ['\tlocal.get\t0', `\tlocal.get\t${3 + k}`, `\ti64.store\t${L.cpuR + 8 * r}:p2align=0`]),
				...flagOffs.flatMap((off, k) => ['\tlocal.get\t0', `\tlocal.get\t${3 + results.length + k}`, `\ti32.store\t${off}:p2align=0`]),
				'\tlocal.get\t2',
				'\tend_function',
				''
			];
	const asm = [...header, ...out, '\tend_function', '', ...wrapper];
	const interior = chosen.filter((_, j) => nest.of[j]! >= 0).length;
	const report: RegionReport = {
		name: R,
		chosen: region.chosen.length,
		emitted: n,
		exits,
		fallback: fallbackBlocks.size,
		interior,
		loops: nest.loops.length,
		irOps: chosen.reduce((s, b) => s + b.ins.length, 0),
		narrowStatic: blockReports.narrowStatic,
		aluStatic: blockReports.aluStatic,
		narrowWeighted: blockReports.narrowWeighted,
		aluWeighted: blockReports.aluWeighted,
		windows: windowCount,
		accesses: blockReports.accesses,
		windowed: blockReports.windowed,
		edge: edgeOn ? edgeStats : undefined,
		asmLines: asm.length,
		flagOps: fstat,
		cats: Object.fromEntries(catStat)
	};
	void ownWindows;
	return { asm, report, blocks: chosen.map((b) => original.get(b) ?? b), windows: windowCount };
}

if (import.meta.main) {
	const args = process.argv.slice(2);
	const flagArgs = args.filter((a) => a.startsWith('--'));
	const [outDir = '', coverageArg = '0.99', ...dumps] = args.filter((a) => !a.startsWith('--'));
	const flagsMode = (flagArgs.find((f) => f.startsWith('--flags='))?.slice(8) ?? 'live') as EmitConfig['flags'];
	if (!['live', 'all', 'none', 'recipe'].includes(flagsMode)) throw new Error('--flags takes live, all, none or recipe');
	const callsArg = flagArgs.find((f) => f === '--calls' || f.startsWith('--calls='));
	const callsMode = (callsArg === undefined ? 'off' : callsArg === '--calls' ? 'live' : callsArg.slice(8)) as NonNullable<EmitConfig['calls']>;
	if (!['off', 'live', 'all'].includes(callsMode)) throw new Error('--calls takes live or all');
	const globalRanges = flagArgs.find((f) => f.startsWith('--ranges='))?.slice(9);
	const regions = dumps.map((d) => {
		const [path = '', own] = d.split('@');
		const text = own ?? globalRanges;
		const { all, chosen, share } = selectBlocks(path, text === undefined ? undefined : parseRanges(text), Number(coverageArg));
		console.error(`${path}: ${all.length} blocks, ${chosen.length} chosen, ${(100 * share).toFixed(2)}% of executed ops`);
		return { all, chosen };
	});
	const t0 = performance.now();
	const edgeArg = flagArgs.find((f) => f === '--edge' || f.startsWith('--edge='));
	const edge = edgeArg === undefined ? false : edgeArg === '--edge' ? true : edgeArg.slice(7).split(',').map(Number);
	const done = emitRegions(regions, { flags: flagsMode, mutate: process.env.EMIT_MUTATE ?? '', wide: flagArgs.includes('--wide'), calls: callsMode, loc: flagArgs.includes('--loc'), edge });
	mkdirSync(outDir, { recursive: true });
	writeFileSync(`${outDir}/regions.s`, done.asm);
	writeFileSync(`${outDir}/tables.c`, done.tables);
	for (const r of done.reports) {
		const pct = (a: bigint | number, c: bigint | number) => (Number(c) ? ((100 * Number(a)) / Number(c)).toFixed(1) : '0.0');
		console.error(
			`${r.name}: ${r.chosen} chosen, ${r.emitted} emitted, ${r.exits.length} exit (${[...new Set(r.exits.map((e) => e.why))].join(', ') || '-'}), ${r.fallback} through the loop entry switch, ${r.interior} in ${r.loops} loops; ${r.irOps} IR ops, ${r.asmLines} asm lines; typed (32-bit) ALU ops ${pct(r.narrowStatic, r.aluStatic)}% static (${r.narrowStatic} of ${r.aluStatic}), ${pct(r.narrowWeighted, r.aluWeighted)}% weighted; ${r.accesses} loads and stores, ${r.windowed} in windows, ${r.windows} window caches`
		);
	}
	for (const r of done.reports) {
		const pct = (a: bigint | number, c: bigint | number) => (Number(c) ? ((100 * Number(a)) / Number(c)).toFixed(1) : '0.0');
		const f = r.flagOps;
		const all = f.deadW + f.recipeW + f.eagerW;
		const why = Object.entries(f.whyW).sort((p, q) => (q[1] > p[1] ? 1 : -1)).map(([k, v]) => `${k} ${f.why[k]} (${pct(v, all)}% weighted)`).join(', ');
		console.error(
			`${r.name} flags: ${f.total} ops, ${f.dead} dropped (${pct(f.deadW, all)}% weighted), ${f.recipe} recipes (${pct(f.recipeW, all)}%), ${f.eager} computed at once (${pct(f.eagerW, all)}%: ${why || '-'}); ${f.stubs} stubs make the flags from a recipe, ${f.predicates} reads of a recipe`
		);
	}
	for (const r of done.reports)
		if (r.edge) console.error(`${r.name} edge: ${r.edge.entries} blocks take a recipe in, ${r.edge.passed} edges pass one (${r.edge.passedW} weighted), ${r.edge.materialized} edges compute the flags a block reads (${r.edge.materializedW} weighted)`);
	if (flagArgs.includes('--stats')) {
		const total = new Map<string, { static: number; weighted: bigint }>();
		for (const r of done.reports)
			for (const [c, v] of Object.entries(r.cats)) {
				const t = total.get(c) ?? total.set(c, { static: 0, weighted: 0n }).get(c)!;
				t.static += v.static;
				t.weighted += v.weighted;
			}
		const sumS = [...total.values()].reduce((s, v) => s + v.static, 0);
		const sumW = [...total.values()].reduce((s, v) => s + v.weighted, 0n);
		console.error('category\tstatic\tstatic %\tweighted\tweighted %');
		for (const [c, v] of [...total].sort((p, q) => (q[1].weighted > p[1].weighted ? 1 : -1)))
			console.error(`${c}\t${v.static}\t${((100 * v.static) / sumS).toFixed(1)}\t${v.weighted}\t${sumW ? ((100 * Number(v.weighted)) / Number(sumW)).toFixed(1) : '0.0'}`);
		console.error(`total\t${sumS}\t100.0\t${sumW}\t100.0`);
	}
	console.error(`wrote ${outDir}/regions.s and tables.c in ${(performance.now() - t0).toFixed(0)} ms`);
}
