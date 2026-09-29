import { readdirSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';

/**
 * Provenance of every memory access in the hot blocks (traces included) of KATYBUG_HOT dumps, weighted
 * by each block's run count: which accesses could keep one validated direct host offset for a run of
 * their trace, and for the rest, why not. Each register's value is followed through the block as a
 * live-in register or a constant plus an offset, a pointer loaded from memory plus an offset, or an
 * unknown value with the reason it is unknown. An access on a live-in base is eligible: one check of
 * its window at the trace's start covers it, and nothing in a straight run of ops can remap memory
 * except a syscall, which ends a block.
 *
 * `provenance.ts <dump dir>...`, one row per directory (a workload; every process's dump in it)
 */
const header = readFileSync(new URL('../../../src/gmux/katybug/kb.h', import.meta.url), 'utf8');
const opBody = header.match(/enum kb_op\s*\{([\s\S]*?)\};/)![1]!.replace(/\/\*[\s\S]*?\*\//g, '');
const op = Object.fromEntries(
	opBody
		.split(',')
		.map((s) => s.trim())
		.filter(Boolean)
		.map((name, i) => [name.replace(/^KB_/, ''), i])
) as Record<string, number>;
const KB_ZERO = 63;
const SPAN = 16 * 255; // the memory plan's window (run.c plan_mem)
const M64 = (1n << 64n) - 1n;

interface Ins {
	op: number;
	w: number;
	a: number;
	b: number;
	c: number;
	imm: bigint;
}
interface Block {
	runs: number;
	exits: Map<number, number>;
	ins: Ins[];
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
		const exits = new Map<number, number>();
		const tail = lines[i + n + 1] ?? '';
		if (tail.startsWith('exits')) for (const e of tail.split(' ').slice(1)) exits.set(...(e.split(':').map(Number) as [number, number]));
		blocks.push({ runs: Number(m[5]), exits, ins });
		i += n + (tail.startsWith('exits') ? 1 : 0);
	}
	return blocks;
}

type Cause = 'indexed' | 'computed' | 'opaque';
type Val =
	| { k: 'const'; off: bigint }
	| { k: 'root'; id: number; off: bigint }
	| { k: 'unk'; cause: Cause };

// roots 0..63 are the registers at entry; later ids are loaded pointers ('loaded') or the thread base
let nextRoot = 100;
const loadedRoots = new Set<number>();
const fresh = (loaded: boolean): Val => {
	const id = nextRoot++;
	if (loaded) loadedRoots.add(id);
	return { k: 'root', id, off: 0n };
};

const writers = new Set(
	['MOVI', 'MOV', 'ADD', 'SUB', 'AND', 'OR', 'XOR', 'SHL', 'SHR', 'SAR', 'ROR', 'MUL', 'UMULH', 'SMULH', 'UDIV', 'SDIV', 'UREM', 'SREM', 'ZEXT', 'SEXT', 'INS', 'SETCC', 'SEL', 'CARRY', 'BSWAP', 'CLZ', 'CTZ', 'X86SHD', 'POPCNT', 'NZCV', 'CRC32', 'CLOCK', 'EXCL'].map(
		(n) => op[n]!
	)
);
const fold: Record<string, (x: bigint, y: bigint) => bigint> = {
	AND: (x, y) => x & y,
	OR: (x, y) => x | y,
	XOR: (x, y) => x ^ y,
	SHL: (x, y) => (y >= 64n ? 0n : (x << y) & M64),
	SHR: (x, y) => (y >= 64n ? 0n : x >> y),
	MUL: (x, y) => (x * y) & M64
};

const CLASSES = [
	'entry base, window shared',
	'entry base, lone',
	'constant address',
	'loaded pointer',
	'base plus index',
	'computed base',
	'clobbered by an opaque op',
	'after a syscall',
	'rep string, runtime length'
] as const;
type Class = (typeof CLASSES)[number];

interface Access {
	cls: Class;
	root: number;
	off: bigint;
	w: number;
	runs: number;
	nominal: number;
	grouped: boolean;
}

function analyse(b: Block, out: Access[]) {
	const v: Val[] = Array.from({ length: 64 }, (_, r) => (r === KB_ZERO ? { k: 'const', off: 0n } : { k: 'root', id: r, off: 0n }));
	let remapped = false;
	let gone = 0;
	const own: Access[] = [];
	const taint = (...regs: number[]) => {
		for (const r of regs) if (r < 64) v[r] = { k: 'unk', cause: 'opaque' };
	};
	const access = (base: Val, w: number, grouped: boolean, rep = false) => {
		let cls: Class;
		let root = -1;
		let off = 0n;
		if (rep) cls = 'rep string, runtime length';
		else if (remapped) cls = 'after a syscall';
		else if (base.k === 'const') cls = 'constant address';
		else if (base.k === 'root') {
			root = base.id;
			off = BigInt.asIntN(64, base.off);
			cls = loadedRoots.has(base.id) ? 'loaded pointer' : 'entry base, lone';
		} else cls = base.cause === 'indexed' ? 'base plus index' : base.cause === 'computed' ? 'computed base' : 'clobbered by an opaque op';
		own.push({ cls, root, off, w, runs: b.runs - gone, nominal: b.runs, grouped });
	};
	const name = (o: number) => Object.keys(op).find((k) => op[k] === o)!;
	for (const [i, x] of b.ins.entries()) {
		gone += b.exits.get(i - 1) ?? 0;
		const nm = name(x.op);
		const B = v[x.b]!;
		const C = v[x.c]!;
		if (x.op === op.LD || x.op === op.LDS || x.op === op.ST) {
			const base: Val = B.k === 'root' ? { k: 'root', id: B.id, off: BigInt.asUintN(64, B.off + x.imm) } : B.k === 'const' ? { k: 'const', off: BigInt.asUintN(64, B.off + x.imm) } : B;
			access(base, x.w, x.c !== 0);
			if (x.op !== op.ST && x.a !== KB_ZERO) v[x.a] = x.w === 8 ? fresh(true) : { k: 'unk', cause: 'computed' };
			continue;
		}
		if (x.op === op.SYSCALL) {
			remapped = true;
			taint(0, 1, 11);
			continue;
		}
		if (x.op === op.X86MD) taint(0, 2);
		else if (x.op === op.CPUID) taint(0, 1, 2, 3);
		else if (x.op === op.X86STR) {
			access(v[7]!, x.w, false, true);
			if (x.imm === 0n) access(v[6]!, x.w, false, true);
			taint(7, 6, 1);
		} else if (x.op === op.SSE) {
			const code = Number(x.imm & 0xffn);
			const pre = Number((x.imm >> 8n) & 0xffn);
			if (x.c & 0x80) access(B, 16, false);
			if ([0x2c, 0x2d, 0x50, 0xc5, 0xd7].includes(code)) taint(x.a & 15);
			if (code === 0x7e && pre === 0x66 && !(x.c & 0x80)) taint(x.c & 15);
		} else if (x.op === op.X87) {
			if (x.c & 0x80) access(B, 16, false);
			if (Number(x.imm & 0xffffn) === 0xdfe0) taint(0);
		} else if (x.op === op.FSBASE || x.op === op.TPIDR) v[x.a] = fresh(false);
		else if (x.op === op.X86FLAGS) {
			if (x.imm === 0n) v[x.a] = { k: 'unk', cause: 'computed' };
		} else if (writers.has(x.op) && x.a !== KB_ZERO) {
			const a = x.a;
			if (nm === 'MOVI') v[a] = { k: 'const', off: BigInt.asUintN(64, x.imm) };
			else if (nm === 'MOV') v[a] = B;
			else if (nm === 'ADD' || nm === 'SUB') {
				const sub = nm === 'SUB';
				const sum = (p: bigint, q: bigint) => BigInt.asUintN(64, sub ? p - q : p + q);
				if (B.k === 'const' && C.k === 'const') v[a] = { k: 'const', off: sum(B.off, C.off) };
				else if (B.k === 'root' && C.k === 'const') v[a] = { k: 'root', id: B.id, off: sum(B.off, C.off) };
				else if (!sub && B.k === 'const' && C.k === 'root') v[a] = { k: 'root', id: C.id, off: sum(B.off, C.off) };
				else if (B.k === 'unk' && C.k === 'const') v[a] = B;
				else if (!sub && B.k === 'const' && C.k === 'unk') v[a] = C;
				else v[a] = { k: 'unk', cause: sub ? 'computed' : 'indexed' };
			} else if ((nm === 'ZEXT' || nm === 'SEXT') && x.w >= 8) v[a] = B;
			else if (fold[nm] && B.k === 'const' && C.k === 'const') v[a] = { k: 'const', off: fold[nm]!(B.off, C.off) };
			else v[a] = { k: 'unk', cause: 'computed' };
		}
	}
	// windows: accesses on one entry base within the plan's span share one check
	const byRoot = new Map<number, Access[]>();
	for (const a of own) if (a.cls === 'entry base, lone') byRoot.set(a.root, [...(byRoot.get(a.root) ?? []), a]);
	for (const list of byRoot.values()) {
		list.sort((p, q) => (p.off < q.off ? -1 : p.off > q.off ? 1 : 0));
		for (let i = 0; i < list.length; ) {
			let j = i + 1;
			let hi = list[i]!.off + BigInt(list[i]!.w);
			while (j < list.length) {
				const end = list[j]!.off + BigInt(list[j]!.w);
				if (Number((end > hi ? end : hi) - list[i]!.off) > SPAN) break;
				if (end > hi) hi = end;
				j++;
			}
			if (j - i >= 2) for (let k = i; k < j; k++) list[k]!.cls = 'entry base, window shared';
			i = j;
		}
	}
	out.push(...own);
}

const rows: string[] = [];
const dirs = process.argv.slice(2);
let mismatches = 0;
for (const dir of dirs) {
	const acc: Access[] = [];
	for (const f of readdirSync(dir).filter((f) => f.endsWith('.hot'))) for (const b of parse(join(dir, f))) analyse(b, acc);
	const total = acc.reduce((s, a) => s + a.runs, 0);
	const by = Object.fromEntries(CLASSES.map((c) => [c, 0])) as Record<Class, number>;
	let nominal = 0;
	const miss: Record<string, number> = {};
	for (const a of acc) {
		by[a.cls] += a.runs;
		nominal += a.nominal;
		if (a.grouped && a.cls !== 'entry base, window shared' && a.cls !== 'constant address') miss[a.cls] = (miss[a.cls] ?? 0) + 1;
	}
	const planMiss = Object.entries(miss).map(([c, n]) => `${c} ${n}`).join(', ') || '0';
	mismatches += Object.keys(miss).length;
	const pct = (n: number) => `${((100 * n) / total).toFixed(1)}%`;
	const provable = by['entry base, window shared'] + by['entry base, lone'] + by['constant address'];
	const reasons = CLASSES.slice(3)
		.map((c) => [c, by[c]] as const)
		.sort((p, q) => q[1] - p[1])
		.slice(0, 3)
		.map(([c, n]) => `${c} ${n} (${pct(n)})`)
		.join('; ');
	rows.push(
		`| ${basename(dir).replace(/^hot-/, '')} | ${total} | ${pct(provable)} | ${CLASSES.slice(0, 3).map((c) => pct(by[c])).join(' | ')} | ${CLASSES.slice(3).map((c) => pct(by[c])).join(' | ')} | ${((100 * (nominal - total)) / nominal).toFixed(1)}% | ${planMiss} | ${reasons} |`
	);
}
console.log(
	`| workload | weighted accesses | provable | ${CLASSES.join(' | ')} | run-weighting removed by side exits | plan groups not provable | top three reasons |`
);
console.log(`| --- | --- | --- | ${CLASSES.map(() => '---').join(' | ')} | --- | --- | --- |`);
for (const r of rows) console.log(r);
if (mismatches) process.exitCode = 1;
