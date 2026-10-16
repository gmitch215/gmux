import { readFileSync } from 'node:fs';
import { follow } from './bounds.ts';

/**
 * What lift.ts (C) and emit.ts (wasm) both read from a hot-block dump: the IR's ops, the blocks of a region and their
 * edges, which registers a region holds, the flag tables and their liveness, the memory window plan and the loops.
 */
export const root = new URL('../../../', import.meta.url).pathname;

// the IR's op numbers, in kb.h's order
const header = readFileSync(`${root}src/gmux/katybug/kb.h`, 'utf8');
const opBody = header.match(/enum kb_op\s*\{([\s\S]*?)\};/)![1]!.replace(/\/\*[\s\S]*?\*\//g, '');
export const OPS = opBody
	.split(',')
	.map((s) => s.trim())
	.filter(Boolean);
export const op = Object.fromEntries(OPS.map((name, i) => [name.replace(/^KB_/, ''), i])) as Record<string, number>;
export const opName = (o: number) => OPS[o]!.replace(/^KB_/, '');
export const KB_ZERO = 63;
export const KB_T0 = 32;
export const SP = 4; // rsp
export const SPAN = 16 * 255; // the memory plan's window (run.c plan_mem)
export const MAX_WINDOWS = 8;
export const MAX_SLOTS = 12;

export interface Ins {
	op: number;
	w: number;
	a: number;
	b: number;
	c: number;
	imm: bigint;
}
export interface Block {
	pc: bigint;
	next: bigint;
	target: bigint;
	runs: bigint;
	ins: Ins[];
	pcs?: number[];
}

export function parse(path: string): Block[] {
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

export type Ranges = [bigint, bigint][];
export function parseRanges(text: string) {
	return text.split(',').map((r) => {
		const [lo, hi, ...rest] = r.split('-');
		if (!lo || !hi || rest.length) throw new Error(`empty or malformed code range "${r}" in "${text}" (<lo>-<hi>,...); an empty range is not the whole program`);
		return [BigInt(lo), BigInt(hi)] as [bigint, bigint];
	});
}
export const inRanges = (ranges: Ranges, pc: bigint) => ranges.some(([lo, hi]) => pc >= lo && pc < hi);

// ops a region cannot run: AArch64-only state and traps stay with the interpreter
export const unliftable = new Set(['TRAP', 'WTRAP', 'WEXIT', 'CCMP', 'TPIDR', 'SETTP', 'CLOCK', 'CPUID', 'EXCL', 'PRIM', 'A64V'].map((n) => op[n]!));
export const liftable = (b: Block) => b.ins.every((x) => !unliftable.has(x.op));

// the blocks of a dump a region takes: those that start in `ranges`, or the hottest until `coverage` of the executed ops
export function selectBlocks(path: string, ranges: Ranges | undefined, coverage: number) {
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
}

// the constant a block's final jump goes to (a MOVI into the jump's register just before), if it has one
export function constJump(b: Block) {
	const last = b.ins.at(-1)!;
	const before = b.ins.at(-2);
	return opName(last.op) === 'JMP' && before && opName(before.op) === 'MOVI' && before.a === last.b ? BigInt.asUintN(64, before.imm) : undefined;
}
// the pcs a block can go to without a register: its branches and exits, its jump's constant, its fall-through
export function edgesOf(b: Block) {
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
export const hex = (v: bigint) => `0x${BigInt.asUintN(64, v).toString(16)}ull`;
export const imm64 = (v: bigint) => `(uint64_t) ${hex(v)}`;

// the registers an op reads and writes, for the temporaries' liveness
export function rw(x: Ins): { r: number[]; w: number[] } {
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
export const isTemp = (r: number) => r >= KB_T0 && r < KB_ZERO;

// what an SSE, x87 or string helper reads and writes besides xmm, x87 and memory state (sse.c,
// x87.c, run.c string): GPRs, the five flags and df. A register it may write is also spilled
export interface Touch {
	r: number[];
	w: number[];
	flags: boolean;
	df: boolean;
}
export function touches(x: Ins): Touch {
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

// the fields that name registers: SSE and x87 carry an xmm index and a memory marker in a and c,
// and string ops read theirs through the cpu after the spill
export const registerFields = (x: Ins) => {
	const name = opName(x.op);
	if (name === 'SSE' || name === 'X87') return [x.b];
	if (name === 'X86STR' || name === 'PC' || name === 'SYSCALL') return [];
	// an access's c and a resolve's a are memory-plan groups
	if (name === 'LD' || name === 'LDS' || name === 'ST') return [x.a, x.b];
	if (name === 'RESOLVE') return [x.b];
	return [x.a, x.b, x.c];
};
// the registers a region holds: every one its ops name, rax and rdx, and (a region that calls or is called) what a helper reads or writes
export function regionRegs(chosen: Block[], helpers: boolean) {
	const regs = new Set<number>([0, 2]);
	for (const b of chosen) for (const x of b.ins) for (const r of registerFields(x)) if (r !== KB_ZERO) regs.add(r);
	if (helpers)
		for (const b of chosen)
			for (const x of b.ins) if (['SSE', 'X87', 'X86STR'].includes(opName(x.op))) for (const r of [...touches(x).r, ...touches(x).w]) regs.add(r);
	return regs;
}
// a temporary read before it is written in a block lives across blocks and stays region state
export function liveInTemps(chosen: Block[]) {
	const liveIn = new Set<number>();
	for (const b of chosen) {
		const written = new Set<number>();
		for (const x of b.ins) {
			const { r, w } = rw(x);
			for (const t of r) if (isTemp(t) && t !== 62 && !written.has(t)) liveIn.add(t);
			for (const t of w) written.add(t);
		}
	}
	return liveIn;
}

// #region flag liveness (--flags)
export const FK = header
	.match(/enum kb_fk\s*\{([\s\S]*?)\};/)![1]!
	.replace(/\/\*[\s\S]*?\*\//g, '')
	.split(',')
	.map((s) => s.trim().replace(/^KB_F_/, ''))
	.filter(Boolean);
export const [FN, FZ, FC, FV, FP] = [1, 2, 4, 8, 16];
export const FALL = 31;
// what aot_flags writes for a kind: may (some path writes it), def (every path does), use (reads it first)
export function kindFlags(kind: string) {
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
export function condReads(cond: number) {
	if (cond < 16) return [FV, FC, FZ, FC | FZ, FN, FP, FN | FV, FZ | FN | FV][cond >> 1]!;
	const k = cond - 16;
	return k >= 14 ? 0 : [FZ, FC, FN, FV, FC | FZ, FN | FV, FZ | FN | FV][k >> 1]!;
}
// an op's effect on the five flags; all is a read of every flag (a helper, a syscall, or a fault point when `fault`)
export function flagEffect(x: Ins, fault: boolean) {
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
export interface DeadFlagsConfig {
	// `live` keeps every flag an exit, helper, syscall or fault point may read; `none` reads nothing there (measurement only)
	mode: 'live' | 'none';
	mutate: string;
	identity: boolean;
}
// the FLAGS ops (as `block:op`) that write only flags no later op reads, over a region's blocks. `dump` holds every
// block of the dump, for the exits that land on one
export function deadFlags(chosen: Block[], index: Map<bigint, number>, calls: Map<bigint, number>, dump: Map<bigint, Block>, cfg: DeadFlagsConfig) {
	return flagLiveness(chosen, index, calls, dump, cfg).dead;
}
// the same walk, with each block's live-in flags and the flags live at an edge to a pc (a block of the region, a call, or a block outside)
export function flagLiveness(chosen: Block[], index: Map<bigint, number>, calls: Map<bigint, number>, dump: Map<bigint, Block>, cfg: DeadFlagsConfig) {
	const { mutate } = cfg;
	const none = cfg.mode === 'none';
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
				const e = flagEffect(x, !cfg.identity && mutate !== 'faultdead');
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
	return { dead, live, edge };
}
// #endregion

// the entry-relative windows of a block: accesses whose base is a register's entry value or a
// constant, plus an offset, grouped into spans the memory plan's size, at most MAX_WINDOWS
export interface Win {
	root: number; // register, or -1 for a constant address
	lo: bigint;
	hi: bigint;
	// --bounds=two: wider than the memory plan's span, so it may cross one piece boundary and holds two resolved pieces
	two?: boolean;
	// the window's first inline cache in the region's window array (a two-piece window takes the next one as well)
	ic?: number;
	// some access it serves is a store, so it resolves for writing
	store?: boolean;
}
export interface Hit {
	win: number;
	off: bigint;
	// the address is a base plus an index with a bound, so the access is at the window plus its own distance from the window's start
	dyn: boolean;
	// a loop window (--loop-guards): resolved when its loop is entered, not at the block's entry
	loop?: boolean;
}
export interface Acc {
	i: number;
	root: number;
	off: bigint;
	hi: bigint;
	w: number;
	store: boolean;
}
export interface WindowConfig {
	identity: boolean;
	bounds: boolean;
	two: boolean;
	// the widest an index window may be (one piece, or --bounds=<bytes>)
	big: bigint;
	mutate: string;
}
export function windowPlanner(cfg: WindowConfig) {
	const { mutate } = cfg;
	// `slots` leaves out the stores and the rsp-based accesses, which the block's frame window serves; `skip` the accesses a loop window serves
	function windowsOf(b: Block, slots = false, skip?: ReadonlySet<number>): { wins: Win[]; hits: Map<number, Hit>; hard: boolean[] } {
		if (cfg.identity) return { wins: [], hits: new Map(), hard: [] };
		return group(accessesOf(b, slots).filter((a) => !skip?.has(a.i)));
	}
	function accessesOf(b: Block, slots: boolean): Acc[] {
		return follow(b.ins, op, cfg.bounds)
			.filter((f) => !(slots && (f.store || f.root === SP)) && (f.hi === f.lo || f.hi - f.lo + BigInt(f.w) <= cfg.big))
			.map((f) => ({ i: f.i, root: f.root, off: f.lo, hi: f.hi, w: f.w, store: f.store }));
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
			if (cfg.two && f.win.hi - f.win.lo > BigInt(SPAN)) f.win.two = true;
			f.win.store = f.list.some((a) => a.store);
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
	return { windowsOf, accessesOf, group };
}

// #region loops (--loop-guards)
// the strongly connected sets of `nodes` over succ, each with its members
export function sccs(nodes: number[], succ: number[][]): number[][] {
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
export interface Loop {
	id: number;
	// every block of the strongly connected set, the blocks of the loops inside it included
	blocks: Set<number>;
	parent: number; // the loop around it, -1 for none
	// the member entered from outside the most: the loop's first block
	header: number;
}
// each cyclic strongly connected set of the region's blocks is a loop; the cycles left once its header (the member entered
// from outside the most) is taken out are the loops inside it. `of` is each block's innermost loop, -1 for none
export function findLoops(succ: number[][], runs: bigint[]): { loops: Loop[]; of: number[] } {
	const loops: Loop[] = [];
	const of = succ.map(() => -1);
	const preds = succ.map(() => [] as number[]);
	succ.forEach((to, j) => to.forEach((k) => preds[k]!.push(j)));
	const decompose = (nodes: number[], parent: number) => {
		for (const comp of sccs(nodes, succ)) {
			if (comp.length === 1 && !succ[comp[0]!]!.includes(comp[0]!)) continue;
			const id = loops.length;
			const set = new Set(comp);
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
			loops.push({ id, blocks: set, parent, header });
			for (const j of comp) of[j] = id;
			decompose(comp.filter((j) => j !== header), id);
		}
	};
	decompose(succ.map((_, j) => j), -1);
	return { loops, of };
}
// #endregion
