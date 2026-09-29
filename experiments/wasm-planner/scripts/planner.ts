import { readFileSync, writeFileSync } from 'node:fs';

/**
 * A wasm to wasm planner: `planner.ts <in.wasm> <out.wasm>` prints the ops removed as JSON.
 *
 * Runs over each function body before an interpreter generates ops from it: constant propagation
 * and folding, branch pruning, unreachable paths, dead locals, fixed globals, unused blocks and
 * functions that nothing can reach. Every rewrite keeps the module's behaviour; a function using
 * an instruction this decoder does not know is left alone and counted in `skipped`.
 */

// #region encoding
export interface Ins {
	op: number;
	a?: number;
	b?: number;
	/** i32 and i64 constants, signed */
	v?: bigint;
	/** block types, f32 and f64 constants, select's type vector */
	raw?: number[];
	/** br_table's targets, the default last */
	list?: number[];
}

class Reader {
	p = 0;
	b: Uint8Array;
	constructor(b: Uint8Array) {
		this.b = b;
	}
	u8() {
		if (this.p >= this.b.length) throw new Error('unexpected end');
		return this.b[this.p++]!;
	}
	u32() {
		let v = 0;
		for (let s = 0; ; s += 7) {
			const c = this.u8();
			v += (c & 0x7f) * 2 ** s;
			if (!(c & 0x80)) return v;
		}
	}
	signed(): bigint {
		let v = 0n;
		for (let s = 0n; ; s += 7n) {
			const c = this.u8();
			v |= BigInt(c & 0x7f) << s;
			if (!(c & 0x80)) return c & 0x40 ? v - (1n << (s + 7n)) : v;
		}
	}
	take(n: number) {
		const out = this.b.subarray(this.p, this.p + n);
		if (out.length !== n) throw new Error('unexpected end');
		this.p += n;
		return out;
	}
	get done() {
		return this.p >= this.b.length;
	}
}

export const u32 = (n: number) => {
	const out: number[] = [];
	do {
		const c = n % 128;
		n = Math.floor(n / 128);
		out.push(n ? c | 0x80 : c);
	} while (n);
	return out;
};

const signed = (v: bigint) => {
	const out: number[] = [];
	for (;;) {
		const c = Number(v & 0x7fn);
		v >>= 7n;
		if ((v === 0n && !(c & 0x40)) || (v === -1n && c & 0x40)) return [...out, c];
		out.push(c | 0x80);
	}
};

const vec = (items: number[][]) => [...u32(items.length), ...items.flat()];
const OPEN = new Set([0x02, 0x03, 0x04]);
const isConst = (i?: Ins) => !!i && i.op >= 0x41 && i.op <= 0x44;
export const i32c = (v: bigint | number): Ins => ({ op: 0x41, v: BigInt.asIntN(32, BigInt(v)) });
const i64c = (v: bigint): Ins => ({ op: 0x42, v: BigInt.asIntN(64, v) });

function decode(r: Reader): Ins {
	const op = r.u8();
	if (OPEN.has(op)) {
		const first = r.b[r.p]!;
		if (first >= 0x40 && !(first & 0x80)) return { op, raw: [r.u8()] };
		const raw: number[] = [];
		for (;;) {
			const c = r.u8();
			raw.push(c);
			if (!(c & 0x80)) return { op, raw };
		}
	}
	if (op === 0x0c || op === 0x0d || op === 0x10 || (op >= 0x20 && op <= 0x24)) return { op, a: r.u32() };
	if (op === 0x0e) {
		const n = r.u32();
		return { op, list: Array.from({ length: n + 1 }, () => r.u32()) };
	}
	if (op === 0x11) return { op, a: r.u32(), b: r.u32() };
	if (op === 0x1c) {
		const n = r.u32();
		return { op, raw: [...r.take(n)] };
	}
	if (op >= 0x28 && op <= 0x3e) return { op, a: r.u32(), b: r.u32() };
	if (op === 0x3f || op === 0x40) return { op, a: r.u8() };
	if (op === 0x41) return { op, v: BigInt.asIntN(32, r.signed()) };
	if (op === 0x42) return { op, v: BigInt.asIntN(64, r.signed()) };
	if (op === 0x43) return { op, raw: [...r.take(4)] };
	if (op === 0x44) return { op, raw: [...r.take(8)] };
	const plain = [0x00, 0x01, 0x05, 0x0b, 0x0f, 0x1a, 0x1b];
	if ((op <= 0x1f && !plain.includes(op)) || op === 0x25 || op === 0x26 || op === 0x27 || op > 0xc4) throw new Error(`opcode ${op}`);
	return { op };
}

export function encode(i: Ins): number[] {
	const { op } = i;
	if (OPEN.has(op) || op === 0x43 || op === 0x44) return [op, ...i.raw!];
	if (op === 0x1c) return [op, ...u32(i.raw!.length), ...i.raw!];
	if (op === 0x0e) return [op, ...u32(i.list!.length - 1), ...i.list!.flatMap(u32)];
	if (op === 0x11 || (op >= 0x28 && op <= 0x3e)) return [op, ...u32(i.a!), ...u32(i.b!)];
	if (op === 0x3f || op === 0x40) return [op, i.a!];
	if (op === 0x41 || op === 0x42) return [op, ...signed(i.v!)];
	if (i.a !== undefined) return [op, ...u32(i.a)];
	return [op];
}
// #endregion

// #region module
interface Section {
	id: number;
	body: Uint8Array;
}

interface Func {
	params: number[];
	results: number;
	locals: number[];
	code: Ins[];
	/** the body as it was; used when this function is skipped */
	raw: Uint8Array;
	skipped?: string;
}

export interface Stats {
	functions: number;
	skipped: number;
	deadFunctions: number;
	opsBefore: number;
	opsAfter: number;
	bytesBefore: number;
	bytesAfter: number;
	localsBefore: number;
	localsAfter: number;
	folded: number;
	propagated: number;
	branchesPruned: number;
	unreachableRemoved: number;
	deadLocalWrites: number;
	fixedGlobalReads: number;
	blocksUnwrapped: number;
	dropPairs: number;
}

const zero = (t: number): Ins =>
	t === 0x7f ? i32c(0) : t === 0x7e ? i64c(0n) : t === 0x7d ? { op: 0x43, raw: [0, 0, 0, 0] } : { op: 0x44, raw: Array(8).fill(0) };

function sections(bytes: Uint8Array) {
	if (bytes.length < 8 || bytes[0] !== 0 || bytes[1] !== 0x61 || bytes[2] !== 0x73 || bytes[3] !== 0x6d) throw new Error('not wasm');
	const r = new Reader(bytes);
	r.p = 8;
	const out: Section[] = [];
	while (!r.done) {
		const id = r.u8();
		out.push({ id, body: r.take(r.u32()) });
	}
	return out;
}

function limits(r: Reader) {
	const flag = r.u8();
	if (flag > 3) throw new Error('memory64 or unknown limits');
	r.u32();
	if (flag & 1) r.u32();
}

function skipExpr(r: Reader) {
	const i = decode(r);
	if (!isConst(i) && i.op !== 0x23) throw new Error('constant expression');
	if (r.u8() !== 0x0b) throw new Error('extended constant expression');
	return i;
}

const decodeBody = (bytes: Uint8Array, types: number[]): Pick<Func, 'locals' | 'code'> => {
	const r = new Reader(bytes);
	const locals: number[] = [...types];
	for (let n = r.u32(); n > 0; n--) {
		const count = r.u32();
		const t = r.u8();
		for (let k = 0; k < count; k++) locals.push(t);
	}
	const code: Ins[] = [];
	while (!r.done) code.push(decode(r));
	return { locals: locals.slice(types.length), code };
};

const body = (locals: number[], code: Ins[]) => {
	const groups: number[][] = [];
	for (const t of locals) {
		const g = groups.at(-1);
		if (g && g[1] === t) g[0]!++;
		else groups.push([1, t]);
	}
	return Uint8Array.from([...vec(groups.map(([n, t]) => [...u32(n!), t!])), ...code.flatMap(encode)]);
};

/** the name section without its local names (locals are renumbered); any other custom section goes */
function functionNames(payload: Uint8Array) {
	const r = new Reader(payload);
	const label = new TextDecoder().decode(r.take(r.u32()));
	if (label !== 'name') return new Uint8Array();
	const keep: number[] = [...u32(4), ...new TextEncoder().encode('name')];
	while (!r.done) {
		const id = r.u8();
		const sub = r.take(r.u32());
		if (id === 0 || id === 1) keep.push(id, ...u32(sub.length), ...sub);
	}
	return Uint8Array.from(keep);
}

/** plans `bytes`; `only` restricts the passes that run, for tests */
export function plan(bytes: Uint8Array, only?: Set<string>): { bytes: Uint8Array<ArrayBuffer>; stats: Stats } {
	const secs = sections(bytes);
	const find = (id: number) => secs.find((s) => s.id === id);
	const typeRows: { params: number[]; results: number }[] = [];
	const ts = find(1);
	if (ts) {
		const r = new Reader(ts.body);
		for (let n = r.u32(); n > 0; n--) {
			if (r.u8() !== 0x60) throw new Error('type form');
			const params = [...r.take(r.u32())];
			typeRows.push({ params, results: r.u32() });
			r.p += typeRows.at(-1)!.results;
		}
	}
	let importedFuncs = 0;
	let importedGlobals = 0;
	const is = find(2);
	if (is) {
		const r = new Reader(is.body);
		for (let n = r.u32(); n > 0; n--) {
			r.take(r.u32());
			r.take(r.u32());
			const kind = r.u8();
			if (kind === 0) {
				r.u32();
				importedFuncs++;
			} else if (kind === 1) {
				r.u8();
				limits(r);
			} else if (kind === 2) limits(r);
			else if (kind === 3) {
				r.u8();
				r.u8();
				importedGlobals++;
			} else throw new Error('tag import');
		}
	}
	const funcTypes: number[] = [];
	const fs = find(3);
	if (fs) {
		const r = new Reader(fs.body);
		for (let n = r.u32(); n > 0; n--) funcTypes.push(r.u32());
	}
	const globals: { mutable: boolean; init: Ins | null }[] = [];
	const gs = find(6);
	if (gs) {
		const r = new Reader(gs.body);
		for (let n = r.u32(); n > 0; n--) {
			r.u8();
			const mutable = r.u8() === 1;
			let init: Ins | null = null;
			try {
				init = skipExpr(r);
			} catch {
				throw new Error('global initialiser this planner does not read');
			}
			globals.push({ mutable, init: isConst(init) ? init : null });
		}
	}
	const roots = new Set<number>();
	let everything = false;
	const exportedGlobals = new Set<number>();
	const es = find(7);
	if (es) {
		const r = new Reader(es.body);
		for (let n = r.u32(); n > 0; n--) {
			r.take(r.u32());
			const kind = r.u8();
			const idx = r.u32();
			if (kind === 0) roots.add(idx);
			else if (kind === 3) exportedGlobals.add(idx);
		}
	}
	const ss = find(8);
	if (ss) roots.add(new Reader(ss.body).u32());
	const els = find(9);
	if (els) {
		try {
			const r = new Reader(els.body);
			for (let n = r.u32(); n > 0; n--) {
				if (r.u32() !== 0) throw new Error('elem form');
				skipExpr(r);
				for (let k = r.u32(); k > 0; k--) roots.add(r.u32());
			}
		} catch {
			everything = true;
		}
	}
	const cs = find(10);
	if (!cs) throw new Error('no code section');
	const funcs: Func[] = [];
	{
		const r = new Reader(cs.body);
		const n = r.u32();
		if (n !== funcTypes.length) throw new Error('function and code counts differ');
		for (let k = 0; k < n; k++) {
			const raw = r.take(r.u32());
			const row = typeRows[funcTypes[k]!]!;
			const f: Func = { params: row.params, results: row.results, locals: [], code: [], raw };
			try {
				Object.assign(f, decodeBody(raw, row.params));
			} catch (e) {
				f.skipped = (e as Error).message;
			}
			funcs.push(f);
		}
	}

	const stats: Stats = {
		functions: funcs.length,
		skipped: funcs.filter((f) => f.skipped).length,
		deadFunctions: 0,
		opsBefore: funcs.reduce((s, f) => s + f.code.length, 0),
		opsAfter: 0,
		bytesBefore: funcs.reduce((s, f) => s + f.raw.length, 0),
		bytesAfter: 0,
		localsBefore: funcs.reduce((s, f) => s + f.locals.length, 0),
		localsAfter: 0,
		folded: 0,
		propagated: 0,
		branchesPruned: 0,
		unreachableRemoved: 0,
		deadLocalWrites: 0,
		fixedGlobalReads: 0,
		blocksUnwrapped: 0,
		dropPairs: 0
	};
	const on = (name: string) => !only || only.has(name);

	// a global is fixed when nothing writes it, in the module or from outside
	const written = new Set<number>(exportedGlobals);
	for (const f of funcs) for (const i of f.code) if (i.op === 0x24) written.add(i.a!);
	const fixed = new Map<number, Ins>();
	globals.forEach((g, k) => {
		const idx = importedGlobals + k;
		if (g.init && !written.has(idx) && !(g.mutable && exportedGlobals.has(idx))) fixed.set(idx, g.init);
	});

	// functions nothing reaches
	const live = new Set<number>();
	if (on('deadfunc') && !everything && !funcs.some((f) => f.skipped)) {
		const work = [...roots];
		while (work.length) {
			const idx = work.pop()!;
			if (live.has(idx)) continue;
			live.add(idx);
			const f = funcs[idx - importedFuncs];
			if (f) for (const i of f.code) if (i.op === 0x10) work.push(i.a!);
		}
	}

	for (const [k, f] of funcs.entries()) {
		if (f.skipped) continue;
		if (on('deadfunc') && live.size && !live.has(importedFuncs + k)) {
			stats.deadFunctions++;
			f.locals = [];
			f.code = [{ op: 0x00 }, { op: 0x0b }];
			continue;
		}
		planFunction(f, fixed, stats, on);
	}

	const out = [0, 0x61, 0x73, 0x6d, 1, 0, 0, 0];
	const newBodies = funcs.map((f) => (f.skipped ? f.raw : body(f.locals, f.code)));
	for (const [k, f] of funcs.entries()) {
		stats.opsAfter += f.skipped ? 0 : f.code.length;
		stats.bytesAfter += newBodies[k]!.length;
		stats.localsAfter += f.locals.length;
	}
	for (const s of secs) {
		const payload = s.id === 10 ? Uint8Array.from(vec(newBodies.map((b) => [...u32(b.length), ...b]))) : s.id === 0 ? functionNames(s.body) : s.body;
		if (s.id === 0 && !payload.length) continue;
		out.push(s.id, ...u32(payload.length));
		for (const b of payload) out.push(b);
	}
	return { bytes: Uint8Array.from(out), stats };
}
// #endregion

// #region passes
const CMP32 = ['eq', 'ne', 'lt_s', 'lt_u', 'gt_s', 'gt_u', 'le_s', 'le_u', 'ge_s', 'ge_u'];
const ARITH = ['add', 'sub', 'mul', 'div_s', 'div_u', 'rem_s', 'rem_u', 'and', 'or', 'xor', 'shl', 'shr_s', 'shr_u', 'rotl', 'rotr'];

const bits = (x: bigint) => (x === 0n ? 0 : x.toString(2).length);

function foldUnary(op: number, x: Ins): Ins | null {
	const v = x.v!;
	const u = (w: number) => BigInt.asUintN(w, v);
	if (x.op === 0x41) {
		if (op === 0x45) return i32c(v === 0n ? 1 : 0);
		if (op === 0x67) return i32c(32 - bits(u(32)));
		if (op === 0x68) return i32c(u(32) === 0n ? 32 : bits(u(32) & -u(32)) - 1);
		if (op === 0x69) return i32c([...u(32).toString(2)].filter((c) => c === '1').length);
		if (op === 0xc0) return i32c(BigInt.asIntN(8, v));
		if (op === 0xc1) return i32c(BigInt.asIntN(16, v));
		if (op === 0xac) return i64c(v);
		if (op === 0xad) return i64c(u(32));
		return null;
	}
	if (x.op === 0x42) {
		if (op === 0x50) return i32c(v === 0n ? 1 : 0);
		if (op === 0x79) return i64c(BigInt(64 - bits(u(64))));
		if (op === 0x7a) return i64c(u(64) === 0n ? 64n : BigInt(bits(u(64) & -u(64)) - 1));
		if (op === 0x7b) return i64c(BigInt([...u(64).toString(2)].filter((c) => c === '1').length));
		if (op === 0xa7) return i32c(v);
		if (op === 0xc2) return i64c(BigInt.asIntN(8, v));
		if (op === 0xc3) return i64c(BigInt.asIntN(16, v));
		if (op === 0xc4) return i64c(BigInt.asIntN(32, v));
	}
	return null;
}

function foldBinary(op: number, x: Ins, y: Ins): Ins | null {
	const wide = x.op === 0x42;
	const w = wide ? 64 : 32;
	const mk = wide ? i64c : i32c;
	const base = wide ? 0x51 : 0x46;
	const arith = wide ? 0x7c : 0x6a;
	const [a, b] = [x.v!, y.v!];
	const [ua, ub] = [BigInt.asUintN(w, a), BigInt.asUintN(w, b)];
	if (op >= base && op < base + 10) {
		const k = CMP32[op - base]!;
		const r =
			k === 'eq' ? a === b
			: k === 'ne' ? a !== b
			: k === 'lt_s' ? a < b
			: k === 'lt_u' ? ua < ub
			: k === 'gt_s' ? a > b
			: k === 'gt_u' ? ua > ub
			: k === 'le_s' ? a <= b
			: k === 'le_u' ? ua <= ub
			: k === 'ge_s' ? a >= b
			: ua >= ub;
		return i32c(r ? 1 : 0);
	}
	if (op < arith || op >= arith + 15) return null;
	const k = ARITH[op - arith]!;
	const sh = BigInt(Number(ub % BigInt(w)));
	const min = -(1n << BigInt(w - 1));
	switch (k) {
		case 'add': return mk(a + b);
		case 'sub': return mk(a - b);
		case 'mul': return mk(a * b);
		case 'div_s': return b === 0n || (a === min && b === -1n) ? null : mk(a / b);
		case 'div_u': return ub === 0n ? null : mk(ua / ub);
		case 'rem_s': return b === 0n ? null : mk(a % b);
		case 'rem_u': return ub === 0n ? null : mk(ua % ub);
		case 'and': return mk(a & b);
		case 'or': return mk(a | b);
		case 'xor': return mk(a ^ b);
		case 'shl': return mk(ua << sh);
		case 'shr_s': return mk(a >> sh);
		case 'shr_u': return mk(ua >> sh);
		case 'rotl': return mk((ua << sh) | (ua >> (BigInt(w) - sh)));
		default: return mk((ua >> sh) | (ua << (BigInt(w) - sh)));
	}
}

const UNARY = new Set([0x45, 0x67, 0x68, 0x69, 0xc0, 0xc1, 0xac, 0xad, 0x50, 0x79, 0x7a, 0x7b, 0xa7, 0xc2, 0xc3, 0xc4]);
const isInt = (i?: Ins) => !!i && (i.op === 0x41 || i.op === 0x42);

/** the block, loop or if at `at` and its else and end */
function span(code: (Ins | null)[], at: number) {
	let depth = 0;
	let other = -1;
	for (let k = at; k < code.length; k++) {
		const i = code[k];
		if (!i) continue;
		if (OPEN.has(i.op)) depth++;
		else if (i.op === 0x05 && depth === 1) other = k;
		else if (i.op === 0x0b && --depth === 0) return { other, end: k };
	}
	throw new Error('unbalanced');
}

function planFunction(f: Func, fixed: Map<number, Ins>, s: Stats, on: (n: string) => boolean) {
	const nparams = f.params.length;
	const type = (idx: number) => (idx < nparams ? f.params[idx]! : f.locals[idx - nparams]!);

	const unreachable = () => {
		const out: Ins[] = [];
		let skip = 0;
		let dead = false;
		for (const i of f.code) {
			if (dead) {
				if (OPEN.has(i.op)) skip++;
				else if (i.op === 0x0b && skip > 0) skip--;
				else if ((i.op === 0x0b || i.op === 0x05) && skip === 0) {
					dead = false;
					out.push(i);
				}
				if (dead) s.unreachableRemoved++;
				continue;
			}
			out.push(i);
			if (i.op === 0x00 || i.op === 0x0c || i.op === 0x0e || i.op === 0x0f) dead = true;
		}
		const changed = out.length !== f.code.length;
		f.code = out;
		return changed;
	};

	const prune = () => {
		const code: (Ins | null)[] = [...f.code];
		let changed = false;
		for (let k = 0; k + 1 < code.length; k++) {
			const c = code[k];
			const n = code[k + 1];
			if (!c || !n || c.op !== 0x41) continue;
			const truthy = c.v !== 0n;
			if (n.op === 0x04) {
				const { other, end } = span(code, k + 1);
				code[k] = null;
				code[k + 1] = { op: 0x02, raw: n.raw };
				const drop = truthy ? [other >= 0 ? other : end, end] : [k + 2, other >= 0 ? other + 1 : end];
				for (let d = drop[0]!; d < drop[1]!; d++) code[d] = null;
			} else if (n.op === 0x0d) {
				code[k] = null;
				code[k + 1] = truthy ? { op: 0x0c, a: n.a } : null;
			} else if (n.op === 0x0e) {
				const at = c.v! >= 0n && c.v! < BigInt(n.list!.length - 1) ? Number(c.v) : n.list!.length - 1;
				code[k] = null;
				code[k + 1] = { op: 0x0c, a: n.list![at] };
			} else continue;
			changed = true;
			s.branchesPruned++;
		}
		f.code = code.filter((i): i is Ins => !!i);
		return changed;
	};

	const propagate = () => {
		let changed = false;
		const known = new Map<number, Ins>();
		f.locals.forEach((t, k) => known.set(nparams + k, zero(t)));
		const out: Ins[] = [];
		for (const i of f.code) {
			if (i.op === 0x03 || i.op === 0x05 || i.op === 0x0b) known.clear();
			let next = i;
			if (i.op === 0x20 && known.has(i.a!)) {
				next = { ...known.get(i.a!)! };
				s.propagated++;
				changed = true;
			} else if (i.op === 0x23 && fixed.has(i.a!)) {
				next = { ...fixed.get(i.a!)! };
				s.fixedGlobalReads++;
				changed = true;
			} else if (i.op === 0x21 || i.op === 0x22) {
				const top = out.at(-1);
				if (isConst(top)) known.set(i.a!, top!);
				else known.delete(i.a!);
			}
			out.push(next);
			if (UNARY.has(next.op) && isInt(out.at(-2))) {
				const r = foldUnary(next.op, out.at(-2)!);
				if (r) {
					out.splice(-2, 2, r);
					s.folded++;
					changed = true;
				}
			} else if (isInt(out.at(-2)) && isInt(out.at(-3)) && out.at(-2)!.op === out.at(-3)!.op) {
				const r = foldBinary(next.op, out.at(-3)!, out.at(-2)!);
				if (r) {
					out.splice(-3, 3, r);
					s.folded++;
					changed = true;
				}
			}
		}
		f.code = out;
		return changed;
	};

	const drops = () => {
		const out: Ins[] = [];
		let changed = false;
		for (const i of f.code) {
			const top = out.at(-1);
			if (i.op === 0x1a && top && (isConst(top) || top.op === 0x20 || top.op === 0x23)) {
				out.pop();
				s.dropPairs++;
				changed = true;
			} else if (i.op === 0x1a && top?.op === 0x22) {
				out[out.length - 1] = { op: 0x21, a: top.a };
				s.dropPairs++;
				changed = true;
			} else out.push(i);
		}
		f.code = out;
		return changed;
	};

	const deadLocals = () => {
		const read = new Set<number>();
		for (const i of f.code) if (i.op === 0x20) read.add(i.a!);
		const out: Ins[] = [];
		let changed = false;
		for (const i of f.code) {
			if ((i.op === 0x21 || i.op === 0x22) && !read.has(i.a!)) {
				if (i.op === 0x21) out.push({ op: 0x1a });
				s.deadLocalWrites++;
				changed = true;
			} else out.push(i);
		}
		f.code = out;
		// drop the declarations nothing touches and renumber the rest
		const used = new Set<number>();
		for (const i of f.code) if (i.op >= 0x20 && i.op <= 0x22) used.add(i.a!);
		const map = new Map<number, number>();
		const kept: number[] = [];
		f.locals.forEach((t, k) => {
			if (used.has(nparams + k)) {
				map.set(nparams + k, nparams + kept.length);
				kept.push(t);
			}
		});
		if (kept.length !== f.locals.length) {
			for (const i of f.code) if (i.op >= 0x20 && i.op <= 0x22 && i.a! >= nparams) i.a = map.get(i.a!)!;
			f.locals = kept;
			changed = true;
		}
		return changed;
	};

	// a block or loop nothing branches to is its body
	const unwrap = () => {
		const labels: { at: number; used: boolean }[] = [{ at: -1, used: true }];
		const info = new Map<number, boolean>();
		f.code.forEach((i, k) => {
			if (OPEN.has(i.op)) labels.push({ at: k, used: i.op === 0x04 });
			else if (i.op === 0x0b) {
				const l = labels.pop()!;
				if (l.at >= 0) info.set(l.at, l.used);
			} else if (i.op === 0x0c || i.op === 0x0d)
				labels[labels.length - 1 - i.a!]!.used = true;
			else if (i.op === 0x0e) for (const d of i.list!) labels[labels.length - 1 - d]!.used = true;
		});
		if (![...info.values()].some((u) => !u)) return false;
		const out: Ins[] = [];
		const stack: { at: number; removed: boolean }[] = [{ at: -1, removed: false }];
		// retargets a depth over the labels that stay inside it
		const fix = (d: number) => stack.slice(stack.length - d).filter((l) => !l.removed).length;
		f.code.forEach((i, k) => {
			if (OPEN.has(i.op)) {
				const removed = info.get(k) === false;
				stack.push({ at: k, removed });
				if (removed) s.blocksUnwrapped++;
				else out.push(i);
			} else if (i.op === 0x0b) {
				const l = stack.pop()!;
				if (!l.removed) out.push(i);
			} else if (i.op === 0x0c || i.op === 0x0d) out.push({ ...i, a: fix(i.a!) });
			else if (i.op === 0x0e) out.push({ ...i, list: i.list!.map(fix) });
			else out.push(i);
		});
		f.code = out;
		return true;
	};

	const passes: [string, () => boolean][] = [
		['unreachable', unreachable],
		['prune', prune],
		['propagate', propagate],
		['drops', drops],
		['deadlocals', deadLocals],
		['unwrap', unwrap]
	];
	for (let round = 0; round < 20; round++) {
		let changed = false;
		for (const [name, pass] of passes) if (on(name)) changed = pass() || changed;
		if (!changed) break;
	}
}
// #endregion

if (process.argv[1]?.endsWith('planner.ts')) {
	const [input, output] = process.argv.slice(2);
	if (!input || !output) throw new Error('usage: planner.ts <in.wasm> <out.wasm>');
	const { bytes, stats } = plan(readFileSync(input));
	writeFileSync(output, bytes);
	console.log(JSON.stringify(stats, null, '\t'));
}
