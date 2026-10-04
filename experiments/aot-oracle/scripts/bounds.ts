/**
 * Where each memory access of a block points, for the lifter's windows and provenance.ts: a register is
 * followed through the block as a constant, a live-in register (the register's value at the block's entry)
 * plus a constant, or, with `bounded`, one of those plus an interval. An interval comes from a mask (`and`), a
 * zero or sign extension, a byte or halfword load, a shift or multiply by a constant, a remainder, and a trace's
 * side exits (a compare of the value with a constant that the exit did not take), through adds and subtracts.
 * An access whose address is a live-in register or a constant plus an interval is a window from the interval's
 * low end to its high end plus the access's width. Anything else (a loaded pointer, two live-in terms) is not
 * reported. Without `bounded` the result is the lifter's original: a constant or a live-in register plus a constant.
 */
export interface Ins {
	op: number;
	w: number;
	a: number;
	b: number;
	c: number;
	imm: bigint;
}
/** an access at `root` (a register at entry, -1 for no register) plus an address from `lo` to `hi` */
export interface Found {
	i: number;
	store: boolean;
	w: number;
	root: number;
	lo: bigint;
	hi: bigint;
}

const KB_ZERO = 63;
const KB_T0 = 32;
// kb.h's kb_fk: KB_F_SUB
const F_SUB = 1n;
const M64 = (1n << 64n) - 1n;
const S63 = 1n << 63n;
// a window this wide or wider has no use: no mapping holds it
const LIMIT = 1n << 40n;

type Range = [bigint, bigint];
type Val =
	| { k: 'const'; off: bigint }
	| { k: 'root'; id: number; off: bigint }
	| { k: 'itv'; vid: number; off: bigint }
	| { k: 'bi'; id: number; vid: number; off: bigint }
	| { k: 'unk' };

// the x86 condition a trace's side exit leaves on, and what the compare then says of its operands if the exit is not taken
type Rel = 'lt' | 'le' | 'gt' | 'ge' | 'eq' | null;
const KEEP: Record<number, [Rel, boolean]> = {
	2: ['ge', false], // exit on below: continues b >= c
	3: ['lt', false], // exit on above or equal
	5: ['eq', false], // exit on not equal
	6: ['gt', false], // exit on below or equal
	7: ['le', false], // exit on above
	12: ['ge', true], // exit on less (signed)
	13: ['lt', true], // exit on greater or equal
	14: ['gt', true], // exit on less or equal
	15: ['le', true] // exit on greater
};

const bits = (v: bigint) => v.toString(2).length;

export function follow(ins: Ins[], op: Record<string, number>, bounded: boolean, exits = true): Found[] {
	const name = Object.fromEntries(Object.entries(op).map(([k, v]) => [v, k])) as Record<number, string>;
	const v: Val[] = Array.from({ length: 64 }, (_, r) => (r === KB_ZERO ? { k: 'const', off: 0n } : { k: 'root', id: r, off: 0n }));
	// each term's interval (a vid is a computed value; -(id + 1) is a live-in register's own value)
	const ivl = new Map<number, Range>();
	let nextVid = 1;
	let flags: { b: Val; c: Val; w: number } | null = null;
	const found: Found[] = [];
	const unk = (...regs: number[]) => {
		for (const r of regs) if (r < 64 && r !== KB_ZERO) v[r] = { k: 'unk' };
	};
	const asI = (x: bigint) => BigInt.asIntN(64, x);

	const termOf = (x: Val): Range | null => {
		if (x.k === 'itv' || x.k === 'bi') return ivl.get(x.vid) ?? null;
		if (x.k === 'root') return ivl.get(-(x.id + 1)) ?? null;
		return null;
	};
	// the value's whole range when it has no live-in register in it
	const rng = (x: Val): Range | null => {
		if (x.k === 'const') return [x.off, x.off];
		if (x.k === 'itv' || (x.k === 'root' && ivl.has(-(x.id + 1)))) {
			const t = termOf(x)!;
			return [t[0] + x.off, t[1] + x.off];
		}
		return null;
	};
	const okRange = (lo: bigint, hi: bigint) => lo >= -S63 && hi <= M64 && hi - lo < LIMIT;
	const mkItv = (lo: bigint, hi: bigint): Val => {
		if (!okRange(lo, hi)) return { k: 'unk' };
		if (lo === hi) return { k: 'const', off: asI(lo) };
		const vid = nextVid++;
		ivl.set(vid, [lo, hi]);
		return { k: 'itv', vid, off: 0n };
	};
	// a value's shape: the register it is based on (or -1) and its range of offsets from that base
	const shape = (x: Val): { id: number; r: Range } | null => {
		const r = rng(x);
		if (r) return { id: -1, r };
		if (x.k === 'root') return { id: x.id, r: [x.off, x.off] };
		if (x.k === 'bi') {
			const t = ivl.get(x.vid)!;
			return { id: x.id, r: [t[0] + x.off, t[1] + x.off] };
		}
		return null;
	};
	const withOff = (x: Val, d: bigint): Val => {
		if (x.k === 'const') return { k: 'const', off: asI(x.off + d) };
		if (x.k === 'unk') return x;
		if (x.k === 'root') return { ...x, off: asI(x.off + d) };
		return { ...x, off: x.off + d };
	};
	const fromShape = (id: number, lo: bigint, hi: bigint): Val => {
		if (id < 0) return mkItv(lo, hi);
		if (lo === hi) return { k: 'root', id, off: asI(lo) };
		if (!okRange(lo, hi)) return { k: 'unk' };
		const vid = nextVid++;
		ivl.set(vid, [lo, hi]);
		return { k: 'bi', id, vid, off: 0n };
	};
	const add = (B: Val, C: Val, sub: boolean): Val => {
		if (!bounded) {
			if (B.k === 'const' && C.k === 'const') return { k: 'const', off: asI(sub ? B.off - C.off : B.off + C.off) };
			if (B.k === 'root' && C.k === 'const') return { k: 'root', id: B.id, off: asI(sub ? B.off - C.off : B.off + C.off) };
			if (!sub && B.k === 'const' && C.k === 'root') return { k: 'root', id: C.id, off: asI(B.off + C.off) };
			return { k: 'unk' };
		}
		if (C.k === 'const') return withOff(B, sub ? -C.off : C.off);
		if (!sub && B.k === 'const') return withOff(C, B.off);
		const sb = shape(B);
		const sc = shape(C);
		if (!sb || !sc) return { k: 'unk' };
		if (sub) {
			if (sc.id >= 0) return { k: 'unk' };
			return fromShape(sb.id, sb.r[0] - sc.r[1], sb.r[1] - sc.r[0]);
		}
		if (sb.id >= 0 && sc.id >= 0) return { k: 'unk' };
		return fromShape(Math.max(sb.id, sc.id), sb.r[0] + sc.r[0], sb.r[1] + sc.r[1]);
	};
	const nonneg = (r: Range | null): r is Range => !!r && r[0] >= 0n;
	// a bound that holds of the value wherever it is used from here on
	const refine = (x: Val, lo: bigint, hi: bigint) => {
		if (x.k === 'const' || x.k === 'unk' || x.k === 'bi') return;
		const key = x.k === 'root' ? -(x.id + 1) : x.vid;
		if (x.k === 'root' && x.off !== 0n) return;
		const cur = ivl.get(key) ?? [0n, M64];
		if (cur[0] + x.off < 0n) return;
		const t: Range = [lo > cur[0] + x.off ? lo : cur[0] + x.off, hi < cur[1] + x.off ? hi : cur[1] + x.off];
		if (t[0] > t[1]) return;
		ivl.set(key, [t[0] - x.off, t[1] - x.off]);
	};
	const exit = (x: Ins) => {
		if (!flags || x.imm & 0x100n) return;
		const k = KEEP[Number(x.imm & 0xffn)];
		if (!k) return;
		const [rel, signed] = k;
		const { b: B, c: C, w } = flags;
		const full = (1n << BigInt(8 * w)) - 1n;
		let rb = rng(B);
		let rc = rng(C);
		const fits = (r: Range | null, x: Val) => (r ? r[0] >= 0n && r[1] <= full : w === 8 && x.k === 'root' && x.off === 0n);
		if (!fits(rb, B) || !fits(rc, C)) return;
		if (signed && !(nonneg(rb) && nonneg(rc) && rb[1] < 1n << BigInt(8 * w - 1) && rc[1] < 1n << BigInt(8 * w - 1))) return;
		rb = rb ?? [0n, M64];
		rc = rc ?? [0n, M64];
		if (rel === 'lt') {
			refine(B, rb[0], rc[1] - 1n);
			refine(C, rb[0] + 1n, rc[1]);
		} else if (rel === 'le') {
			refine(B, rb[0], rc[1]);
			refine(C, rb[0], rc[1]);
		} else if (rel === 'gt') {
			refine(C, rc[0], rb[1] - 1n);
			refine(B, rc[0] + 1n, rb[1]);
		} else if (rel === 'ge') {
			refine(C, rc[0], rb[1]);
			refine(B, rc[0], rb[1]);
		} else if (rel === 'eq') {
			const lo = rb[0] > rc[0] ? rb[0] : rc[0];
			const hi = rb[1] < rc[1] ? rb[1] : rc[1];
			refine(B, lo, hi);
			refine(C, lo, hi);
		}
	};
	// what the ops that only compute a value leave in their destination
	const compute = (x: Ins, nm: string): Val => {
		const B = v[x.b]!;
		const C = v[x.c]!;
		if (nm === 'MOVI') return { k: 'const', off: asI(x.imm) };
		if (nm === 'MOV') return B;
		if (nm === 'ADD' || nm === 'SUB') return add(B, C, nm === 'SUB');
		if ((nm === 'ZEXT' || nm === 'SEXT') && x.w >= 8) return B;
		if (!bounded) return { k: 'unk' };
		const rb = rng(B);
		const rc = rng(C);
		const cc = C.k === 'const' ? C.off : null;
		const lim = 1n << BigInt(8 * x.w);
		switch (nm) {
			case 'ZEXT':
				if (rb && rb[0] >= 0n && rb[1] < lim) return B;
				return rb && rb[0] === rb[1] ? { k: 'const', off: rb[0] & (lim - 1n) } : mkItv(0n, lim - 1n);
			case 'SEXT':
				if (rb && rb[0] >= 0n && rb[1] < lim / 2n) return B;
				return mkItv(-lim / 2n, lim / 2n - 1n);
			case 'AND': {
				const ub = [rb, rc].filter(nonneg).map((r) => r[1]);
				if (!ub.length) return { k: 'unk' };
				const m = ub.reduce((p, q) => (q < p ? q : p));
				if (rb && rc && rb[0] === rb[1] && rc[0] === rc[1]) return { k: 'const', off: asI(rb[0] & rc[0]) };
				return mkItv(0n, m);
			}
			case 'OR':
			case 'XOR':
				if (nonneg(rb) && nonneg(rc)) return mkItv(0n, (1n << BigInt(bits(rb[1] > rc[1] ? rb[1] : rc[1]))) - 1n);
				return { k: 'unk' };
			case 'SHL':
				if (rb && cc !== null && cc >= 0n && cc < 64n) return mkItv(rb[0] << cc, rb[1] << cc);
				return { k: 'unk' };
			case 'SHR':
				if (cc === null || cc < 0n || cc >= 64n) return { k: 'unk' };
				return nonneg(rb) ? mkItv(rb[0] >> cc, rb[1] >> cc) : mkItv(0n, M64 >> cc);
			case 'SAR':
				return nonneg(rb) && cc !== null && cc >= 0n && cc < 64n ? mkItv(rb[0] >> cc, rb[1] >> cc) : { k: 'unk' };
			case 'MUL': {
				if (!rb || !rc) return { k: 'unk' };
				const p = [rb[0] * rc[0], rb[0] * rc[1], rb[1] * rc[0], rb[1] * rc[1]];
				return mkItv(p.reduce((s, t) => (t < s ? t : s)), p.reduce((s, t) => (t > s ? t : s)));
			}
			case 'UREM':
				return cc !== null && cc > 0n ? mkItv(0n, cc - 1n) : { k: 'unk' };
			case 'UDIV':
				if (cc === null || cc <= 0n) return { k: 'unk' };
				return nonneg(rb) ? mkItv(rb[0] / cc, rb[1] / cc) : mkItv(0n, M64 / cc);
			case 'SEL':
				return rb && rc ? mkItv(rb[0] < rc[0] ? rb[0] : rc[0], rb[1] > rc[1] ? rb[1] : rc[1]) : { k: 'unk' };
			case 'SETCC':
			case 'CARRY':
				return mkItv(0n, 1n);
			case 'CLZ':
			case 'CTZ':
			case 'POPCNT':
				return mkItv(0n, 64n);
			case 'BSWAP':
				return x.w < 8 ? mkItv(0n, lim - 1n) : { k: 'unk' };
		}
		return { k: 'unk' };
	};
	// ops that write register a and nothing else a later address can depend on
	const defs = new Set(['MOVI', 'MOV', 'ADD', 'SUB', 'AND', 'OR', 'XOR', 'SHL', 'SHR', 'SAR', 'ROR', 'MUL', 'UMULH', 'SMULH', 'UDIV', 'SDIV', 'UREM', 'SREM', 'ZEXT', 'SEXT', 'INS', 'SETCC', 'SEL', 'CARRY', 'BSWAP', 'CLZ', 'CTZ', 'POPCNT', 'TPIDR', 'FSBASE', 'X86SHD', 'NZCV', 'CRC32', 'CLOCK', 'EXCL']);
	// the ops that leave the flags as they are
	const keepsFlags = new Set(['MOVI', 'MOV', 'ADD', 'SUB', 'AND', 'OR', 'XOR', 'SHL', 'SHR', 'SAR', 'ROR', 'MUL', 'UMULH', 'SMULH', 'UDIV', 'SDIV', 'UREM', 'SREM', 'ZEXT', 'SEXT', 'INS', 'SETCC', 'SEL', 'CARRY', 'BSWAP', 'CLZ', 'CTZ', 'POPCNT', 'FSBASE', 'LD', 'LDS', 'ST', 'BR', 'BRZ', 'EXIT', 'RESOLVE', 'PC']);

	for (const [i, x] of ins.entries()) {
		const nm = name[x.op]!;
		if (bounded && nm !== 'FLAGS' && !keepsFlags.has(nm)) flags = null;
		if (nm === 'LD' || nm === 'LDS' || nm === 'ST') {
			const B = v[x.b]!;
			const store = nm === 'ST';
			const at = (id: number, lo: bigint, hi: bigint) => found.push({ i, store, w: x.w, root: id, lo, hi });
			if (B.k === 'const') at(-1, asI(B.off + x.imm), asI(B.off + x.imm));
			else if (B.k === 'root' && !ivl.has(-(B.id + 1)) && B.id < KB_T0) at(B.id, asI(B.off + x.imm), asI(B.off + x.imm));
			else if (bounded) {
				const s = shape(B);
				if (s && s.id < KB_T0) at(s.id, s.r[0] + x.imm, s.r[1] + x.imm);
			}
			if (!store) {
				if (bounded && x.w < 8) v[x.a] = nm === 'LD' ? mkItv(0n, (1n << BigInt(8 * x.w)) - 1n) : mkItv(-(1n << BigInt(8 * x.w - 1)), (1n << BigInt(8 * x.w - 1)) - 1n);
				else unk(x.a);
			}
			continue;
		}
		if (nm === 'FLAGS') {
			flags = bounded && x.imm === F_SUB ? { b: v[x.b]!, c: v[x.c]!, w: x.w } : null;
			continue;
		}
		if (nm === 'EXIT') {
			if (bounded && exits) exit(x);
			continue;
		}
		if (nm === 'SYSCALL') unk(0, 1, 11);
		else if (nm === 'X86MD') unk(0, 2);
		else if (nm === 'CPUID') unk(0, 1, 2, 3);
		else if (nm === 'X86STR') unk(7, 6, 1);
		else if (nm === 'SSE') {
			const code = Number(x.imm & 0xffn);
			const pre = Number((x.imm >> 8n) & 0xffn);
			if ([0x2c, 0x2d, 0x50, 0xc5, 0xd7].includes(code)) unk(x.a & 15);
			if (code === 0x7e && pre === 0x66 && !(x.c & 0x80)) unk(x.c & 15);
		} else if (nm === 'X87') {
			if (Number(x.imm & 0xffffn) === 0xdfe0) unk(0);
		} else if (nm === 'X86FLAGS') {
			if (x.imm === 0n) unk(x.a);
		} else if (defs.has(nm) && x.a !== KB_ZERO) v[x.a] = compute(x, nm);
	}
	return found;
}
