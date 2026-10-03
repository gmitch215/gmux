/**
 * Stack slots for lift.ts --slots. A slot is an rsp-relative access (width and offset fixed) that a
 * region keeps in a wasm local on top of the memory it still writes to (write-through), so the
 * memory every observer sees (a callee, a signal frame, a syscall, a fault, the interpreter) is
 * never stale. What the analysis decides, per region:
 *
 * - which blocks share a frame: blocks joined by a direct edge whose rsp change is a constant
 *   (`at` is the block's entry rsp relative to the frame base `fb`); any other edge starts a frame
 * - one window of the frame (a span the memory plan's size) holding the slots; an access outside
 *   it stays a checked access
 * - which slots each block needs loaded at its entry (`need`), so an edge into it from a block
 *   that has not touched them loads them on the edge
 *
 * An unknown store (an address the analysis does not see as rsp-relative) is checked against the
 * window after it happens, and the slots valid at that point are read again if it hit.
 */
export interface Ins {
	op: number;
	w: number;
	a: number;
	b: number;
	c: number;
	imm: bigint;
}
export interface BlockIn {
	pc: bigint;
	next: bigint;
	target: bigint;
	runs: bigint;
	ins: Ins[];
}
export interface Env {
	name: (op: number) => string;
	rw: (x: Ins) => { r: number[]; w: number[] };
	sp: number;
	zero: number;
	span: number;
	maxSlots: number;
}

type Val = { k: 'sp' | 'const'; off: bigint } | { k: 'unk' };
export interface Access {
	off: number;
	len: number;
	kind: 'ld' | 'st' | 'vec';
}
export interface Exit {
	i: number; // op index, -1 for the block's end
	to: bigint | null;
	d: number | null; // rsp at the exit, relative to the block's entry
}
export interface BlockSym {
	acc: Map<number, Access>;
	exits: Exit[];
	syscall: boolean;
}

const clobbers = (name: string, x: Ins): number[] => {
	if (name === 'SYSCALL') return [0, 1, 11];
	if (name === 'X86MD') return [0, 2];
	if (name === 'X86STR') return [7, 6, 1];
	if (name === 'SSE') {
		const code = Number(x.imm & 0xffn);
		const out: number[] = [];
		if ([0x2c, 0x2d, 0x50, 0xc5, 0xd7].includes(code)) out.push(x.a & 15);
		if (code === 0x7e && Number((x.imm >> 8n) & 0xffn) === 0x66 && !(x.c & 0x80)) out.push(x.c & 15);
		return out;
	}
	if (name === 'X87') return Number(x.imm & 0xffffn) === 0xdfe0 ? [0] : [];
	return [];
};

// bytes an SSE or x87 op with a memory operand may write (sse.c, x87.c); 0 for a load
export function vecWrite(name: string, x: Ins): number {
	if (!(x.c & 0x80)) return 0;
	if (name === 'SSE') {
		const code = Number(x.imm & 0xffn);
		if (code === 0xae) return 512;
		return [0x11, 0x13, 0x17, 0x29, 0x2b, 0x7e, 0x7f, 0xd6, 0xe7].includes(code) ? 16 : 0;
	}
	if (name !== 'X87') return 0;
	const opcode = Number((x.imm >> 8n) & 0xffn);
	const reg = Number((x.imm >> 3n) & 7n);
	if (![0xd9, 0xdb, 0xdd, 0xdf].includes(opcode) || ![1, 2, 3, 6, 7].includes(reg)) return 0;
	return reg === 6 ? 108 : 16;
}

export function symbolic(b: BlockIn, env: Env): BlockSym {
	const v: Val[] = Array.from({ length: 64 }, (_, r) => (r === env.sp ? { k: 'sp', off: 0n } : r === env.zero ? { k: 'const', off: 0n } : { k: 'unk' }));
	const set = (r: number, val: Val) => {
		if (r !== env.zero && r < 64) v[r] = val;
	};
	const unk = (...rs: number[]) => rs.forEach((r) => set(r, { k: 'unk' }));
	const add = (p: bigint, q: bigint, sub = false) => BigInt.asIntN(64, sub ? p - q : p + q);
	const out: BlockSym = { acc: new Map(), exits: [], syscall: false };
	const delta = () => (v[env.sp]!.k === 'sp' ? Number((v[env.sp] as { off: bigint }).off) : null);
	for (const [i, x] of b.ins.entries()) {
		const name = env.name(x.op);
		if (name === 'LD' || name === 'LDS' || name === 'ST') {
			const B = v[x.b]!;
			if (B.k === 'sp') out.acc.set(i, { off: Number(add(B.off, x.imm)), len: x.w, kind: name === 'ST' ? 'st' : 'ld' });
			if (name !== 'ST') unk(x.a);
			continue;
		}
		const wide = vecWrite(name, x);
		if (wide && v[x.b]!.k === 'sp') out.acc.set(i, { off: Number((v[x.b] as { off: bigint }).off), len: wide, kind: 'vec' });
		if (name === 'BR' || name === 'BRZ') out.exits.push({ i, to: b.target, d: delta() });
		else if (name === 'EXIT') out.exits.push({ i, to: BigInt.asUintN(64, b.pc + BigInt.asIntN(32, x.imm >> 16n)), d: delta() });
		else if (name === 'JMP') {
			const B = v[x.b]!;
			out.exits.push({ i, to: B.k === 'const' ? BigInt.asUintN(64, B.off) : null, d: delta() });
		}
		if (name === 'SYSCALL') out.syscall = true;
		const extra = clobbers(name, x);
		if (extra.length) {
			unk(...extra);
			continue;
		}
		for (const a of env.rw(x).w) {
			const B = v[x.b]!;
			const C = v[x.c]!;
			if (name === 'MOVI') set(a, { k: 'const', off: BigInt.asIntN(64, x.imm) });
			else if (name === 'MOV') set(a, B);
			else if (name === 'ADD' || name === 'SUB') {
				const sub = name === 'SUB';
				if (B.k === 'const' && C.k === 'const') set(a, { k: 'const', off: add(B.off, C.off, sub) });
				else if (B.k === 'sp' && C.k === 'const') set(a, { k: 'sp', off: add(B.off, C.off, sub) });
				else if (!sub && B.k === 'const' && C.k === 'sp') set(a, { k: 'sp', off: add(B.off, C.off) });
				else unk(a);
			} else if ((name === 'ZEXT' || name === 'SEXT') && x.w >= 8) set(a, B);
			else unk(a);
		}
	}
	const last = b.ins.at(-1);
	if (!last || (env.name(last.op) !== 'JMP' && env.name(last.op) !== 'SYSCALL')) out.exits.push({ i: -1, to: b.next, d: delta() });
	return out;
}

export interface Slot {
	id: number;
	comp: number;
	off: number;
	w: number;
}
export type Cls = { t: 'slot'; slot: number } | { t: 'win'; off: number } | { t: 'part' | 'vec'; kill: number[] } | { t: 'out' };

export interface Plan {
	sym: BlockSym[];
	promoted: boolean[];
	comp: number[];
	at: number[];
	wins: { lo: number; hi: number }[];
	slots: Slot[];
	need: number[][];
	cls: (j: number, i: number) => Cls | undefined;
	edge: (j: number, k: number, d: number | null) => 'carry' | 'stub' | 'plain';
	overlapping: (comp: number, off: number, len: number) => number[];
}

// the heaviest accesses that fit in one window
function bestWindow(list: { off: number; len: number; wt: number }[], span: number): { lo: number; hi: number } | undefined {
	const s = [...list].sort((p, q) => p.off - q.off);
	let best = -1;
	let win: { lo: number; hi: number } | undefined;
	for (let i = 0; i < s.length; i++) {
		let wt = 0;
		let hi = s[i]!.off;
		for (let k = i; k < s.length && s[k]!.off + s[k]!.len - s[i]!.off <= span; k++) {
			wt += s[k]!.wt;
			hi = Math.max(hi, s[k]!.off + s[k]!.len);
		}
		if (wt > best) {
			best = wt;
			win = { lo: s[i]!.off, hi };
		}
	}
	return win;
}

export function analyze(blocks: BlockIn[], index: Map<bigint, number>, env: Env): Plan {
	const sym = blocks.map((b) => symbolic(b, env));
	const n = blocks.length;
	const comp = Array<number>(n).fill(-1);
	const at = Array<number>(n).fill(0);
	const eligible = sym.map((s) => !s.syscall);
	let nc = 0;
	for (const j0 of blocks.map((_, j) => j).sort((p, q) => (blocks[q]!.runs > blocks[p]!.runs ? 1 : blocks[q]!.runs < blocks[p]!.runs ? -1 : p - q))) {
		if (!eligible[j0] || comp[j0]! >= 0) continue;
		comp[j0] = nc;
		const queue = [j0];
		for (let q = 0; q < queue.length; q++) {
			const j = queue[q]!;
			for (const ex of sym[j]!.exits) {
				const k = ex.to === null || ex.d === null ? undefined : index.get(ex.to);
				if (k === undefined || !eligible[k] || comp[k]! >= 0) continue;
				comp[k] = nc;
				at[k] = at[j]! + ex.d!;
				queue.push(k);
			}
		}
		nc++;
	}

	// one window per frame, and the slots in it
	const wins: { lo: number; hi: number }[] = [];
	const slots: Slot[] = [];
	const frames = Array.from({ length: nc }, () => [] as { off: number; len: number; wt: number; kind: string }[]);
	for (const [j, s] of sym.entries())
		if (comp[j]! >= 0) for (const a of s.acc.values()) if (a.kind !== 'vec') frames[comp[j]!]!.push({ off: at[j]! + a.off, len: a.len, wt: Number(blocks[j]!.runs), kind: a.kind });
	const live = new Map<number, number>();
	frames.forEach((list, c) => {
		const win = bestWindow(list, env.span);
		const inside = win ? list.filter((a) => a.off >= win.lo && a.off + a.len <= win.hi) : [];
		const groups = new Map<string, { off: number; len: number; wt: number; load: boolean }>();
		for (const a of inside) {
			const g = groups.get(`${a.off}:${a.len}`) ?? { off: a.off, len: a.len, wt: 0, load: false };
			g.wt += a.wt;
			g.load ||= a.kind === 'ld';
			groups.set(`${a.off}:${a.len}`, g);
		}
		const pick = [...groups.values()]
			.filter((g) => g.load)
			.sort((p, q) => q.wt - p.wt || p.off - q.off)
			.slice(0, env.maxSlots);
		if (!win || !pick.length) return;
		live.set(c, wins.length);
		wins.push(win);
		for (const g of pick) slots.push({ id: slots.length, comp: wins.length - 1, off: g.off, w: g.len });
	});
	// frames without slots drop out; a frame's number is its window's
	const promoted = comp.map((c) => c >= 0 && live.has(c));
	const frame = comp.map((c) => (c >= 0 && live.has(c) ? live.get(c)! : -1));
	for (let j = 0; j < n; j++) comp[j] = frame[j]!;

	const overlapping = (c: number, off: number, len: number) => slots.filter((s) => s.comp === c && s.off < off + len && off < s.off + s.w).map((s) => s.id);
	const cls = (j: number, i: number): Cls | undefined => {
		const a = sym[j]!.acc.get(i);
		if (!a || !promoted[j]) return undefined;
		const off = at[j]! + a.off;
		const { lo, hi } = wins[comp[j]!]!;
		const kill = overlapping(comp[j]!, off, a.len);
		if (a.kind === 'vec') return { t: 'vec', kill };
		const slot = slots.find((s) => s.comp === comp[j] && s.off === off && s.w === a.len);
		if (slot) return { t: 'slot', slot: slot.id };
		if (off >= lo && off + a.len <= hi) return { t: 'win', off };
		return kill.length || (off < hi && off + a.len > lo) ? { t: 'part', kill } : { t: 'out' };
	};
	const edge = (j: number, k: number, d: number | null) => {
		if (!promoted[k]) return 'plain';
		return promoted[j] && d !== null && comp[j] === comp[k] && at[k] === at[j]! + d ? 'carry' : 'stub';
	};

	// what a block reads before it writes (loaded at entry) and what it leaves alone (passed on)
	const use = blocks.map(() => new Set<number>());
	const touched = blocks.map(() => new Set<number>());
	for (let j = 0; j < n; j++) {
		if (!promoted[j]) continue;
		for (const [i, a] of sym[j]!.acc) {
			const c = cls(j, i)!;
			if (c.t === 'slot' && a.kind === 'ld') {
				if (!touched[j]!.has(c.slot)) use[j]!.add(c.slot);
			} else if (a.kind !== 'ld') for (const o of overlapping(comp[j]!, at[j]! + a.off, a.len)) touched[j]!.add(o);
		}
	}
	const need = blocks.map((_, j) => [...use[j]!]);
	const needSet = need.map((x) => new Set(x));
	for (let changed = true; changed; ) {
		changed = false;
		for (let j = 0; j < n; j++) {
			if (!promoted[j]) continue;
			for (const ex of sym[j]!.exits) {
				const k = ex.to === null ? undefined : index.get(ex.to);
				if (k === undefined || edge(j, k, ex.d) !== 'carry') continue;
				for (const s of needSet[k]!) {
					if (touched[j]!.has(s) || needSet[j]!.has(s)) continue;
					needSet[j]!.add(s);
					need[j]!.push(s);
					changed = true;
				}
			}
		}
	}
	return { sym, promoted, comp, at, wins, slots, need: need.map((x) => x.sort((p, q) => p - q)), cls, edge, overlapping };
}
