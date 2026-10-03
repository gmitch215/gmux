import { readFileSync, writeFileSync } from 'node:fs';
import { analyze, vecWrite, type Cls } from './slots.ts';

/**
 * The AOT oracle's lifter: turns the hottest blocks of each KATYBUG_HOT dump into C, one region per
 * dump (one process), which clang then compiles into katybug.wasm with -DKB_AOT. A region holds guest
 * registers and flags in locals and moves between its blocks with goto; everything else leaves to the
 * interpreter. A decoded block runs a region only if its IR matches the lifted one exactly
 * (kb_aot_attach), so the guard is the IR itself. A block may be a trace (KB_EXIT side exits).
 *
 * `lift.ts [--temps] [--nogroups] [--windows] [--regs] [--slots] [--ranges=<lo>-<hi>,...] <out.c> <coverage 0..1> <dump.hot>...`
 *
 * `--ranges` replaces the coverage cut: the region is the dump's blocks that start in those code ranges (one hot
 * function and the callees worth keeping inside it, from functions.ts), and the lifter reports its direct edges
 * inside, leaving, and through a register. A block outside the ranges, or one that cannot be lifted, is an exit.
 *
 * The flags are the representation ladder's rungs (ladder.sh): `--temps` keeps only architectural
 * registers across blocks and helper calls, `--nogroups` ignores the memory plan's KB_RESOLVE groups,
 * `--windows` runs each block's provable accesses (entry base or constant address plus offset) as
 * plain host accesses inside windows resolved once at the block's entry, with a checked copy of the
 * block for a window that does not resolve.
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
 */
const args = process.argv.slice(2);
const flags = new Set(args.filter((a) => a.startsWith('--')));
const [out = '', coverageArg = '0.99', ...dumps] = args.filter((a) => !a.startsWith('--'));
const opt = {
	temps: flags.has('--temps'),
	nogroups: flags.has('--nogroups'),
	windows: flags.has('--windows'),
	regs: flags.has('--regs') || flags.has('--slots'),
	slots: flags.has('--slots')
};
const mutate = process.env.LIFT_MUTATE ?? '';
if (opt.slots && !(opt.temps && opt.windows)) throw new Error('--slots needs --temps and --windows');
const coverage = Number(coverageArg);
// `--ranges=<lo>-<hi>,...` lifts the blocks that start in those code ranges (a function and its callees), however hot
const ranges = [...flags]
	.find((f) => f.startsWith('--ranges='))
	?.slice(9)
	.split(',')
	.map((r) => r.split('-').map((v) => BigInt(v)) as [bigint, bigint]);
const inRanges = (pc: bigint) => ranges!.some(([lo, hi]) => pc >= lo && pc < hi);
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
function edgeReport(dump: string, chosen: Block[]) {
	const starts = new Set(chosen.map((b) => b.pc));
	let inside = 0;
	let outside = 0;
	let indirect = 0;
	let syscalls = 0;
	for (const b of chosen) {
		const to: bigint[] = [];
		for (const x of b.ins) {
			const name = opName(x.op);
			if (name === 'BR' || name === 'BRZ') to.push(b.target);
			else if (name === 'EXIT') to.push(BigInt.asUintN(64, b.pc + BigInt.asIntN(32, x.imm >> 16n)));
		}
		const last = b.ins.at(-1)!;
		const before = b.ins.at(-2);
		if (opName(last.op) === 'JMP') {
			if (before && opName(before.op) === 'MOVI' && before.a === last.b) to.push(BigInt.asUintN(64, before.imm));
			else indirect++;
		} else if (opName(last.op) === 'SYSCALL') syscalls++;
		else to.push(b.next);
		for (const t of to) if (starts.has(t)) inside++;
		else outside++;
	}
	console.error(`${dump}: region ${chosen.length} blocks, ${inside} direct edges inside, ${outside} leaving, ${indirect} jumps through a register, ${syscalls} syscalls`);
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

// the entry-relative windows of a block: accesses whose base is a register's entry value or a
// constant, plus an offset, grouped into spans the memory plan's size, at most MAX_WINDOWS
interface Win {
	root: number; // register, or -1 for a constant address
	lo: bigint;
	hi: bigint;
}
interface Hit {
	win: number;
	off: bigint;
}
// `slots` leaves out the stores and the rsp-based accesses, which the block's frame window serves
function windowsOf(b: Block, slots = false): { wins: Win[]; hits: Map<number, Hit> } {
	type Val = { k: 'root'; id: number; off: bigint } | { k: 'const'; off: bigint } | { k: 'unk' };
	const v: Val[] = Array.from({ length: 64 }, (_, r) => (r === KB_ZERO ? { k: 'const', off: 0n } : { k: 'root', id: r, off: 0n }));
	const unk = (...regs: number[]) => {
		for (const r of regs) if (r < 64 && r !== KB_ZERO) v[r] = { k: 'unk' };
	};
	const acc: { i: number; root: number; off: bigint; w: number }[] = [];
	const add = (p: bigint, q: bigint, sub = false) => BigInt.asIntN(64, sub ? p - q : p + q);
	for (const [i, x] of b.ins.entries()) {
		const name = opName(x.op);
		if (name === 'LD' || name === 'LDS' || name === 'ST') {
			const B = v[x.b]!;
			if (slots && (name === 'ST' || (B.k === 'root' && B.id === SP))) {
				if (name !== 'ST') unk(x.a);
				continue;
			}
			if (B.k === 'const') acc.push({ i, root: -1, off: add(B.off, x.imm), w: x.w });
			else if (B.k === 'root' && B.id < KB_T0) acc.push({ i, root: B.id, off: add(B.off, x.imm), w: x.w });
			if (name !== 'ST') unk(x.a);
			continue;
		}
		if (name === 'SYSCALL') {
			unk(0, 1, 11);
			continue;
		}
		if (name === 'X86MD') unk(0, 2);
		else if (name === 'X86STR') unk(7, 6, 1);
		else if (name === 'SSE') {
			const code = Number(x.imm & 0xffn);
			const pre = Number((x.imm >> 8n) & 0xffn);
			if ([0x2c, 0x2d, 0x50, 0xc5, 0xd7].includes(code)) unk(x.a & 15);
			if (code === 0x7e && pre === 0x66 && !(x.c & 0x80)) unk(x.c & 15);
		} else if (name === 'X87') {
			if (Number(x.imm & 0xffffn) === 0xdfe0) unk(0);
		} else {
			const { w } = rw(x);
			for (const a of w) {
				if (a === KB_ZERO) continue;
				const B = v[x.b]!;
				const C = v[x.c]!;
				if (name === 'MOVI') v[a] = { k: 'const', off: BigInt.asIntN(64, x.imm) };
				else if (name === 'MOV') v[a] = B;
				else if (name === 'ADD' || name === 'SUB') {
					const sub = name === 'SUB';
					if (B.k === 'const' && C.k === 'const') v[a] = { k: 'const', off: add(B.off, C.off, sub) };
					else if (B.k === 'root' && C.k === 'const') v[a] = { k: 'root', id: B.id, off: add(B.off, C.off, sub) };
					else if (!sub && B.k === 'const' && C.k === 'root') v[a] = { k: 'root', id: C.id, off: add(B.off, C.off) };
					else v[a] = { k: 'unk' };
				} else if ((name === 'ZEXT' || name === 'SEXT') && x.w >= 8) v[a] = B;
				else v[a] = { k: 'unk' };
			}
		}
	}
	const wins: Win[] = [];
	const hits = new Map<number, Hit>();
	const roots = [...new Set(acc.map((a) => a.root))];
	const found: { win: Win; list: typeof acc }[] = [];
	for (const rt of roots) {
		const list = acc.filter((a) => a.root === rt).sort((p, q) => (p.off < q.off ? -1 : p.off > q.off ? 1 : 0));
		for (let s = 0; s < list.length; ) {
			let e = s + 1;
			let hi = list[s]!.off + BigInt(list[s]!.w);
			while (e < list.length) {
				const end = list[e]!.off + BigInt(list[e]!.w);
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
		wins.push(f.win);
		for (const a of f.list) hits.set(a.i, { win: wins.length - 1, off: a.off - f.win.lo });
	}
	return { wins, hits };
}

const lines: string[] = ['#include <string.h>', '#include "aot.h"', ''];
const table: { pc: bigint; next: bigint; target: bigint; n: number; region: number; idx: number; name: string }[] = [];
const regionNames: string[] = [];
const regionSizes: number[] = [];
const regionSlotted: boolean[] = [];
let irIns = 0;
let windowCount = 0;

dumps.forEach((dump, region) => {
	const all = parse(dump);
	const weight = (b: Block) => b.runs * BigInt(b.ins.length);
	const total = all.reduce((s, b) => s + weight(b), 0n);
	const sorted = [...all].sort((x, y) => (weight(y) > weight(x) ? 1 : weight(y) < weight(x) ? -1 : 0));
	const chosen: Block[] = [];
	let covered = 0n;
	for (const b of sorted) {
		if (ranges ? !inRanges(b.pc) : Number(covered) >= coverage * Number(total)) {
			if (ranges) continue;
			break;
		}
		if (!liftable(b)) continue;
		chosen.push(b);
		covered += weight(b);
	}
	if (ranges) edgeReport(dump, chosen);
	const share = Number(covered) / Number(total);
	console.error(`${dump}: ${all.length} blocks, ${chosen.length} lifted, ${(100 * share).toFixed(2)}% of executed ops`);

	const R = `r${region}`;
	regionNames.push(`${R}_run`);
	regionSizes.push(chosen.length);
	const index = new Map(chosen.map((b, j) => [b.pc, j]));
	const arch = /^arch (\d+)$/m.exec(readFileSync(dump, 'utf8'));
	const found = opt.slots && (!arch || arch[1] === '0') ? analyze(chosen, index, { name: opName, rw, sp: SP, zero: KB_ZERO, span: SPAN, maxSlots: MAX_SLOTS }) : undefined;
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
	for (const b of chosen) for (const x of b.ins) for (const r of registerFields(x)) if (r !== KB_ZERO) regs.add(r);	// a temporary read before it is written in a block lives across blocks and stays region state
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
	const cross = (r: number) => !opt.temps || !isTemp(r) || liveIn.has(r);
	const reg = (r: number) => (r === KB_ZERO ? '(uint64_t) 0' : `g${r}`);
	const dst = (r: number) => (r === KB_ZERO ? 'sink' : `g${r}`);
	const regList = [...regs].filter(cross).sort((a, b) => a - b);

	const winBase = new Map<number, number>();
	// the slots form: sm is a block that keeps its frame's slots in locals (the fast body of a promoted
	// block); every other body of that form only has to enter promoted blocks through their stubs
	const emit = (b: Block, j: number, mode: 'plain' | 'fast' | 'slow', precise = false, slotted = false) => {
		const fast = mode === 'fast';
		const sm = slotted && fast && !!plan?.promoted[j];
		const pin = fast ? windowsOf(b, sm) : { wins: [] as Win[], hits: new Map<number, Hit>() };
		const label = mode === 'slow' ? `S${j}` : `B${j}`;
		const body: string[] = [];
		let ipcNow = 0n;
		let ipc = b.pc;
		let m = 0;
		const grouped = (x: Ins) => !opt.nogroups && x.c !== 0 && !sm;
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
			body.push('\tf.n = cpu->n; f.z = cpu->z; f.c = cpu->c; f.v = cpu->v; f.p = cpu->p; df = cpu->df; gen = cpu->mapgen;');
			if (precise) body.push('\tgfs = cpu->fs;');
			body.push(`\tAOT_COUNT_RDC(${cat}, ${state + (precise ? 1 : 0)});`);
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
			body.push('\tgen = cpu->mapgen;');
			body.push(`\tAOT_COUNT_RDC(${cat}, ${ws.length + (t.flags ? 5 : 0) + 1});`);
		};
		// a block's exit: straight into the next lifted block when there is one and no signal waits
		const leave = (from: bigint, to: bigint, i: number) => {
			const k = index.get(to);
			if (k === undefined) return `{ pc = ${hex(to)}; goto out; }`;
			const kind = !slotted || !plan ? 'plain' : sm ? plan.edge(j, k, exitD(i)) : plan.promoted[k] ? 'stub' : 'plain';
			const fix = kind === 'carry' ? plan!.need[k]!.filter((s) => !V.has(s)) : [];
			const take = fix.length ? `{ ${fix.map(slotLoad).join(' ')} AOT_COUNT_CAT(AOT_C_FIX, 0, ${fix.length}); goto B${k}; }` : `goto ${kind === 'stub' ? 'E' : 'B'}${k};`;
			return `{ if (AOT_CONTINUE(${R}_ok[${k}], ${to <= from ? 1 : 0})) ${take} pc = ${hex(to)}; goto out; }`;
		};
		const fault = (why?: string, sig?: number) =>
			`{ ${why ? `cpu->fault = "${why}"; cpu->fault_sig = ${sig}; ` : ''}cpu->ipc = ${hex(ipc)}; pc = ${hex(b.pc)}; goto out; }`;

		body.push(`${label}: {`, `\tstruct kb_ic* ic = ${R}_blk[${j}]->ic;`, '\t(void) ic;', `\tAOT_COUNT_BLOCK(${R}_blk[${j}]);`);
		if (temps.length) body.push(`\tuint64_t ${temps.map((r) => `g${r}`).join(', ')};`);
		if (pin.wins.length) {
			const key = sm ? -1 - j : j;
			let base0 = winBase.get(key);
			if (base0 === undefined) {
				base0 = windowCount;
				windowCount += pin.wins.length;
				winBase.set(key, base0);
			}
			const base = base0;
			body.push(`\tuint8_t *${pin.wins.map((_, k) => `w${k}`).join(', *')};`);
			pin.wins.forEach((w, k) => {
				const len = Number(w.hi - w.lo);
				const va = w.root < 0 ? hex(w.lo) : `${reg(w.root)} + ${imm64(w.lo)}`;
				body.push(
					`\t{ uint64_t va = ${va}; struct kb_ic* q = &${R}_win[${base + k}];`,
					`\t  w${k} = q->gen == gen && ${len}u <= q->span && va - q->lo <= q->span - ${len}u ? q->host + (va - q->lo) : kb_host_ic(cpu, q, va, ${len}u); }`
				);
			});
			body.push(`\tif (!(${pin.wins.map((_, k) => `w${k}`).join(' && ')})) goto S${j};`);
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
					if (V.has(sl.id)) body.push(`\t${D} = ${ext(`s${sl.id}`)};`, ...cnt('AOT_C_SLOT', 0));
					else {
						body.push(`\t{ uint64_t v = 0; memcpy(&v, wf + ${sl.off - lo}, ${W}); s${sl.id} = v; ${D} = ${ext('v')}; }`, ...cnt('AOT_C_MEM', 0));
						V.add(sl.id);
					}
					m++;
					return;
				}
				if (name !== 'ST' && c?.t === 'win') {
					body.push(`\t{ uint64_t v = 0; memcpy(&v, wf + ${c.off - lo}, ${W}); ${D} = ${ext('v')}; }`, ...cnt('AOT_C_MEM', 0));
					m++;
					return;
				}
				if (name === 'ST' && sl) {
					const write = mutate === 'nowrite' ? '' : `memcpy(wf + ${sl.off - lo}, &v, ${W}); `;
					body.push(`\t{ uint64_t v = ${A} & aot_mask(${W}); ${write}s${sl.id} = v; }`, ...cnt('AOT_C_SLOT', 1));
					kill(plan!.overlapping(plan!.comp[j]!, sl.off, sl.w));
					V.add(sl.id);
					m++;
					return;
				}
				if (name === 'ST' && c?.t === 'win') {
					body.push(`\t{ uint64_t v = ${A}; memcpy(wf + ${c.off - lo}, &v, ${W}); }`, ...cnt('AOT_C_MEM', 1));
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
					const hit = pin.hits.get(i);
					if (hit) {
						body.push(`\t{ uint64_t v = 0; memcpy(&v, w${hit.win} + ${hit.off}, ${W}); ${D} = ${v}; }`);
						m++;
						break;
					}
					// a grouped access reads through its group's resolved bytes when the span resolved
					const g = x.c - 1;
					const gr = grouped(x);
					// the interpreter writes a faulting load's destination before it checks, and so does this
					body.push(
						`\t{ uint64_t va = ${B} + ${imm64(x.imm)}, v = 0; struct kb_ic* q = &ic[${m}];`,
						...(gr ? [`\t  if (gh[${g}]) { memcpy(&v, gh[${g}] + (va - gva[${g}]), ${W}); ${D} = ${v}; } else {`] : []),
						`\t  int slow = __builtin_expect(AOT_SLOW(q, gen, va, ${W}), 0);`,
						`\t  if (slow) v = kb_load_ic(cpu, q, va, ${W}); else memcpy(&v, q->host + (va - q->lo), ${W});`,
						`\t  ${D} = ${v};`,
						`\t  if (slow && cpu->fault) ${fault()} ${gr ? '} ' : ''}}`
					);
					m++;
					break;
				}
				case 'ST': {
					const hit = pin.hits.get(i);
					if (hit) {
						body.push(`\t{ uint64_t v = ${A}; memcpy(w${hit.win} + ${hit.off}, &v, ${W}); }`);
						m++;
						break;
					}
					const g = x.c - 1;
					const gr = grouped(x);
					body.push(
						`\t{ uint64_t va = ${B} + ${imm64(x.imm)}, v = ${A}; struct kb_ic* q = &ic[${m}];`,
						...(gr ? [`\t  if (gh[${g}]) memcpy(gh[${g}] + (va - gva[${g}]), &v, ${W}); else`] : []),
						`\t  if (__builtin_expect(AOT_SLOW(q, gen, va, ${W}), 0)) { kb_store_ic(cpu, q, va, v, ${W}); if (cpu->fault) ${fault()} }`,
						`\t  else memcpy(q->host + (va - q->lo), &v, ${W}); }`
					);
					m++;
					break;
				}
				case 'RESOLVE':
					// the whole span, range included: AOT_NO_RANGE_CHECK trusts accesses, never a span
					if (!opt.nogroups && !fast)
						body.push(
							`\t{ uint64_t va = ${B} + ${imm64(x.imm)}; struct kb_ic* q = &ic[${m}]; gva[${x.a}] = va;`,
							`\t  gh[${x.a}] = q->gen == gen && ${16 * W}u <= q->span && va - q->lo <= q->span - ${16 * W}u ? q->host + (va - q->lo) : kb_host_ic(cpu, q, va, ${16 * W}u); }`
						);
					m++;
					break;
				case 'FLAGS': body.push(`\taot_flags(&f, ${x.imm}, ${B}, ${C}, ${A}, ${W});`); break;
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
					const to = slotted ? plan?.sym[j]?.exits.find((e) => e.i === i)?.to : undefined;
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
					else reload('AOT_C_SYS');
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
			`\t{ struct kb_ic* q = &${R}_fw[${c}]; wf = q->gen == gen && ${len}u <= q->span && fl - q->lo <= q->span - ${len}u ? q->host + (fl - q->lo) : kb_host_ic(cpu, q, fl, ${len}u); }`,
			`\tif (!wf) goto S${j};`,
			...loads,
			`\tAOT_COUNT_CAT(AOT_C_FIX, 0, ${loads.length});`,
			`\tgoto B${j};`,
			'}'
		];
	};
	const bodyOf = (precise: boolean, slotted = false) => {
		const body: string[] = [];
		chosen.forEach((b, j) => {
			if (slotted && plan!.promoted[j]) body.push(...stub(j), ...emit(b, j, 'fast', precise, true), ...emit(b, j, 'slow', precise, true));
			else if (opt.windows && windowsOf(b).wins.length) {
				twins.add(j);
				body.push(...emit(b, j, 'fast', precise, slotted), ...emit(b, j, 'slow', precise, slotted));
			} else body.push(...emit(b, j, 'plain', precise, slotted));
		});
		return body;
	};
	chosen.forEach((b) => (irIns += b.ins.length));
	const body = bodyOf(false);
	const bodyP = opt.regs ? bodyOf(true) : [];
	const bodyS = plan ? bodyOf(true, true) : [];

	chosen.forEach((b, j) => {
		lines.push(`static const struct kb_ins ${R}_i${j}[] = {`);
		for (const x of b.ins) lines.push(`\t{${x.op}, ${x.w}, ${x.a}, ${x.b}, ${x.c}, (int64_t) ${hex(x.imm)}},`);
		lines.push('};');
		table.push({ pc: b.pc, next: b.next, target: b.target, n: b.ins.length, region, idx: j, name: `${R}_i${j}` });
	});
	lines.push(`static unsigned char ${R}_ok[${chosen.length}];`, `static struct kb_block* ${R}_blk[${chosen.length}];`);
	if (opt.windows) lines.push(`static struct kb_ic ${R}_win[${Math.max(1, windowCount)}];`);
	if (plan) lines.push(`static struct kb_ic ${R}_fw[${plan.wins.length}];`);
	lines.push('');

	const fn = (precise: boolean, text: string[], slotted = false) => {
		lines.push(`static uint64_t ${R}${slotted ? 's' : precise ? 'p' : ''}_run(struct kb_cpu* cpu, uint64_t pc) {`);
		lines.push(...regList.map((r) => `\tuint64_t g${r} = cpu->r[${r}];`));
		lines.push(
			'\tuint64_t sink = 0;',
			'\tstruct aot_fl f = {cpu->n, cpu->z, cpu->c, cpu->v, cpu->p};',
			'\tuint8_t* gh[8];',
			'\tuint64_t gva[8];',
			'\t(void) gh;',
			'\t(void) gva;',
			'\tint df = cpu->df;',
			'\tuint32_t gen = cpu->mapgen;',
			'\tint fuel = KB_POLL_FUEL;',
			'\t(void) sink;',
			'\t(void) fuel;'
		);
		if (precise) lines.push('\tuint64_t gfs = cpu->fs;', '\t(void) gfs;');
		if (slotted) {
			lines.push('\tuint64_t fb = 0, fl = 0;', '\tuint8_t* wf = NULL;', '\t(void) fb;', '\t(void) fl;', '\t(void) wf;');
			for (const s of plan!.slots) lines.push(`\tuint64_t s${s.id} = 0;`, `\t(void) s${s.id};`);
		}
		lines.push(`\tAOT_COUNT_RDC(AOT_C_REGION, ${regList.length + 7 + (precise ? 1 : 0)});`, '\tgoto dispatch;', 'dispatch:', '\tswitch (pc) {');
		chosen.forEach((b, j) => lines.push(`\t\tcase ${hex(b.pc)}: if (${R}_ok[${j}]) goto ${slotted && plan!.promoted[j] ? 'E' : 'B'}${j}; goto out;`));
		lines.push('\t\tdefault: goto out;', '\t}');
		for (const t of text) lines.push(t);
		lines.push('out:', `\tAOT_COUNT_WRC(AOT_C_REGION, ${regList.length + 6});`, '\tAOT_COUNT_EXIT(pc);');
		lines.push(...regList.map((r) => `\tcpu->r[${r}] = g${r};`));
		lines.push('\tcpu->n = f.n; cpu->z = f.z; cpu->c = f.c; cpu->v = f.v; cpu->p = f.p; cpu->df = df;', '\treturn pc;', '}', '');
	};
	fn(false, body);
	if (opt.regs) fn(true, bodyP);
	regionSlotted.push(!!plan);
	if (plan) fn(true, bodyS, true);
	const memOps = chosen.reduce((n, b) => n + b.ins.filter((x) => ['LD', 'LDS', 'ST'].includes(opName(x.op))).length, 0);
	const windowed = opt.windows ? chosen.reduce((n, b) => n + windowsOf(b).hits.size, 0) : 0;
	console.error(`${R}: ${memOps} loads and stores, ${windowed} in windows resolved once per block entry, ${memOps - windowed} checked at each access`);
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
	...(opt.regs ? [`static uint64_t (*const aot_runp[])(struct kb_cpu*, uint64_t) = {${regionNames.map((n) => n.replace('_run', 'p_run')).join(', ')}};`] : []),
	...(opt.slots ? [`static uint64_t (*const aot_runs[])(struct kb_cpu*, uint64_t) = {${regionNames.map((n, k) => n.replace('_run', regionSlotted[k] ? 's_run' : 'p_run')).join(', ')}};`] : []),
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
	opt.slots
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
