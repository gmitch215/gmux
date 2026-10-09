import { readFileSync, writeFileSync } from 'node:fs';
import { follow } from './bounds.ts';
import { analyze, vecWrite, type Cls } from './slots.ts';

/**
 * The AOT oracle's lifter: turns the hottest blocks of each KATYBUG_HOT dump into C, one region per
 * dump (one process), which clang then compiles into katybug.wasm with -DKB_AOT. A region holds guest
 * registers and flags in locals and moves between its blocks with goto; everything else leaves to the
 * interpreter. A decoded block runs a region only if its IR matches the lifted one exactly
 * (kb_aot_attach), so the guard is the IR itself. A block may be a trace (KB_EXIT side exits).
 *
 * `lift.ts [--temps] [--nogroups] [--windows] [--bounds] [--regs] [--slots] [--calls] [--ranges=<lo>-<hi>,...] <out.c> <coverage 0..1> <dump.hot>[@<lo>-<hi>,...]...`
 *
 * `--ranges` replaces the coverage cut: the region is the dump's blocks that start in those code ranges (one hot
 * function and the callees worth keeping inside it, from functions.ts), and the lifter reports its direct edges
 * inside, leaving, and through a register. A block outside the ranges, or one that cannot be lifted, is an exit.
 * A dump with its own `@ranges` takes those instead, and the same dump may be listed again for another region.
 *
 * `--calls` makes an edge from a block of one region to a block of another a direct C call: the callee region's
 * `go` function inlined there, entered at that block and run to wherever it leaves (aot.h states the contract).
 * A call whose block fuses the callee's first block (the dump's blocks run on through direct jumps) is such an
 * edge too, into the callee's next block. Without it every region leaves at such an edge.
 * `LIFT_MUTATE=noreturn` makes it unsound on purpose: a callee's registers are not handed back to the caller.
 * `--noinline` calls the `go` function out of line instead, so the callee's registers cross through the io
 * struct in memory and each form holds one copy of the callee.
 *
 * The flags are the representation ladder's rungs (ladder.sh): `--temps` keeps only architectural
 * registers across blocks and helper calls, `--nogroups` ignores the memory plan's KB_RESOLVE groups,
 * `--windows` runs each block's provable accesses (entry base or constant address plus offset) as
 * plain host accesses inside windows resolved once at the block's entry, with a checked copy of the
 * block for a window that does not resolve. `--bounds` adds the accesses whose address is such a base plus an
 * index with a bound (bounds.ts: a mask, an extension, a byte load, a compare the trace's exits proved), as a
 * window from the index's low end to its high end, at most one piece (64 KiB) wide; the access is at the window
 * plus its own distance from the window's start. `LIFT_MUTATE=shortwindow` ends such a window one element early
 * (unsound), `longwindow` one element late (a window that no longer resolves leaves to the checked copy).
 *
 * `--regs` emits each region twice: the form above, and a precise form (`r<n>p_run`) that spills
 * and reloads around an SSE, x87 or string helper only the registers and flags that helper can
 * read or write, and keeps the fs base in a local; `KATYBUG_REGS=1` picks it at run time. A
 * syscall still spills and reloads everything (it can fork, switch threads or deliver a signal).
 *
 * `--slots` adds a third form (`r<n>s_run`, `KATYBUG_REGS=2`) of the precise form that keeps rsp-relative
 * stack slots in locals across blocks (slots.ts); every store still writes memory. Needs `--temps
 * --windows`. `LIFT_MUTATE=noguard|nowrite` makes it unsound on purpose (an unknown store no longer
 * refreshes the slots; a slot store no longer reaches memory), so a check can show it fails.
 *
 * `--only=<0|1|2>` emits one body per region, the one form a product build holds, and points `aot_run` at it
 * (`aot_regs()` is not read, so `KATYBUG_REGS` does nothing): 0 is the plain form, 1 the precise one (needs `--regs`),
 * 2 the slots one (needs `--slots`; a region with no slot plan gets the precise body). No `aot_runp` or `aot_runs`.
 *
 * `--epochs` (build with -DKB_EPOCH=1) lifts to the interpreter's epoch guard: a region reads kb_epoch once when
 * it is entered and checks its caches against the mapping generation once then (a cache is cold or current, so
 * no window, group or access compares a generation), and a back edge leaves when kb_epoch is no longer the
 * entry's, which every signal and mapping change moves. Without it the generated C is what it was.
 *
 * `--identity` runs every guest load and store as a plain access through `AOT_HOST(va)` (aot.h): no windows, groups or
 * caches, no fault check. Only a runtime that maps the guest at its own addresses can run it, and a bad guest access
 * kills the host; measurement only.
 *
 * `--flags=live` drops a flag write that a backward liveness over the region's blocks proves unread. Every exit, helper
 * call, syscall and fault point (a load or store, unless `--identity`) reads all five flags, except an exit whose target
 * block is in the dump and writes all five before it reads any. `--flags=none` is the same pass with the exits, helpers,
 * syscalls and fault points reading nothing, so only flags a later op of the region reads survive: unsound where the
 * interpreter reads one, measurement only. `LIFT_MUTATE=exitdead` makes `live` unsound the same way for exits alone,
 * `faultdead` for the loads and stores alone (what `--identity` does soundly, with the accesses left as they are).
 */
const args = process.argv.slice(2);
const flags = new Set(args.filter((a) => a.startsWith('--')));
const [out = '', coverageArg = '0.99', ...dumps] = args.filter((a) => !a.startsWith('--'));
const opt = {
	temps: flags.has('--temps'),
	nogroups: flags.has('--nogroups'),
	windows: flags.has('--windows'),
	regs: flags.has('--regs') || flags.has('--slots'),
	slots: flags.has('--slots'),
	calls: flags.has('--calls'),
	noinline: flags.has('--noinline'),
	epochs: flags.has('--epochs'),
	identity: flags.has('--identity'),
	bounds: [...flags].some((f) => f === '--bounds' || f.startsWith('--bounds=')),
	two: flags.has('--bounds=two'),
	loops: flags.has('--loop-guards')
};
const flagsFlag = [...flags].find((f) => f.startsWith('--flags'));
const flagsMode = flagsFlag === undefined ? 'all' : (/^--flags=(live|none)$/.exec(flagsFlag)?.[1] ?? '');
if (!flagsMode) throw new Error('--flags takes live or none (--flags=live)');
// a cache that is not cold is current under epochs, so the generation compare is left out
const G = opt.epochs ? '' : 'q->gen == gen && ';
const mutate = process.env.LIFT_MUTATE ?? '';
if (opt.slots && !(opt.temps && opt.windows)) throw new Error('--slots needs --temps and --windows');
if (opt.loops && !(opt.temps && opt.windows)) throw new Error('--loop-guards needs --temps and --windows');
if ((opt.two || opt.loops) && opt.epochs) throw new Error('--bounds=two and --loop-guards need the generation compare, not --epochs');
if (opt.two && opt.identity) throw new Error('--bounds=two has no windows under --identity');
const onlyFlag = [...flags].find((f) => f.startsWith('--only'));
const only = onlyFlag === undefined ? undefined : Number(/^--only=([012])$/.exec(onlyFlag)?.[1] ?? NaN);
if (only !== undefined && Number.isNaN(only)) throw new Error('--only takes 0, 1 or 2 (--only=1)');
if (only === 1 && !opt.regs) throw new Error('--only=1 needs --regs');
if (only === 2 && !opt.slots) throw new Error('--only=2 needs --slots');
const coverage = Number(coverageArg);
type Ranges = [bigint, bigint][];
const parseRanges = (text: string) => text.split(',').map((r) => r.split('-').map((v) => BigInt(v)) as [bigint, bigint]);
// `--ranges=<lo>-<hi>,...` lifts the blocks that start in those code ranges (a function and its callees), however hot
const globalRanges = [...flags].find((f) => f.startsWith('--ranges='))?.slice(9);
const specs = dumps.map((d) => {
	const [path = '', own] = d.split('@');
	const text = own ?? globalRanges;
	return { path, ranges: text ? parseRanges(text) : undefined };
});
const inRanges = (ranges: Ranges, pc: bigint) => ranges.some(([lo, hi]) => pc >= lo && pc < hi);
const root = new URL('../../../', import.meta.url).pathname;

// the IR's op numbers, in kb.h's order
const header = readFileSync(`${root}src/gmux/katybug/kb.h`, 'utf8');
const opBody = header.match(/enum kb_op\s*\{([\s\S]*?)\};/)![1]!.replace(/\/\*[\s\S]*?\*\//g, '');
const OPS = opBody
	.split(',')
	.map((s) => s.trim())
	.filter(Boolean);
const op = Object.fromEntries(OPS.map((name, i) => [name.replace(/^KB_/, ''), i])) as Record<string, number>;
const opName = (o: number) => OPS[o]!.replace(/^KB_/, '');
const KB_ZERO = 63;
const KB_T0 = 32;
const SP = 4; // rsp
const SPAN = 16 * 255; // the memory plan's window (run.c plan_mem)
// one piece of a mapping (kb.h KB_PIECE_BITS) is the widest window a resolve can cover; --bounds=<bytes> takes less
const BIG = BigInt(opt.two ? 1 << 16 : ([...flags].find((f) => f.startsWith('--bounds='))?.slice(9) ?? 1 << 16));
const MAX_WINDOWS = 8;
const MAX_SLOTS = 12;

interface Ins {
	op: number;
	w: number;
	a: number;
	b: number;
	c: number;
	imm: bigint;
}
interface Block {
	pc: bigint;
	next: bigint;
	target: bigint;
	runs: bigint;
	ins: Ins[];
	pcs?: number[];
}

function parse(path: string): Block[] {
	const lines = readFileSync(path, 'utf8').split('\n');
	const blocks: Block[] = [];
	for (let i = 0; i < lines.length; i++) {
		const m = lines[i]!.match(/^block (\w+) (\w+) (\w+) (\d+) (\d+)$/);
		if (!m) continue;
		const n = Number(m[4]);
		const ins: Ins[] = [];
		for (let k = 1; k <= n; k++) {
			const f = lines[i + k]!.split(' ');
			ins.push({ op: +f[0]!, w: +f[1]!, a: +f[2]!, b: +f[3]!, c: +f[4]!, imm: BigInt(f[5]!) });
		}
		i += n;
		if ((lines[i + 1] ?? '').startsWith('exits')) i++;
		// each op's guest instruction as an offset from the block's pc (the interpreter's side table)
		let pcs: number[] | undefined;
		if ((lines[i + 1] ?? '').startsWith('pcs ')) pcs = lines[++i]!.split(' ').slice(1).map((v) => Number(v) | 0);
		blocks.push({ pc: BigInt(`0x${m[1]}`), next: BigInt(`0x${m[2]}`), target: BigInt(`0x${m[3]}`), runs: BigInt(m[5]!), ins, pcs });
	}
	return blocks;
}

// ops a region cannot run: AArch64-only state and traps stay with the interpreter
const unliftable = new Set(['TRAP', 'WTRAP', 'WEXIT', 'CCMP', 'TPIDR', 'SETTP', 'CLOCK', 'CPUID', 'EXCL', 'PRIM', 'A64V'].map((n) => op[n]!));
const liftable = (b: Block) => b.ins.every((x) => !unliftable.has(x.op));
// a region's direct edges: inside it (a goto), leaving it (an exit to the interpreter), and the jumps through a register
function edgeReport(dump: string, chosen: Block[], direct = 0) {
	const starts = new Set(chosen.map((b) => b.pc));
	let inside = 0;
	let outside = 0;
	let indirect = 0;
	let syscalls = 0;
	for (const b of chosen) {
		const last = b.ins.at(-1)!;
		if (opName(last.op) === 'JMP' && constJump(b) === undefined) indirect++;
		else if (opName(last.op) === 'SYSCALL') syscalls++;
		for (const t of edgesOf(b)) if (starts.has(t)) inside++;
		else outside++;
	}
	console.error(`${dump}: region ${chosen.length} blocks, ${inside} direct edges inside, ${outside} leaving, ${indirect} jumps through a register, ${syscalls} syscalls${direct ? `, ${direct} of the leaving go straight into another region` : ''}`);
}

// the constant a block's final jump goes to (a MOVI into the jump's register just before), if it has one
function constJump(b: Block) {
	const last = b.ins.at(-1)!;
	const before = b.ins.at(-2);
	return opName(last.op) === 'JMP' && before && opName(before.op) === 'MOVI' && before.a === last.b ? BigInt.asUintN(64, before.imm) : undefined;
}
// the pcs a block can go to without a register: its branches and exits, its jump's constant, its fall-through
function edgesOf(b: Block) {
	const to: bigint[] = [];
	for (const x of b.ins) {
		const name = opName(x.op);
		if (name === 'BR' || name === 'BRZ') to.push(b.target);
		else if (name === 'EXIT') to.push(BigInt.asUintN(64, b.pc + BigInt.asIntN(32, x.imm >> 16n)));
	}
	const last = b.ins.at(-1)!;
	if (opName(last.op) === 'JMP') {
		const t = constJump(b);
		if (t !== undefined) to.push(t);
	} else if (opName(last.op) !== 'SYSCALL') to.push(b.next);
	return to;
}
const hex = (v: bigint) => `0x${BigInt.asUintN(64, v).toString(16)}ull`;
const imm64 = (v: bigint) => `(uint64_t) ${hex(v)}`;

// the registers an op reads and writes, for the temporaries' liveness
function rw(x: Ins): { r: number[]; w: number[] } {
	const name = opName(x.op);
	switch (name) {
		case 'MOVI':
		case 'CARRY':
		case 'SETCC':
		case 'FSBASE':
			return { r: [], w: [x.a] };
		case 'MOV':
		case 'ZEXT':
		case 'SEXT':
		case 'BSWAP':
		case 'CLZ':
		case 'CTZ':
		case 'POPCNT':
		case 'LD':
		case 'LDS':
			return { r: [x.b], w: [x.a] };
		case 'ADD':
		case 'SUB':
		case 'AND':
		case 'OR':
		case 'XOR':
		case 'SHL':
		case 'SHR':
		case 'SAR':
		case 'ROR':
		case 'MUL':
		case 'UMULH':
		case 'SMULH':
		case 'UDIV':
		case 'SDIV':
		case 'UREM':
		case 'SREM':
		case 'SEL':
			return { r: [x.b, x.c], w: [x.a] };
		case 'INS':
			return { r: [x.a, x.b], w: [x.a] };
		case 'X86SHD':
			return { r: [x.a, x.b, x.c], w: [x.a] };
		case 'ST':
		case 'FLAGS':
			return { r: name === 'ST' ? [x.a, x.b] : [x.a, x.b, x.c], w: [] };
		case 'BRZ':
			return { r: [x.a], w: [] };
		case 'EXIT':
			return { r: x.imm & 0x100n ? [x.a] : [], w: [] };
		case 'JMP':
		case 'X86MD':
		case 'RESOLVE':
		case 'SSE':
		case 'X87':
			return { r: [x.b], w: [] };
		case 'X86FLAGS':
			return x.imm === 0n ? { r: [], w: [x.a] } : x.imm === 1n ? { r: [x.a], w: [] } : { r: [], w: [] };
		default:
			return { r: [], w: [] };
	}
}
const isTemp = (r: number) => r >= KB_T0 && r < KB_ZERO;

// what an SSE, x87 or string helper reads and writes besides xmm, x87 and memory state (sse.c,
// x87.c, run.c string): GPRs, the five flags and df. A register it may write is also spilled
interface Touch {
	r: number[];
	w: number[];
	flags: boolean;
	df: boolean;
}
function touches(x: Ins): Touch {
	const name = opName(x.op);
	const mem = (x.c & 0x80) !== 0;
	const t: Touch = { r: [], w: [], flags: false, df: false };
	if (name === 'X86STR') {
		t.r.push(1, 6, 7);
		t.w.push(1, 6, 7);
		if (x.imm === 1n) t.r.push(0);
		t.df = true;
		return t;
	}
	if (mem) t.r.push(x.b);
	if (name === 'SSE') {
		const code = Number(x.imm & 0xffn);
		const pre = Number((x.imm >> 8n) & 0xffn);
		if (!mem && [0x2a, 0x6e, 0xc4].includes(code)) t.r.push(x.c & 15);
		if (!mem && code === 0x7e && pre === 0x66) t.w.push(x.c & 15);
		if ([0x2c, 0x2d, 0x50, 0xc5, 0xd7].includes(code)) t.w.push(x.a & 15);
		if (code === 0x2e || code === 0x2f) t.flags = true;
	} else {
		const op = Number((x.imm >> 8n) & 7n);
		const modrm = Number(x.imm & 0xffn);
		if (op === 7 && modrm === 0xe0) t.r.push(0), t.w.push(0);
		if (!mem && (op === 2 || op === 3 || op === 7)) t.flags = true;
	}
	return t;
}

// #region flag liveness (--flags)
const FK = header
	.match(/enum kb_fk\s*\{([\s\S]*?)\};/)![1]!
	.replace(/\/\*[\s\S]*?\*\//g, '')
	.split(',')
	.map((s) => s.trim().replace(/^KB_F_/, ''))
	.filter(Boolean);
const [FN, FZ, FC, FV, FP] = [1, 2, 4, 8, 16];
const FALL = 31;
// what aot_flags writes for a kind: may (some path writes it), def (every path does), use (reads it first)
function kindFlags(kind: string) {
	const w = (may: number, def = may, use = 0) => ({ may, def, use });
	switch (kind) {
		case 'INC':
		case 'DEC':
			return w(FN | FZ | FV | FP);
		case 'ADC':
		case 'SBB':
			return w(FALL, FALL, FC);
		case 'SHL':
		case 'SHR':
		case 'SAR':
			return w(FALL, 0);
		case 'ROL':
		case 'ROR':
			return w(FC | FV, 0);
		case 'MULOV':
			return w(FC | FV);
		case 'NZCV':
			return w(FN | FZ | FC | FV);
		case 'SETC':
			return w(FC);
		case 'ZERO':
			return w(FZ);
		case 'CNT':
			return w(FC | FZ);
		default:
			return w(FALL);
	}
}
// the flags aot_cond reads
function condReads(cond: number) {
	if (cond < 16) return [FV, FC, FZ, FC | FZ, FN, FP, FN | FV, FZ | FN | FV][cond >> 1]!;
	const k = cond - 16;
	return k >= 14 ? 0 : [FZ, FC, FN, FV, FC | FZ, FN | FV, FZ | FN | FV][k >> 1]!;
}
// an op's effect on the five flags; all is a read of every flag (a helper, a syscall, or a fault point when `fault`)
function flagEffect(x: Ins, fault: boolean) {
	const e = { use: 0, def: 0, may: 0, all: false };
	switch (opName(x.op)) {
		case 'FLAGS':
			return { ...e, ...kindFlags(FK[Number(x.imm)]!) };
		case 'SETCC':
		case 'SEL':
			return { ...e, use: condReads(Number(x.imm)) };
		case 'CARRY':
			return { ...e, use: FC };
		case 'X86SHD':
			return { ...e, may: FALL };
		case 'X86FLAGS':
			if (x.imm === 0n) return { ...e, use: FALL };
			if (x.imm === 1n) return { ...e, may: FALL, def: FALL };
			if (x.imm === 2n) return { ...e, may: FC, def: FC, use: FC };
			return x.imm <= 4n ? { ...e, may: FC, def: FC } : e;
		case 'LD':
		case 'LDS':
		case 'ST':
			return { ...e, all: fault };
		case 'X86MD':
		case 'SSE':
		case 'X87':
		case 'X86STR':
		case 'SYSCALL':
			return { ...e, all: true };
		default:
			return e;
	}
}
// the FLAGS ops (as `block:op`) that write only flags no later op reads, over a region's blocks. `dump` holds every
// block of the dump, for the exits that land on one
function deadFlags(chosen: Block[], index: Map<bigint, number>, calls: Map<bigint, number>, dump: Map<bigint, Block>) {
	const none = flagsMode === 'none';
	const exitAll = none ? 0 : FALL;
	// a block that writes all five flags before it reads any (a branch, a fault point or a helper first reads them)
	const killsAll = (t: Block) => {
		let def = 0;
		for (const x of t.ins) {
			if (['BR', 'BRZ', 'EXIT', 'JMP'].includes(opName(x.op))) return false;
			const e = flagEffect(x, true);
			if (e.use || e.all) return false;
			def |= e.def;
			if (def === FALL) return true;
		}
		return false;
	};
	const live = chosen.map(() => 0);
	const edge = (to: bigint) => {
		const k = index.get(to);
		if (k !== undefined) return live[k]!;
		if (calls.has(to)) return exitAll;
		if (mutate === 'exitdead') return 0;
		const t = dump.get(to);
		return t && killsAll(t) ? 0 : exitAll;
	};
	const dead = new Set<string>();
	// the flags live at the start of block j, recording the dead FLAGS ops when asked
	const walk = (b: Block, j: number, record: boolean) => {
		const lastName = opName(b.ins.at(-1)!.op);
		let now = lastName === 'JMP' || lastName === 'SYSCALL' ? 0 : edge(b.next);
		for (let i = b.ins.length - 1; i >= 0; i--) {
			const x = b.ins[i]!;
			const name = opName(x.op);
			if (name === 'BR') now |= edge(b.target) | condReads(Number(x.imm));
			else if (name === 'BRZ') now |= edge(b.target);
			else if (name === 'EXIT') now |= edge(BigInt.asUintN(64, b.pc + BigInt.asIntN(32, x.imm >> 16n))) | (x.imm & 0x100n ? 0 : condReads(Number(x.imm & 0xffn)));
			else if (name === 'JMP') {
				const k = constJump(b);
				now = k !== undefined ? edge(k) : mutate === 'exitdead' ? 0 : exitAll;
			} else {
				const e = flagEffect(x, !opt.identity && mutate !== 'faultdead');
				if (name === 'FLAGS' && !(e.may & now)) {
					if (record) dead.add(`${j}:${i}`);
					continue;
				}
				now = (now & ~e.def) | e.use | (e.all ? exitAll : 0);
			}
		}
		return now;
	};
	for (let changed = true; changed; ) {
		changed = false;
		for (let j = chosen.length - 1; j >= 0; j--) {
			const v = live[j]! | walk(chosen[j]!, j, false);
			if (v !== live[j]) {
				live[j] = v;
				changed = true;
			}
		}
	}
	chosen.forEach((b, j) => walk(b, j, true));
	return dead;
}
// #endregion

// the entry-relative windows of a block: accesses whose base is a register's entry value or a
// constant, plus an offset, grouped into spans the memory plan's size, at most MAX_WINDOWS
interface Win {
	root: number; // register, or -1 for a constant address
	lo: bigint;
	hi: bigint;
	// --bounds=two: wider than the memory plan's span, so it may cross one piece boundary and holds two resolved pieces
	two?: boolean;
	// the window's first inline cache in the region's window array (a two-piece window takes the next one as well)
	ic?: number;
}
interface Hit {
	win: number;
	off: bigint;
	// the address is a base plus an index with a bound, so the access is at the window plus its own distance from the window's start
	dyn: boolean;
	// a loop window (--loop-guards): resolved when its loop is entered, not at the block's entry
	loop?: boolean;
}
interface Acc {
	i: number;
	root: number;
	off: bigint;
	hi: bigint;
	w: number;
}
// `slots` leaves out the stores and the rsp-based accesses, which the block's frame window serves; `skip` the accesses a loop window serves
function windowsOf(b: Block, slots = false, skip?: ReadonlySet<number>): { wins: Win[]; hits: Map<number, Hit>; hard: boolean[] } {
	if (opt.identity) return { wins: [], hits: new Map(), hard: [] };
	return group(accessesOf(b, slots).filter((a) => !skip?.has(a.i)));
}
function accessesOf(b: Block, slots: boolean): Acc[] {
	return follow(b.ins, op, opt.bounds)
		.filter((f) => !(slots && (f.store || f.root === SP)) && (f.hi === f.lo || f.hi - f.lo + BigInt(f.w) <= BIG))
		.map((f) => ({ i: f.i, root: f.root, off: f.lo, hi: f.hi, w: f.w }));
}
// the accesses grouped into windows of at most the memory plan's span (an indexed access wider than that is a window of its own)
function group(acc: Acc[]): { wins: Win[]; hits: Map<number, Hit>; hard: boolean[] } {
	const wins: Win[] = [];
	const hits = new Map<number, Hit>();
	const hard: boolean[] = [];
	const roots = [...new Set(acc.map((a) => a.root))];
	const found: { win: Win; list: typeof acc }[] = [];
	for (const rt of roots) {
		const list = acc.filter((a) => a.root === rt).sort((p, q) => (p.off < q.off ? -1 : p.off > q.off ? 1 : 0));
		for (let s = 0; s < list.length; ) {
			let e = s + 1;
			let hi = list[s]!.hi + BigInt(list[s]!.w);
			// an access with an index bound wider than the span is a window of its own
			while (e < list.length) {
				const end = list[e]!.hi + BigInt(list[e]!.w);
				if (Number((end > hi ? end : hi) - list[s]!.off) > SPAN) break;
				if (end > hi) hi = end;
				e++;
			}
			found.push({ win: { root: rt, lo: list[s]!.off, hi }, list: list.slice(s, e) });
			s = e;
		}
	}
	found.sort((p, q) => q.list.length - p.list.length);
	for (const f of found.slice(0, MAX_WINDOWS)) {
		const idx = f.list.filter((a) => a.hi > a.off);
		if (opt.two && f.win.hi - f.win.lo > BigInt(SPAN)) f.win.two = true;
		// the mutants move the end of an indexed window by one element: short is unsound, long only costs a resolve
		if (idx.length && mutate === 'shortwindow') f.win.hi -= BigInt(idx[0]!.w);
		if (idx.length && mutate === 'longwindow') f.win.hi += BigInt(idx[0]!.w);
		wins.push(f.win);
		// a window with only indexed accesses falls back access by access, so one that does not resolve leaves the others be
		hard.push(f.list.some((a) => a.hi === a.off));
		for (const a of f.list) hits.set(a.i, { win: wins.length - 1, off: a.off - f.win.lo, dyn: a.hi > a.off });
	}
	return { wins, hits, hard };
}

// #region loops (--loop-guards)
// the strongly connected sets of `nodes` over succ, each with its members
function sccs(nodes: number[], succ: number[][]): number[][] {
	const member = new Set(nodes);
	const idx = new Map<number, number>();
	const low = new Map<number, number>();
	const onStack = new Set<number>();
	const stack: number[] = [];
	const out: number[][] = [];
	let counter = 0;
	const visit = (v: number) => {
		idx.set(v, counter);
		low.set(v, counter++);
		stack.push(v);
		onStack.add(v);
	};
	for (const root of nodes) {
		if (idx.has(root)) continue;
		visit(root);
		const work: [number, number][] = [[root, 0]];
		while (work.length) {
			const top = work[work.length - 1]!;
			const v = top[0];
			const edges = succ[v]!;
			if (top[1] < edges.length) {
				const w = edges[top[1]++]!;
				if (!member.has(w)) continue;
				if (!idx.has(w)) {
					visit(w);
					work.push([w, 0]);
				} else if (onStack.has(w)) low.set(v, Math.min(low.get(v)!, idx.get(w)!));
				continue;
			}
			work.pop();
			if (work.length) {
				const p = work[work.length - 1]![0];
				low.set(p, Math.min(low.get(p)!, low.get(v)!));
			}
			if (low.get(v) !== idx.get(v)) continue;
			const comp: number[] = [];
			let w: number;
			do {
				w = stack.pop()!;
				onStack.delete(w);
				comp.push(w);
			} while (w !== v);
			out.push(comp);
		}
	}
	return out;
}
interface Loop {
	id: number;
	// every block of the strongly connected set, the blocks of the loops inside it included
	blocks: Set<number>;
	parent: number; // the loop around it, -1 for none
}
// each cyclic strongly connected set of the region's blocks is a loop; the cycles left once its header (the member entered
// from outside the most) is taken out are the loops inside it. `of` is each block's innermost loop, -1 for none
function findLoops(succ: number[][], runs: bigint[]): { loops: Loop[]; of: number[] } {
	const loops: Loop[] = [];
	const of = succ.map(() => -1);
	const preds = succ.map(() => [] as number[]);
	succ.forEach((to, j) => to.forEach((k) => preds[k]!.push(j)));
	const decompose = (nodes: number[], parent: number) => {
		for (const comp of sccs(nodes, succ)) {
			if (comp.length === 1 && !succ[comp[0]!]!.includes(comp[0]!)) continue;
			const id = loops.length;
			const set = new Set(comp);
			loops.push({ id, blocks: set, parent });
			for (const j of comp) of[j] = id;
			let header = comp[0]!;
			let best = -1n;
			for (const j of comp) {
				const outside = preds[j]!.filter((p) => !set.has(p)).length;
				const score = BigInt(outside) * (1n << 62n) + runs[j]!;
				if (score > best) {
					best = score;
					header = j;
				}
			}
			decompose(comp.filter((j) => j !== header), id);
		}
	};
	decompose(succ.map((_, j) => j), -1);
	return { loops, of };
}
// #endregion

const lines: string[] = [...(opt.epochs ? ['#define AOT_EPOCHS 1'] : []), '#include <string.h>', '#include "aot.h"', ''];
const table: { pc: bigint; next: bigint; target: bigint; n: number; region: number; idx: number; name: string }[] = [];
const regionNames: string[] = [];
const regionSizes: number[] = [];
const regionSlotted: boolean[] = [];
let irIns = 0;
let windowCount = 0;

// each region's blocks, chosen before any is lifted so a call can name the region it enters
const selected = specs.map(({ path, ranges }) => {
	const all = parse(path);
	const weight = (b: Block) => b.runs * BigInt(b.ins.length);
	const total = all.reduce((s, b) => s + weight(b), 0n);
	const sorted = [...all].sort((x, y) => (weight(y) > weight(x) ? 1 : weight(y) < weight(x) ? -1 : 0));
	const chosen: Block[] = [];
	let covered = 0n;
	for (const b of sorted) {
		if (ranges ? !inRanges(ranges, b.pc) : Number(covered) >= coverage * Number(total)) {
			if (ranges) continue;
			break;
		}
		if (!liftable(b)) continue;
		chosen.push(b);
		covered += weight(b);
	}
	return { all, chosen, share: Number(covered) / Number(total) };
});

// a region of no blocks (a function the run never reached) is dropped unless it is the only one
const keep = (_: unknown, r: number) => selected[r]!.chosen.length > 0 || specs.length === 1;
const live = specs.filter(keep);
const picked = selected.filter(keep);

// direct calls: an edge from a block to a block of another region that has no syscall (a syscall can fork or switch
// threads, and needs every register in the cpu) runs that region inline, from that block to wherever it leaves. An
// edge that would close a cycle between regions leaves instead, so each callee is emitted before its callers
const owner = new Map<bigint, number>();
picked.forEach((p, r) => p.chosen.forEach((b) => owner.has(b.pc) || owner.set(b.pc, r)));
const noSyscall = picked.map((p) => p.chosen.every((b) => b.ins.every((x) => opName(x.op) !== 'SYSCALL')));
const calleesOf = picked.map((p, r) => {
	const out = new Map<bigint, number>();
	if (opt.calls)
		for (const b of p.chosen)
			for (const t of edgesOf(b)) {
				const to = owner.get(t);
				if (to !== undefined && to !== r && noSyscall[to]) out.set(t, to);
			}
	return out;
});
const order: number[] = [];
const visiting: number[] = picked.map(() => 0);
const visit = (r: number) => {
	visiting[r] = 1;
	for (const [to, c] of [...calleesOf[r]!]) {
		if (visiting[c] === 1) calleesOf[r]!.delete(to);
		else if (visiting[c] === 0) visit(c);
	}
	visiting[r] = 2;
	order.push(r);
};
picked.forEach((_, r) => visiting[r] || visit(r));
const called = new Set([...calleesOf].flatMap((m) => [...m.values()]));
// what a caller needs of a region it calls, once that region is emitted
const info: { name: string; regList: number[]; index: Map<bigint, number>; slotted: boolean }[] = [];

order.forEach((region) => {
	const dump = live[region]!.path;
	const { all, chosen, share } = picked[region]!;
	const ranges = live[region]!.ranges;
	const calls = calleesOf[region]!;
	if (ranges) edgeReport(dump, chosen, chosen.flatMap(edgesOf).filter((t) => calls.has(t)).length);
	console.error(`${dump}: ${all.length} blocks, ${chosen.length} lifted, ${(100 * share).toFixed(2)}% of executed ops`);

	const R = `r${region}`;
	regionNames[region] = `${R}_run`;
	regionSizes[region] = chosen.length;
	const index = new Map(chosen.map((b, j) => [b.pc, j]));
	const dead = flagsMode === 'all' ? new Set<string>() : deadFlags(chosen, index, calls, new Map(all.map((b) => [b.pc, b])));
	if (flagsMode !== 'all') console.error(`${dump}: --flags=${flagsMode} drops ${dead.size} of ${chosen.reduce((n, b) => n + b.ins.filter((x) => opName(x.op) === 'FLAGS').length, 0)} flag writes`);
	const arch =/^arch (\d+)$/m.exec(readFileSync(dump, 'utf8'));
	const found = opt.slots && (only === undefined || only === 2) && (!arch || arch[1] === '0') ? analyze(chosen, index, { name: opName, rw, sp: SP, zero: KB_ZERO, span: SPAN, maxSlots: MAX_SLOTS }) : undefined;
	const plan = found?.promoted.some(Boolean) ? found : undefined;
	if (plan) {
		const loads = plan.slots.length;
		console.error(`${dump}: ${plan.promoted.filter(Boolean).length} blocks in ${plan.wins.length} frames, ${loads} slots, windows ${plan.wins.map((w) => w.hi - w.lo).join(' ')} bytes`);
	}
	// the fields that name registers: SSE and x87 carry an xmm index and a memory marker in a and c,
	// and string ops read theirs through the cpu after the spill
	const registerFields = (x: Ins) => {
		const name = opName(x.op);
		if (name === 'SSE' || name === 'X87') return [x.b];
		if (name === 'X86STR' || name === 'PC' || name === 'SYSCALL') return [];
		// an access's c and a resolve's a are memory-plan groups
		if (name === 'LD' || name === 'LDS' || name === 'ST') return [x.a, x.b];
		if (name === 'RESOLVE') return [x.b];
		return [x.a, x.b, x.c];
	};
	const regs = new Set<number>([0, 2]);
	for (const b of chosen) for (const x of b.ins) for (const r of registerFields(x)) if (r !== KB_ZERO) regs.add(r);
	// a region that can be called or that calls holds every register a helper reads or writes and every register of
	// its callees, so a register is never in the cpu on one side of a call and in a local on the other
	const callee = new Set(calls.values());
	if (opt.calls)
		for (const b of chosen)
			for (const x of b.ins) if (['SSE', 'X87', 'X86STR'].includes(opName(x.op))) for (const r of [...touches(x).r, ...touches(x).w]) regs.add(r);
	const extraCross = new Set<number>();
	for (const c of callee)
		for (const r of info[c]!.regList) {
			regs.add(r);
			extraCross.add(r);
		}
	// a temporary read before it is written in a block lives across blocks and stays region state
	const liveIn = new Set<number>();
	for (const b of chosen) {
		const written = new Set<number>();
		for (const x of b.ins) {
			const { r, w } = rw(x);
			for (const t of r) if (isTemp(t) && t !== 62 && !written.has(t)) liveIn.add(t);
			for (const t of w) written.add(t);
		}
	}
	if (liveIn.size) console.error(`${dump}: temporaries live across blocks: ${[...liveIn].join(' ')}`);
	const cross = (r: number) => !opt.temps || !isTemp(r) || liveIn.has(r) || extraCross.has(r);
	const reg = (r: number) => (r === KB_ZERO ? '(uint64_t) 0' : `g${r}`);
	const dst = (r: number) => (r === KB_ZERO ? 'sink' : `g${r}`);
	const regList = [...regs].filter(cross).sort((a, b) => a - b);

	// the window array's index of each window of a block's fast body
	const winBase = new Map<number, number[]>();
	// the statements that resolve a window into its variables (a two-piece one through aot_open2)
	const open = (w: Win, v: { w: string; va: string; x: string; bd: string }, ic: number, setVa: boolean) => {
		const len = Number(w.hi - w.lo);
		const at = w.root < 0 ? hex(w.lo) : `${reg(w.root)} + ${imm64(w.lo)}`;
		if (w.two)
			return [`\t{ uint64_t va = ${at}; ${v.va} = va; ${v.w} = aot_open2(cpu, &${R}_win[${ic}], &${R}_win[${ic + 1}], gen, va, ${len}u, &${v.x}, &${v.bd}); }`];
		return [
			`\t{ uint64_t va = ${at}; struct kb_ic* q = &${R}_win[${ic}];${setVa ? ` ${v.va} = va;` : ''}`,
			`\t  ${v.w} = ${G}${len}u <= q->span && va - q->lo <= q->span - ${len}u ? q->host + (va - q->lo) : kb_host_ic(cpu, q, va, ${len}u); }`
		];
	};
	// #region loops (--loop-guards)
	// a loop's windows resolve when it is entered and after a syscall or call inside it; one that fails leaves its accesses
	// checked one by one, so the fault is where the guest instruction is
	const nest = opt.loops
		? findLoops(
				chosen.map((b) => edgesOf(b).map((t) => index.get(t)).filter((k): k is number => k !== undefined)),
				chosen.map((b) => b.runs)
			)
		: { loops: [] as Loop[], of: chosen.map(() => -1) };
	const loopWrites = nest.loops.map((l) => {
		const w = new Set<number>();
		let all = false;
		for (const j of l.blocks) {
			const b = chosen[j]!;
			// a direct call runs another region's blocks on these registers
			if (edgesOf(b).some((t) => calls.has(t))) all = true;
			for (const x of b.ins) {
				const name = opName(x.op);
				for (const r of rw(x).w) w.add(r);
				if (name === 'X86STR' || name === 'SSE' || name === 'X87') for (const r of touches(x).w) w.add(r);
				if (name === 'X86MD') [0, 2].forEach((r) => w.add(r));
				if (name === 'SYSCALL') {
					if (!arch || arch[1] === '0') [0, 1, 11].forEach((r) => w.add(r));
					else all = true;
				}
			}
		}
		return { w, all };
	});
	interface LoopData {
		wins: Win[];
		// the hits of each block, by instruction
		hits: Map<number, Map<number, Hit>>;
		// the loops with windows around each block, outer first
		chain: number[][];
		byLoop: Map<number, number[]>;
	}
	const loopCache = new Map<boolean, LoopData>();
	const loopData = (slotted: boolean): LoopData => {
		const cached = loopCache.get(slotted);
		if (cached) return cached;
		const KEY = 1 << 16;
		const per = new Map<number, Acc[]>();
		chosen.forEach((b, j) => {
			if (nest.of[j]! < 0) return;
			const up: number[] = [];
			for (let l = nest.of[j]!; l >= 0; l = nest.loops[l]!.parent) up.unshift(l);
			for (const a of accessesOf(b, slotted && !!plan?.promoted[j])) {
				// the outermost loop the access's base register is not written in
				const owner = up.find((o) => a.root < 0 || (!loopWrites[o]!.all && !loopWrites[o]!.w.has(a.root)));
				if (owner !== undefined) (per.get(owner) ?? per.set(owner, []).get(owner)!).push({ ...a, i: j * KEY + a.i });
			}
		});
		const wins: Win[] = [];
		const hits = new Map<number, Map<number, Hit>>();
		const byLoop = new Map<number, number[]>();
		for (const [o, list] of [...per].sort((p, q) => p[0] - q[0])) {
			const g = group(list);
			const first = wins.length;
			byLoop.set(o, g.wins.map((_, k) => first + k));
			for (const w of g.wins) {
				w.ic = windowCount;
				windowCount += w.two ? 2 : 1;
				wins.push(w);
			}
			for (const [key, h] of g.hits) {
				const j = Math.floor(key / KEY);
				(hits.get(j) ?? hits.set(j, new Map()).get(j)!).set(key % KEY, { ...h, win: first + h.win, loop: true });
			}
		}
		const chain = chosen.map((_, j) => {
			const c: number[] = [];
			for (let l = nest.of[j]!; l >= 0; l = nest.loops[l]!.parent) if (byLoop.has(l)) c.unshift(l);
			return c;
		});
		const made = { wins, hits, chain, byLoop };
		loopCache.set(slotted, made);
		return made;
	};
	const lvars = (g: number) => ({ w: `lw${g}`, va: `lva${g}`, x: `lx${g}`, bd: `lbd${g}` });
	// resolves every window of the loops around block j (all of them when `all`, else the loops j's source is not in)
	// LIFT_MUTATE=noreval keeps the windows in statics across region exits and resolves one only when it is empty, so
	// nothing revalidates it after a syscall, a call or a handler
	const openLoops = (ld: LoopData, ids: number[]) =>
		ids.flatMap((g) => {
			const lines = open(ld.wins[g]!, lvars(g), ld.wins[g]!.ic!, true);
			return mutate === 'noreval' ? [`\tif (!lw${g}) {`, ...lines, '\t}'] : lines;
		});
	const loopIds = (ld: LoopData, j: number) => ld.chain[j]!.flatMap((l) => ld.byLoop.get(l)!);
	// whether an edge from block j into block k enters a loop j is not in, which resolves its windows first
	const entersLoop = (slotted: boolean, j: number, k: number) => {
		if (!opt.loops) return false;
		const ld = loopData(slotted);
		return ld.chain[k]!.some((l) => !ld.chain[j]!.includes(l));
	};
	// #endregion
	// the slots form: sm is a block that keeps its frame's slots in locals (the fast body of a promoted
	// block); every other body of that form only has to enter promoted blocks through their stubs
	// the other regions' blocks a block's emitted bodies go straight into, for bodyOf to emit the calls
	const edges = new Set<bigint>();
	const emit = (b: Block, j: number, mode: 'plain' | 'fast' | 'slow', precise = false, slotted = false) => {
		const fast = mode === 'fast';
		const sm = slotted && fast && !!plan?.promoted[j];
		const loops = opt.loops ? loopData(slotted) : undefined;
		const ld = fast ? loops : undefined;
		const lhits = ld?.hits.get(j);
		const pin = fast ? windowsOf(b, sm, lhits && new Set(lhits.keys())) : { wins: [] as Win[], hits: new Map<number, Hit>(), hard: [] as boolean[] };
		const hitOf = (i: number) => lhits?.get(i) ?? pin.hits.get(i);
		const label = mode === 'slow' ? `S${j}` : `B${j}`;
		const body: string[] = [];
		let ipcNow = 0n;
		let ipc = b.pc;
		let m = 0;
		const grouped = (x: Ins) => !opt.nogroups && !opt.identity && x.c !== 0 && !sm;
		const frame = sm ? plan!.wins[plan!.comp[j]!]! : { lo: 0, hi: 0 };
		const V = new Set<number>(sm ? plan!.need[j] : []);
		const slotLoad = (id: number) => {
			const s = plan!.slots[id]!;
			return `s${id} = 0; memcpy(&s${id}, wf + ${s.off - frame.lo}, ${s.w});`;
		};
		const cnt = (cat: string, k: number, n = 1) => (slotted ? [`\tAOT_COUNT_CAT(${cat}, ${k}, ${n});`] : []);
		// an unknown store may have hit the frame: read again the valid slots it overlaps
		const refresh = (va: string, w: number) => {
			if (!V.size || mutate === 'noguard') return [];
			const hit = `${va} - fl + ${w - 1} < ${frame.hi - frame.lo + w - 1}ull`;
			const each = [...V].map((id) => {
				const s = plan!.slots[id]!;
				const at = s.off - frame.lo;
				return `if (d + ${w} > ${at} && d < ${at + s.w}) { ${slotLoad(id)} AOT_COUNT_CAT(AOT_C_FIX, 1, 1); }`;
			});
			return [`\tif (__builtin_expect(${hit}, 0)) { int64_t d = (int64_t) (${va} - fl); ${each.join(' ')} }`];
		};
		const kill = (ids: number[]) => ids.forEach((id) => V.delete(id));
		const exitD = (i: number) => plan?.sym[j]?.exits.find((e) => e.i === i)?.d ?? null;
		const temps = opt.temps ? [...new Set(b.ins.flatMap((x) => [...registerFields(x), ...rw(x).w]))].filter((r) => isTemp(r) && !cross(r)) : [];
		// the cpu words each moves: ipc, the registers, five flags and df; a reload also reads mapgen
		const state = regList.length + 7;
		const spill = (extra: number[], cat: string) => {
			body.push(`\tcpu->ipc = ${hex(ipcNow)};`);
			body.push(...[...regList, ...extra].map((r) => `\tcpu->r[${r}] = g${r};`));
			body.push('\tcpu->n = f.n; cpu->z = f.z; cpu->c = f.c; cpu->v = f.v; cpu->p = f.p; cpu->df = df;');
			body.push(`\tAOT_COUNT_WRC(${cat}, ${state + extra.length});`);
		};
		const reload = (cat: string) => {
			body.push(...regList.map((r) => `\tg${r} = cpu->r[${r}];`));
			body.push(`\tf.n = cpu->n; f.z = cpu->z; f.c = cpu->c; f.v = cpu->v; f.p = cpu->p; df = cpu->df;${opt.epochs ? '' : ' gen = cpu->mapgen;'}`);
			if (precise) body.push('\tgfs = cpu->fs;');
			body.push(`\tAOT_COUNT_RDC(${cat}, ${state + (precise ? 1 : 0) - (opt.epochs ? 1 : 0)});`);
		};
		// the precise form: a helper's registers and flags only; a register it may write is spilled too, so
		// the reload never reads a stale word, and a fault leaves through out with every local current
		const held = (r: number) => r !== KB_ZERO && (regList.includes(r) || (isTemp(r) && !cross(r)));
		const spillTouch = (t: Touch, cat: string) => {
			const rs = [...new Set([...t.r, ...t.w])].filter(held);
			body.push(`\tcpu->ipc = ${hex(ipcNow)};`);
			body.push(...rs.map((r) => `\tcpu->r[${r}] = g${r};`));
			if (t.flags) body.push('\tcpu->n = f.n; cpu->z = f.z; cpu->c = f.c; cpu->v = f.v; cpu->p = f.p;');
			if (t.df) body.push('\tcpu->df = df;');
			body.push(`\tAOT_COUNT_WRC(${cat}, ${1 + rs.length + (t.flags ? 5 : 0) + (t.df ? 1 : 0)});`);
		};
		const reloadTouch = (t: Touch, cat: string) => {
			const ws = [...new Set(t.w)].filter((r) => regList.includes(r));
			body.push(...ws.map((r) => `\tg${r} = cpu->r[${r}];`));
			if (t.flags) body.push('\tf.n = cpu->n; f.z = cpu->z; f.c = cpu->c; f.v = cpu->v; f.p = cpu->p;');
			if (!opt.epochs) body.push('\tgen = cpu->mapgen;');
			body.push(`\tAOT_COUNT_RDC(${cat}, ${ws.length + (t.flags ? 5 : 0) + (opt.epochs ? 0 : 1)});`);
		};
		// a block's exit: straight into the next lifted block when there is one and no signal waits
		const leave = (from: bigint, to: bigint, i: number) => {
			const k = index.get(to);
			if (k === undefined && calls.has(to)) {
				const c = info[calls.get(to)!]!;
				edges.add(to);
				return `{ if (AOT_CONTINUE(${c.name}_ok[${c.index.get(to)}], ${to <= from ? 1 : 0})) goto K${j}_${to.toString(16)}; pc = ${hex(to)}; goto out; }`;
			}
			if (k === undefined) return `{ pc = ${hex(to)}; goto out; }`;
			const kind = !slotted || !plan ? 'plain' : sm ? plan.edge(j, k, exitD(i)) : plan.promoted[k] ? 'stub' : 'plain';
			const fix = kind === 'carry' ? plan!.need[k]!.filter((s) => !V.has(s)) : [];
			// an edge into a loop from outside it goes through that loop's stub, which resolves its windows
			const L = entersLoop(slotted, j, k) ? 'L' : '';
			const take = fix.length ? `{ ${fix.map(slotLoad).join(' ')} AOT_COUNT_CAT(AOT_C_FIX, 0, ${fix.length}); goto ${L}B${k}; }` : `goto ${L}${kind === 'stub' ? 'E' : 'B'}${k};`;
			return `{ if (AOT_CONTINUE(${R}_ok[${k}], ${to <= from ? 1 : 0})) ${take} pc = ${hex(to)}; goto out; }`;
		};
		const fault = (why?: string, sig?: number) =>
			`{ ${why ? `cpu->fault = "${why}"; cpu->fault_sig = ${sig}; ` : ''}cpu->ipc = ${hex(ipc)}; pc = ${hex(b.pc)}; goto out; }`;

		// an access with an index bound is at its own distance from where its window starts
		const winOf = (h: Hit) => (h.loop ? ld!.wins[h.win]! : pin.wins[h.win]!);
		const nm = (h: Hit) => (h.loop ? 'l' : '');
		// a two-piece window picks the piece by one compare against the boundary; an access that straddles it is checked
		// LIFT_MUTATE=swappieces picks the first piece for the second and the second for the first, which is unsound across a boundary
		const pick = (h: Hit, W: number) => {
			if (!winOf(h).two) return '';
			const [w0, w1] = mutate === 'swappieces' ? ['x', 'w'] : ['w', 'x'];
			return ` uint8_t* wp = AOT_PICK2(va, ${W}, ${nm(h)}va${h.win}, ${nm(h)}${w0}${h.win}, ${nm(h)}${w1}${h.win}, ${nm(h)}bd${h.win});`;
		};
		const have = (h: Hit) => (winOf(h).two ? 'wp != 0' : `${nm(h)}w${h.win} != 0`);
		const hitAt = (h: Hit, B: string, x: Ins) => (winOf(h).two ? 'wp' : `${nm(h)}w${h.win} + ${h.dyn ? `(${B} + ${imm64(x.imm)} - ${nm(h)}va${h.win})` : h.off}`);
		const hitCheck = (h: Hit, B: string, x: Ins) => {
			const w = winOf(h);
			const loop = h.loop ? `AOT_LCHK(&${R}_win[${w.ic}]); ${w.two ? `AOT_LCHK1(&${R}_win[${w.ic! + 1}], ${nm(h)}bd${h.win}); ` : ''}` : '';
			if (!h.dyn) return loop;
			return `${loop}AOT_WINCHK(${B} + ${imm64(x.imm)} - ${nm(h)}va${h.win}, ${Number(w.hi - w.lo) - x.w}u); `;
		};
		const soft = (h: Hit) => !!h.loop || (h.dyn && !pin.hard[h.win]);
		const hitStat = (h: Hit) => ['\tAOT_STAT(win_acc, 1);', ...(h.dyn ? ['\tAOT_STAT(win_idx, 1);'] : [])];
		const revalidate = () => {
			if (!loops || mutate === 'noreval') return [];
			const ids = loopIds(loops, j);
			return ids.length ? [...openLoops(loops, ids), `\tAOT_STAT(win_enter, ${ids.length});`, '\tAOT_STAT(reval, 1);'] : [];
		};
		// the checked copy runs the block the fast body already counted
		body.push(`${label}: {`, `\tstruct kb_ic* ic = ${R}_blk[${j}]->ic;`, '\t(void) ic;', mode === 'slow' ? '\tAOT_STAT(win_slow, 1);' : `\tAOT_COUNT_BLOCK(${R}_blk[${j}]);`);
		if (temps.length) body.push(`\tuint64_t ${temps.map((r) => `g${r}`).join(', ')};`);
		if (pin.wins.length) {
			const key = sm ? -1 - j : j;
			let ics = winBase.get(key);
			if (ics === undefined) {
				ics = pin.wins.map((w) => {
					const at = windowCount;
					windowCount += w.two ? 2 : 1;
					return at;
				});
				winBase.set(key, ics);
			}
			const two = pin.wins.flatMap((w, k) => (w.two ? [k] : []));
			body.push(`\tuint8_t *${pin.wins.flatMap((_, k) => [`w${k}`, ...(two.includes(k) ? [`x${k}`] : [])]).join(', *')};`);
			const indexed = [...new Set([...pin.hits.values()].filter((h) => h.dyn).map((h) => h.win))];
			if (indexed.length) body.push(`\tuint64_t ${[...indexed.map((k) => `va${k}`), ...two.map((k) => `bd${k}`)].join(', ')};`);
			pin.wins.forEach((w, k) => body.push(...open(w, { w: `w${k}`, va: `va${k}`, x: `x${k}`, bd: `bd${k}` }, ics![k]!, indexed.includes(k))));
			const must = pin.wins.map((_, k) => k).filter((k) => pin.hard[k]);
			body.push(`\tAOT_STAT(win_enter, ${pin.wins.length});`);
			if (must.length) body.push(`\tif (!(${must.map((k) => `w${k}`).join(' && ')})) goto S${j};`);
		}
		b.ins.forEach((x, i) => {
			if (b.pcs) ipc = BigInt.asUintN(64, b.pc + BigInt(b.pcs[i]!));
			ipcNow = ipc;
			const [A, B, C, W] = [reg(x.a), reg(x.b), reg(x.c), x.w];
			const D = dst(x.a);
			const name = opName(x.op);
			const memop = name === 'LD' || name === 'LDS' || name === 'ST';
			let after: string[] = [];
			if (sm && memop) {
				const c: Cls | undefined = plan!.cls(j, i);
				const lo = frame.lo;
				const sl = c?.t === 'slot' ? plan!.slots[c.slot]! : undefined;
				const ext = (v: string) => (name === 'LDS' ? `(uint64_t) aot_sext(${v}, ${W})` : v);
				if (name !== 'ST' && sl) {
					if (V.has(sl.id)) body.push(`\t${D} = ${ext(`s${sl.id}`)};`, ...cnt('AOT_C_SLOT', 0), '\tAOT_STAT(win_acc, 1);');
					else {
						body.push(`\t{ uint64_t v = 0; memcpy(&v, wf + ${sl.off - lo}, ${W}); s${sl.id} = v; ${D} = ${ext('v')}; }`, ...cnt('AOT_C_MEM', 0), '\tAOT_STAT(win_acc, 1);');
						V.add(sl.id);
					}
					m++;
					return;
				}
				if (name !== 'ST' && c?.t === 'win') {
					body.push(`\t{ uint64_t v = 0; memcpy(&v, wf + ${c.off - lo}, ${W}); ${D} = ${ext('v')}; }`, ...cnt('AOT_C_MEM', 0), '\tAOT_STAT(win_acc, 1);');
					m++;
					return;
				}
				if (name === 'ST' && sl) {
					const write = mutate === 'nowrite' ? '' : `memcpy(wf + ${sl.off - lo}, &v, ${W}); `;
					body.push(`\t{ uint64_t v = ${A} & aot_mask(${W}); ${write}s${sl.id} = v; }`, ...cnt('AOT_C_SLOT', 1), '\tAOT_STAT(win_acc, 1);');
					kill(plan!.overlapping(plan!.comp[j]!, sl.off, sl.w));
					V.add(sl.id);
					m++;
					return;
				}
				if (name === 'ST' && c?.t === 'win') {
					body.push(`\t{ uint64_t v = ${A}; memcpy(wf + ${c.off - lo}, &v, ${W}); }`, ...cnt('AOT_C_MEM', 1), '\tAOT_STAT(win_acc, 1);');
					kill(plan!.overlapping(plan!.comp[j]!, c.off, W));
					m++;
					return;
				}
				if (name === 'ST' && c) kill(c.t === 'part' ? c.kill : []);
				else if (name === 'ST') after = refresh(`(${B} + ${imm64(x.imm)})`, W);
			}
			if (slotted && memop) after.unshift(...cnt('AOT_C_MEM', name === 'ST' ? 1 : 0));
			switch (name) {
				case 'MOVI': body.push(`\t${D} = ${imm64(x.imm)};`); break;
				case 'MOV': body.push(`\t${D} = ${B};`); break;
				case 'ADD': body.push(`\t${D} = ${B} + ${C};`); break;
				case 'SUB': body.push(`\t${D} = ${B} - ${C};`); break;
				case 'AND': body.push(`\t${D} = ${B} & ${C};`); break;
				case 'OR': body.push(`\t${D} = ${B} | ${C};`); break;
				case 'XOR': body.push(`\t${D} = ${B} ^ ${C};`); break;
				case 'SHL': body.push(`\t${D} = ${C} >= 64 ? 0 : ${B} << ${C};`); break;
				case 'SHR': body.push(`\t${D} = ${C} >= 64 ? 0 : ${B} >> ${C};`); break;
				case 'SAR': body.push(`\t${D} = (uint64_t) ((int64_t) ${B} >> (${C} >= 64 ? 63 : ${C}));`); break;
				case 'ROR':
					body.push(`\t{ uint64_t v = ${B} & aot_mask(${W}), n = ${C} % ${8 * W}u; ${D} = n ? ((v >> n) | (v << (${8 * W} - n))) & aot_mask(${W}) : v; }`);
					break;
				case 'MUL': body.push(`\t${D} = ${B} * ${C};`); break;
				case 'UMULH': body.push(`\t${D} = kb_umulh(${B}, ${C});`); break;
				case 'SMULH': body.push(`\t${D} = kb_smulh(${B}, ${C});`); break;
				case 'UDIV': body.push(`\t${D} = ${C} ? ${B} / ${C} : 0;`); break;
				case 'SDIV':
					body.push(`\t${D} = ${C} ? ((int64_t) ${B} == INT64_MIN && (int64_t) ${C} == -1 ? ${B} : (uint64_t) ((int64_t) ${B} / (int64_t) ${C})) : 0;`);
					break;
				case 'UREM': body.push(`\t${D} = ${C} ? ${B} % ${C} : ${B};`); break;
				case 'SREM': body.push(`\t${D} = ${C} ? ((int64_t) ${C} == -1 ? 0 : (uint64_t) ((int64_t) ${B} % (int64_t) ${C})) : ${B};`); break;
				case 'ZEXT': body.push(`\t${D} = ${B} & aot_mask(${W});`); break;
				case 'SEXT': body.push(`\t${D} = (uint64_t) aot_sext(${B}, ${W});`); break;
				case 'INS':
					body.push(`\t{ uint64_t m = aot_mask(${W}) << ${x.imm}; ${D} = (${A} & ~m) | ((${B} << ${x.imm}) & m); }`);
					break;
				case 'LD':
				case 'LDS': {
					const v = name === 'LDS' ? `(uint64_t) aot_sext(v, ${W})` : 'v';
					if (opt.identity) {
						body.push(`\t{ uint64_t v = 0; memcpy(&v, AOT_HOST(${B} + ${imm64(x.imm)}), ${W}); ${D} = ${v}; }`);
						m++;
						break;
					}
					const hit = hitOf(i);
					if (hit && soft(hit)) {
						body.push(
							`\t{ uint64_t va = ${B} + ${imm64(x.imm)}, v = 0; struct kb_ic* q = &ic[${m}];${pick(hit, W)}`,
							`\t  if (__builtin_expect(${have(hit)}, 1)) { ${hitCheck(hit, B, x)}memcpy(&v, ${hitAt(hit, B, x)}, ${W}); ${D} = ${v}; ${hitStat(hit).join(' ').replace(/\t/g, '')} } else {`,
							'\t  AOT_STAT(chk_acc, 1);',
							`\t  int slow = __builtin_expect(AOT_SLOW(q, gen, va, ${W}), 0);`,
							`\t  if (slow) v = kb_load_ic(cpu, q, va, ${W}); else memcpy(&v, q->host + (va - q->lo), ${W});`,
							`\t  ${D} = ${v};`,
							`\t  if (slow && cpu->fault) ${fault()} } }`
						);
						m++;
						break;
					}
					if (hit) {
						body.push(`\t{ uint64_t v = 0; ${hitCheck(hit, B, x)}memcpy(&v, ${hitAt(hit, B, x)}, ${W}); ${D} = ${v}; }`, ...hitStat(hit));
						m++;
						break;
					}
					// a grouped access reads through its group's resolved bytes when the span resolved
					const g = x.c - 1;
					const gr = grouped(x);
					// the interpreter writes a faulting load's destination before it checks, and so does this
					body.push(
						`\t{ uint64_t va = ${B} + ${imm64(x.imm)}, v = 0; struct kb_ic* q = &ic[${m}];`,
						...(gr ? [`\t  if (gh[${g}]) { AOT_STAT(grp_acc, 1); memcpy(&v, gh[${g}] + (va - gva[${g}]), ${W}); ${D} = ${v}; } else {`] : []),
							'\t  AOT_STAT(chk_acc, 1);',
						`\t  int slow = __builtin_expect(AOT_SLOW(q, gen, va, ${W}), 0);`,
						`\t  if (slow) v = kb_load_ic(cpu, q, va, ${W}); else memcpy(&v, q->host + (va - q->lo), ${W});`,
						`\t  ${D} = ${v};`,
						`\t  if (slow && cpu->fault) ${fault()} ${gr ? '} ' : ''}}`
					);
					m++;
					break;
				}
				case 'ST': {
					if (opt.identity) {
						body.push(`\t{ uint64_t v = ${A}; memcpy(AOT_HOST(${B} + ${imm64(x.imm)}), &v, ${W}); }`);
						m++;
						break;
					}
					const hit = hitOf(i);
					if (hit && soft(hit)) {
						body.push(
							`\t{ uint64_t va = ${B} + ${imm64(x.imm)}, v = ${A}; struct kb_ic* q = &ic[${m}];${pick(hit, W)}`,
							`\t  if (__builtin_expect(${have(hit)}, 1)) { ${hitCheck(hit, B, x)}memcpy(${hitAt(hit, B, x)}, &v, ${W}); ${hitStat(hit).join(' ').replace(/\t/g, '')} } else {`,
							'\t  AOT_STAT(chk_acc, 1);',
							`\t  if (__builtin_expect(AOT_SLOW(q, gen, va, ${W}), 0)) { kb_store_ic(cpu, q, va, v, ${W}); if (cpu->fault) ${fault()} }`,
							`\t  else memcpy(q->host + (va - q->lo), &v, ${W}); } }`
						);
						m++;
						break;
					}
					if (hit) {
						body.push(`\t{ uint64_t v = ${A}; ${hitCheck(hit, B, x)}memcpy(${hitAt(hit, B, x)}, &v, ${W}); }`, ...hitStat(hit));
						m++;
						break;
					}
					const g = x.c - 1;
					const gr = grouped(x);
					body.push(
						`\t{ uint64_t va = ${B} + ${imm64(x.imm)}, v = ${A}; struct kb_ic* q = &ic[${m}];`,
						...(gr ? [`\t  if (gh[${g}]) { AOT_STAT(grp_acc, 1); memcpy(gh[${g}] + (va - gva[${g}]), &v, ${W}); } else {`] : []),
							'\t  AOT_STAT(chk_acc, 1);',
						`\t  if (__builtin_expect(AOT_SLOW(q, gen, va, ${W}), 0)) { kb_store_ic(cpu, q, va, v, ${W}); if (cpu->fault) ${fault()} }`,
						`\t  else memcpy(q->host + (va - q->lo), &v, ${W}); ${gr ? '} ' : ''}}`
					);
					m++;
					break;
				}
				case 'RESOLVE':
					// the whole span, range included: AOT_NO_RANGE_CHECK trusts accesses, never a span
					if (!opt.nogroups && !opt.identity && !fast)
						body.push(
							`\t{ uint64_t va = ${B} + ${imm64(x.imm)}; struct kb_ic* q = &ic[${m}]; gva[${x.a}] = va;`,
							`\t  gh[${x.a}] = ${G}${16 * W}u <= q->span && va - q->lo <= q->span - ${16 * W}u ? q->host + (va - q->lo) : kb_host_ic(cpu, q, va, ${16 * W}u); }`
						);
					m++;
					break;
				case 'FLAGS':
					if (!dead.has(`${j}:${i}`)) body.push(`\taot_flags(&f, ${x.imm}, ${B}, ${C}, ${A}, ${W});`);
					break;
				case 'SETCC': body.push(`\t${D} = (uint64_t) aot_cond(&f, ${x.imm});`); break;
				case 'SEL': body.push(`\t${D} = aot_cond(&f, ${x.imm}) ? ${B} : ${C};`); break;
				case 'BR': body.push(`\tif (aot_cond(&f, ${x.imm})) ${leave(b.pc, b.target, i)}`); break;
				case 'BRZ': body.push(`\tif ((${A} != 0) == ${x.imm !== 0n ? 1 : 0}) ${leave(b.pc, b.target, i)}`); break;
				case 'EXIT': {
					const to = BigInt.asUintN(64, b.pc + BigInt.asIntN(32, x.imm >> 16n));
					const cond = x.imm & 0x100n ? `(${A} == 0) == ${x.imm & 1n ? 0 : 1}` : `aot_cond(&f, ${x.imm & 0xffn})`;
					body.push(`\tif (${cond}) ${leave(b.pc, to, i)}`);
					break;
				}
				case 'JMP': {
					// a jump to a constant is an edge like a branch's (the slots form follows it without the switch)
					const k = constJump(b);
					const to = k !== undefined && calls.has(k) ? k : slotted ? plan?.sym[j]?.exits.find((e) => e.i === i)?.to : undefined;
					if (to !== undefined && to !== null) body.push(`\t${leave(b.pc, to, i)}`);
					else body.push(`\tpc = ${B}; if (AOT_CONTINUE(1, pc <= ${hex(b.pc)})) goto dispatch; goto out;`);
					break;
				}
				case 'PC': ipc = x.imm; break;
				case 'CARRY': body.push(`\t${D} = (uint64_t) f.c;`); break;
				case 'BSWAP': body.push(`\t${D} = __builtin_bswap64(${B}) >> ${64 - 8 * W};`); break;
				case 'CLZ':
					body.push(`\t{ uint64_t v = ${B} & aot_mask(${W}); ${D} = v ? (uint64_t) (__builtin_clzll(v) - ${64 - 8 * W}) : ${8 * W}u; }`);
					break;
				case 'CTZ': body.push(`\t{ uint64_t v = ${B} & aot_mask(${W}); ${D} = v ? (uint64_t) __builtin_ctzll(v) : ${8 * W}u; }`); break;
				case 'POPCNT': body.push(`\t${D} = (uint64_t) __builtin_popcountll(${B} & aot_mask(${W}));`); break;
				case 'FSBASE':
					if (precise) body.push(`\t${D} = gfs;`);
					else body.push(`\t${D} = cpu->fs;`, '\tAOT_COUNT_RDC(AOT_C_FS, 1);');
					break;
				case 'X86MD': body.push(`\tif (aot_muldiv(&g0, &g2, &f, ${x.imm}, ${W}, ${B})) ${fault('divide error', 8)}`); break;
				case 'X86SHD':
					body.push(
						`\t{ uint64_t m = aot_mask(${W}), v = ${A} & m, in = ${B} & m, n = ${C}, o, cf;`,
						`\t  if (n) { ${x.imm === 0n ? `o = n == ${8 * W} ? in : ((v << n) | (in >> (${8 * W} - n))) & m; cf = (v >> (${8 * W} - n)) & 1;` : `o = ((v >> n) | (in << (${8 * W} - n))) & m; cf = (v >> (n - 1)) & 1;`}`,
						`\t    ${D} = o; aot_flags(&f, KB_F_LOGIC, o, o, o, ${W}); f.c = (int) cf; } }`
					);
					break;
				case 'X86FLAGS':
					if (x.imm === 0n)
						body.push(`\t${D} = 0x202 | (uint64_t) f.c | ((uint64_t) f.p << 2) | ((uint64_t) f.z << 6) | ((uint64_t) f.n << 7) | ((uint64_t) df << 10) | ((uint64_t) f.v << 11);`);
					else if (x.imm === 1n)
						body.push(`\t{ uint64_t v = ${A}; f.c = (int) (v & 1); f.p = (int) ((v >> 2) & 1); f.z = (int) ((v >> 6) & 1); f.n = (int) ((v >> 7) & 1); f.v = (int) ((v >> 11) & 1); df = (int) ((v >> 10) & 1); }`);
					else body.push(`\t${['f.c = !f.c;', 'f.c = 0;', 'f.c = 1;', 'df = 0;'][Number(x.imm) - 2] ?? 'df = 1;'}`);
					break;
				case 'SSE':
				case 'X87': {
					const call = name === 'SSE' ? 'kb_sse' : 'kb_x87';
					const cat = name === 'SSE' ? 'AOT_C_SSE' : 'AOT_C_X87';
					const run = `\tif (${call}(cpu, &${R}_blk[${j}]->ins[${i}]) && !cpu->fault) { cpu->fault = "unknown ${name.toLowerCase()} instruction"; cpu->fault_sig = 4; }`;
					if (precise) {
						const t = touches(x);
						spillTouch(t, cat);
						body.push(run);
						reloadTouch(t, cat);
						body.push(`\tif (cpu->fault) { cpu->ipc = ${hex(ipc)}; pc = ${hex(b.pc)}; goto out; }`);
						// a memory operand may be written (xmm or x87 stores, fxsave): kill the slots it names, or check an unknown address
						const wide = vecWrite(name, x);
						if (sm && wide) {
							const c = plan!.cls(j, i);
							if (c) kill(c.t === 'vec' ? c.kill : []);
							else after = refresh(B, wide);
						}
						break;
					}
					// a helper reads its address from the cpu; a temporary base is spilled for it alone
					spill(isTemp(x.b) && !cross(x.b) ? [x.b] : [], cat);
					body.push(run, `\tif (cpu->fault) { cpu->ipc = ${hex(ipc)}; return ${hex(b.pc)}; }`);
					reload(cat);
					break;
				}
				case 'X86STR':
					if (precise) {
						const t = touches(x);
						const known = sm && V.size && !x.c && regList.includes(7);
						if (known) body.push(`\tuint64_t sva${i} = g7;`);
						spillTouch(t, 'AOT_C_STR');
						body.push(`\tkb_aot_string(cpu, ${x.imm}, ${W}, ${x.c});`);
						reloadTouch(t, 'AOT_C_STR');
						body.push(`\tif (cpu->fault) { cpu->ipc = ${hex(ipc)}; pc = ${hex(b.pc)}; goto out; }`);
						// rep movs and stos write a range: read every slot again; a single one is checked by its address
						if (known) after = refresh(`sva${i}`, W);
						else if (sm && V.size && mutate !== 'noguard') after = [`\t{ ${[...V].map(slotLoad).join(' ')} AOT_COUNT_CAT(AOT_C_FIX, 1, ${V.size}); }`];
						break;
					}
					spill([], 'AOT_C_STR');
					body.push(`\tkb_aot_string(cpu, ${x.imm}, ${W}, ${x.c});`, `\tif (cpu->fault) { cpu->ipc = ${hex(ipc)}; return ${hex(b.pc)}; }`);
					reload('AOT_C_STR');
					break;
				case 'SYSCALL':
					// a syscall that ends the block leaves the region; one in the middle would have to check the epoch
					if (opt.epochs && i !== b.ins.length - 1) throw new Error(`--epochs: syscall inside block ${b.pc.toString(16)}`);
					spill([], 'AOT_C_SYS');
					body.push(
						`\tcpu->pc = ${hex(b.next)};`,
						'\tAOT_COUNT_RDC(AOT_C_SYS, 2); AOT_COUNT_WRC(AOT_C_SYS, 1);',
						'\tkb_syscall(cpu);',
						'\tif (cpu->exited) return 0;',
						'\tif (cpu->sigreturned) { cpu->sigreturned = 0; return cpu->pc; }',
						`\tif (cpu->fault) { cpu->ipc = ${hex(ipc)}; return ${hex(b.pc)}; }`
					);
					if (i === b.ins.length - 1) body.push(`\treturn ${hex(b.next)};`);
					else {
						reload('AOT_C_SYS');
						body.push(...revalidate());
					}
					break;
				default:
					throw new Error(`no lifting for ${name}`);
			}
			body.push(...after);
		});
		const lastOp = opName(b.ins.at(-1)!.op);
		if (lastOp !== 'JMP' && !(lastOp === 'SYSCALL')) body.push(`\t${leave(b.pc, b.next, -1)}`);
		body.push('}');
		return body;
	};

	const twins = new Set<number>();
	// a promoted block's entry from outside its frame: find the frame window, then load what the block needs
	const stub = (j: number) => {
		const c = plan!.comp[j]!;
		const { lo, hi } = plan!.wins[c]!;
		const len = hi - lo;
		const loads = plan!.need[j]!.map((id) => {
			const s = plan!.slots[id]!;
			return `\ts${id} = 0; memcpy(&s${id}, wf + ${s.off - lo}, ${s.w});`;
		});
		return [
			`E${j}: {`,
			`\tfb = g${SP} - ${imm64(BigInt(plan!.at[j]!))};`,
			`\tfl = fb + ${imm64(BigInt(lo))};`,
			opt.identity
				? '\twf = AOT_HOST(fl);'
				: `\t{ struct kb_ic* q = &${R}_fw[${c}]; wf = ${G}${len}u <= q->span && fl - q->lo <= q->span - ${len}u ? q->host + (fl - q->lo) : kb_host_ic(cpu, q, fl, ${len}u); }`,
			`\tif (!wf) goto S${j};`,
			...loads,
			`\tAOT_COUNT_CAT(AOT_C_FIX, 0, ${loads.length});`,
			'\tAOT_STAT(win_enter, 1);',
			`\tgoto B${j};`,
			'}'
		];
	};
	// a direct call: the callee's body runs inline on the caller's locals, handed in through its io struct and back
	// after, so no register or flag goes through the cpu. The callee leaves through its out with the pc it stopped at:
	// a pc that is one of this region's blocks continues there (a pushed return address first), any other pc (a signal,
	// a fault, a jump elsewhere) leaves through this region's out
	const callSite = (b: Block, j: number, to: bigint, precise: boolean, slotted: boolean) => {
		const C = info[calls.get(to)!]!;
		const form = only !== undefined ? '' : slotted ? (C.slotted ? 's' : 'p') : precise ? 'p' : '';
		// the return addresses the block pushed (constants that are a block of this region), checked before the switch
		const pushed = [...new Set(b.ins.filter((x) => opName(x.op) === 'MOVI').map((x) => BigInt.asUintN(64, x.imm)))].filter((v) => index.has(v));
		// the callee may have written any frame slot through a pointer, so a promoted return site is entered through its stub
		const resume = pushed.map((v) => {
			const k = index.get(v)!;
			// back from the callee the loop's windows are resolved again
			const back = opt.loops && mutate !== 'noreval' && loopIds(loopData(slotted), k).length ? 'L' : '';
			return `\tif (pc == ${hex(v)} && AOT_CONTINUE(${R}_ok[${k}], ${v <= b.pc ? 1 : 0})) goto ${back}${slotted && plan!.promoted[k] ? 'E' : 'B'}${k};`;
		});
		return [
			`K${j}_${to.toString(16)}: {`,
			`\tstruct ${C.name}_io io = {${C.regList.map((r) => `.g${r} = g${r}`).join(', ')}, .n = f.n, .z = f.z, .c = f.c, .v = f.v, .p = f.p, .df = df, ${opt.epochs ? '.ep = ep' : '.gen = gen'}${precise ? ', .gfs = gfs' : ''}};`,
			'\tAOT_COUNT_CAT(AOT_C_CALL, 0, 1);',
			`\tpc = ${C.name}${form}_go(cpu, ${hex(to)}, &io);`,
			...(mutate === 'noreturn' ? [] : C.regList.map((r) => `\tg${r} = io.g${r};`)),
			`\tf.n = io.n; f.z = io.z; f.c = io.c; f.v = io.v; f.p = io.p; df = io.df;${opt.epochs ? '' : ' gen = io.gen;'}`,
			...(precise ? ['\tgfs = io.gfs;'] : []),
			...resume,
			'\tif (AOT_CONTINUE(1, 1)) goto dispatch;',
			'\tgoto out;',
			'}'
		];
	};
	const bodyOf = (precise: boolean, slotted = false) => {
		const body: string[] = [];
		chosen.forEach((b, j) => {
			edges.clear();
			const ld = opt.loops ? loopData(slotted) : undefined;
			const lhits = ld?.hits.get(j);
			if (ld && ld.chain[j]!.length) {
				const ids = loopIds(ld, j);
				const enter = (label: string) => [`L${label}${j}: {`, ...openLoops(ld, ids), `\tAOT_STAT(win_enter, ${ids.length});`, `\tgoto ${label}${j};`, '}'];
				body.push(...enter('B'), ...(slotted && plan!.promoted[j] ? enter('E') : []));
			}
			const own = windowsOf(b, false, lhits && new Set(lhits.keys()));
			if (slotted && plan!.promoted[j]) body.push(...stub(j), ...emit(b, j, 'fast', precise, true), ...emit(b, j, 'slow', precise, true));
			else if (opt.windows && (own.wins.length || lhits?.size)) {
				// a block whose windows all fall back access by access has no checked copy to leave to
				if (own.hard.some(Boolean)) {
					twins.add(j);
					body.push(...emit(b, j, 'fast', precise, slotted), ...emit(b, j, 'slow', precise, slotted));
				} else body.push(...emit(b, j, 'fast', precise, slotted));
			} else body.push(...emit(b, j, 'plain', precise, slotted));
			for (const to of edges) body.push(...callSite(b, j, to, precise, slotted));
		});
		return body;
	};
	chosen.forEach((b) => (irIns += b.ins.length));
	// the forms emitted: all the flags allow, or the one --only names (form 2 with no slot plan is form 1)
	const forms = only === undefined ? [0, ...(opt.regs ? [1] : []), ...(plan ? [2] : [])] : [only === 2 && !plan ? 1 : only];
	const body = forms.includes(0) ? bodyOf(false) : [];
	const bodyP = forms.includes(1) ? bodyOf(true) : [];
	const bodyS = forms.includes(2) ? bodyOf(true, true) : [];

	chosen.forEach((b, j) => {
		lines.push(`static const struct kb_ins ${R}_i${j}[] = {`);
		for (const x of b.ins) lines.push(`\t{${x.op}, ${x.w}, ${x.a}, ${x.b}, ${x.c}, (int64_t) ${hex(x.imm)}},`);
		lines.push('};');
		table.push({ pc: b.pc, next: b.next, target: b.target, n: b.ins.length, region, idx: j, name: `${R}_i${j}` });
	});
	lines.push(`static unsigned char ${R}_ok[${chosen.length}];`, `static struct kb_block* ${R}_blk[${chosen.length}];`);
	if (opt.windows) lines.push(`static struct kb_ic ${R}_win[${Math.max(1, windowCount)}];`);
	if (plan) lines.push(`static struct kb_ic ${R}_fw[${plan.wins.length}];`);
	if (opt.epochs) {
		// zeroed windows hold no span, so they miss; a block's caches go back to the interpreter's cold value
		lines.push(`static uint32_t ${R}_ep, ${R}_mg;`, `static void ${R}_cold(void) {`);
		if (opt.windows) lines.push(`\tmemset(${R}_win, 0, sizeof ${R}_win);`);
		if (plan) lines.push(`\tmemset(${R}_fw, 0, sizeof ${R}_fw);`);
		lines.push(
			`\tfor (int j = 0; j < ${chosen.length}; j++)`,
			`\t\tfor (int i = 0; ${R}_blk[j] && i < ${R}_blk[j]->nic; i++) ${R}_blk[j]->ic[i] = (struct kb_ic) {0, AOT_COLD, NULL, 0};`,
			'}'
		);
	}
	lines.push('');

	const inner = called.has(region);
	if (inner)
		lines.push(`struct ${R}_io {`, ...regList.map((r) => `\tuint64_t g${r};`), '\tint n, z, c, v, p, df;', opt.epochs ? '\tuint32_t ep;' : '\tuint32_t gen;', '\tuint64_t gfs;', '};', '');
	const fn = (precise: boolean, text: string[], slotted = false) => {
		const tag = only !== undefined ? '' : slotted ? 's' : precise ? 'p' : '';
		// a region that is called directly has a `go` that takes its state from the io struct (or the cpu, when the
		// interpreter enters it) and leaves it there; the aot_run entry wraps it
		lines.push(
			inner
				? `static ${opt.noinline ? '__attribute__((noinline))' : 'inline __attribute__((always_inline))'} uint64_t ${R}${tag}_go(struct kb_cpu* cpu, uint64_t pc, struct ${R}_io* io) {`
				: `static uint64_t ${R}${tag}_run(struct kb_cpu* cpu, uint64_t pc) {`
		);
		const from = (io: string, c: string) => (inner ? `io ? ${io} : ${c}` : c);
		lines.push(...regList.map((r) => `\tuint64_t g${r} = ${from(`io->g${r}`, `cpu->r[${r}]`)};`));
		lines.push(
			'\tuint64_t sink = 0;',
			inner ? '\tstruct aot_fl f = io ? (struct aot_fl) {io->n, io->z, io->c, io->v, io->p} : (struct aot_fl) {cpu->n, cpu->z, cpu->c, cpu->v, cpu->p};' : '\tstruct aot_fl f = {cpu->n, cpu->z, cpu->c, cpu->v, cpu->p};',
			'\tuint8_t* gh[8];',
			'\tuint64_t gva[8];',
			'\t(void) gh;',
			'\t(void) gva;',
			`\tint df = ${from('io->df', 'cpu->df')};`,
			...(opt.epochs ? [`\tuint32_t ep = ${from('io->ep', 'kb_epoch')};`] : [`\tuint32_t gen = ${from('io->gen', 'cpu->mapgen')};`, '\tint fuel = KB_POLL_FUEL;']),
			'\t(void) sink;',
			...(opt.epochs ? [] : ['\t(void) fuel;'])
		);
		if (opt.loops)
			loopData(!!slotted).wins.forEach((w, g) =>
				lines.push(
					`\t${mutate === 'noreval' ? 'static ' : ''}uint8_t *lw${g} = 0${w.two ? `, *lx${g} = 0` : ''};`,
					`\t${mutate === 'noreval' ? 'static ' : ''}uint64_t lva${g} = 0${w.two ? `, lbd${g} = 0` : ''};`,
					`\t(void) lw${g};`,
					`\t(void) lva${g};`
				)
			);
		// the region's caches are checked against the mapping generation when kb_epoch has moved since the last entry
		if (opt.epochs) lines.push('\tAOT_STAT(ep_in, 1);', `\tif (__builtin_expect(${R}_ep != ep, 0)) { AOT_STAT(ep_slow, 1); if (${R}_mg != cpu->mapgen) { ${R}_cold(); ${R}_mg = cpu->mapgen; } ${R}_ep = ep; }`);
		if (precise) lines.push(`\tuint64_t gfs = ${from('io->gfs', 'cpu->fs')};`, '\t(void) gfs;');
		if (slotted) {
			lines.push('\tuint64_t fb = 0, fl = 0;', '\tuint8_t* wf = NULL;', '\t(void) fb;', '\t(void) fl;', '\t(void) wf;');
			for (const s of plan!.slots) lines.push(`\tuint64_t s${s.id} = 0;`, `\t(void) s${s.id};`);
		}
		const entry = `AOT_COUNT_RDC(AOT_C_REGION, ${regList.length + 7 + (precise ? 1 : 0) - (opt.epochs ? 1 : 0)});`;
		lines.push(inner ? `\tif (!io) ${entry}` : `\t${entry}`, '\tgoto dispatch;', 'dispatch:', '\tswitch (pc) {');
		const into = (j: number) => (opt.loops && loopData(!!slotted).chain[j]!.length ? 'L' : '');
		chosen.forEach((b, j) => lines.push(`\t\tcase ${hex(b.pc)}: if (${R}_ok[${j}]) goto ${into(j)}${slotted && plan!.promoted[j] ? 'E' : 'B'}${j}; goto out;`));
		lines.push('\t\tdefault: goto out;', '\t}');
		for (const t of text) lines.push(t);
		const cpuOut = [
			`AOT_COUNT_WRC(AOT_C_REGION, ${regList.length + 6});`,
			'AOT_COUNT_EXIT(pc);',
			...regList.map((r) => `cpu->r[${r}] = g${r};`),
			'cpu->n = f.n; cpu->z = f.z; cpu->c = f.c; cpu->v = f.v; cpu->p = f.p; cpu->df = df;'
		];
		lines.push('out:');
		if (inner)
			lines.push(
				'\tif (io) {',
				...regList.map((r) => `\t\tio->g${r} = g${r};`),
				'\t\tio->n = f.n; io->z = f.z; io->c = f.c; io->v = f.v; io->p = f.p; io->df = df;' + (opt.epochs ? '' : ' io->gen = gen;'),
				...(precise ? ['\t\tio->gfs = gfs;'] : []),
				'\t} else {',
				...cpuOut.map((l) => `\t\t${l}`),
				'\t}'
			);
		else lines.push(...cpuOut.map((l) => `\t${l}`));
		lines.push('\treturn pc;', '}');
		if (inner) lines.push(`static uint64_t ${R}${tag}_run(struct kb_cpu* cpu, uint64_t pc) {`, `\treturn ${R}${tag}_go(cpu, pc, NULL);`, '}');
		lines.push('');
	};
	if (forms.includes(0)) fn(false, body);
	if (forms.includes(1)) fn(true, bodyP);
	regionSlotted[region] = !!plan;
	if (forms.includes(2)) fn(true, bodyS, true);
	info[region] = { name: R, regList, index, slotted: !!plan };
	const memOps = chosen.reduce((n, b) => n + b.ins.filter((x) => ['LD', 'LDS', 'ST'].includes(opName(x.op))).length, 0);
	const hitsOf = opt.windows ? chosen.map((b) => [...windowsOf(b).hits.values()]) : [];
	const windowed = hitsOf.reduce((n, h) => n + h.length, 0);
	const indexed = hitsOf.reduce((n, h) => n + h.filter((x) => x.dyn).length, 0);
	console.error(`${R}: ${memOps} loads and stores, ${windowed} in windows resolved once per block entry${indexed ? ` (${indexed} with an index bound)` : ''}, ${memOps - windowed} checked at each access`);
	if (opt.loops)
		for (const s of new Set(forms.map((f) => f === 2))) {
			const ld = loopData(s);
			const through = [...ld.hits.values()].reduce((n, h) => n + h.size, 0);
			const two = ld.wins.filter((w) => w.two).length;
			console.error(`${R}: ${nest.loops.length} loops, ${ld.byLoop.size} with windows, ${ld.wins.length} loop windows${two ? ` (${two} of two pieces)` : ''}, ${through} loads and stores through them${s ? ' (slots form)' : ''}`);
		}
	console.error(`${R}: ${regList.length} region registers, ${twins.size} blocks with windows, ${windowCount} windows so far`);
});

table.sort((a, b) => (a.pc < b.pc ? -1 : a.pc > b.pc ? 1 : 0));
lines.push(
	'static const struct aot_entry aot_table[] = {',
	...table.map((e) => `\t{${hex(e.pc)}, ${hex(e.next)}, ${hex(e.target)}, ${e.n}, ${e.region}, ${e.idx}, ${e.name}},`),
	'};',
	`static unsigned char* const aot_ok[] = {${regionNames.map((n) => n.replace('_run', '_ok')).join(', ')}};`,
	`static struct kb_block** const aot_blk[] = {${regionNames.map((n) => n.replace('_run', '_blk')).join(', ')}};`,
	`static const int aot_n[] = {${regionSizes.join(', ')}};`,
	`static uint64_t (*const aot_run[])(struct kb_cpu*, uint64_t) = {${regionNames.join(', ')}};`,
	...(opt.regs && only === undefined ? [`static uint64_t (*const aot_runp[])(struct kb_cpu*, uint64_t) = {${regionNames.map((n) => n.replace('_run', 'p_run')).join(', ')}};`] : []),
	...(opt.slots && only === undefined ? [`static uint64_t (*const aot_runs[])(struct kb_cpu*, uint64_t) = {${regionNames.map((n, k) => n.replace('_run', regionSlotted[k] ? 's_run' : 'p_run')).join(', ')}};`] : []),
	'',
	'void kb_aot_detach(struct kb_block* b) {',
	`\tfor (int r = 0; r < ${regionNames.length}; r++)`,
	'\t\tfor (int i = 0; i < aot_n[r]; i++)',
	'\t\t\tif (aot_blk[r][i] == b) {',
	'\t\t\t\taot_ok[r][i] = 0;',
	'\t\t\t\taot_blk[r][i] = NULL;',
	'\t\t\t}',
	'}',
	'',
	'void kb_aot_attach(struct kb_cpu* cpu, struct kb_block* b) {',
	'\t(void) cpu;',
	`\tint lo = 0, hi = ${table.length};`,
	'\twhile (lo < hi) {',
	'\t\tint mid = (lo + hi) / 2;',
	'\t\tif (aot_table[mid].pc < b->pc) lo = mid + 1; else hi = mid;',
	'\t}',
	`\tfor (int k = lo; k < ${table.length} && aot_table[k].pc == b->pc; k++) {`,
	'\t\tconst struct aot_entry* e = &aot_table[k];',
	'\t\tif (e->next != b->next || e->target != b->target || e->n != b->n) continue;',
	'\t\tint same = 1;',
	'\t\tfor (int i = 0; same && i < e->n; i++) {',
	'\t\t\tconst struct kb_ins *x = &e->ins[i], *y = &b->ins[i];',
	'\t\t\tsame = x->op == y->op && x->w == y->w && x->a == y->a && x->b == y->b && x->c == y->c && x->imm == y->imm;',
	'\t\t}',
	'\t\tif (!same) continue;',
	'\t\taot_ok[e->region][e->idx] = 1;',
	'\t\taot_blk[e->region][e->idx] = b;',
	only !== undefined
		? '\t\tb->aot = aot_run[e->region];'
		: opt.slots
		? '\t\tb->aot = aot_regs() == 2 ? aot_runs[e->region] : aot_regs() ? aot_runp[e->region] : aot_run[e->region];'
		: opt.regs
			? '\t\tb->aot = aot_regs() ? aot_runp[e->region] : aot_run[e->region];'
			: '\t\tb->aot = aot_run[e->region];',
	'\t\treturn;',
	'\t}',
	'}'
);
writeFileSync(out, `${lines.join('\n')}\n`);
console.error(`wrote ${out}: ${table.length} blocks in ${regionNames.length} regions, ${irIns} IR ops (${irIns * 16} bytes), ${windowCount} windows`);
