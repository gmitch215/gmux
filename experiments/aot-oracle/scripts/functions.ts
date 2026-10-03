import { readFileSync } from 'node:fs';

/**
 * Functions of a guest program from a KATYBUG_HOT dump of an unfused, untraced build (-DKB_FUSE=0
 * -DKB_TRACE=1: every block ends at its first branch, call or return), ranked by the guest
 * instructions they run themselves. A function is what is reachable from a call target through
 * branches, fall-through and direct jumps, without following a call into its callee. The program
 * is stripped, so a function is its entry address and the code range its blocks span.
 *
 * `functions.ts <dump.hot>... [--top n]`, one table per run on stdout
 */
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
}
export interface Fn {
	entry: bigint;
	blocks: Block[];
	self: bigint;
	lo: bigint;
	hi: bigint;
	calls: bigint;
	callees: Map<bigint, bigint>;
	indirect: bigint;
	syscalls: bigint;
	vector: bigint;
}

export function parse(text: string): Block[] {
	const lines = text.split('\n');
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
		blocks.push({ pc: BigInt(`0x${m[1]}`), next: BigInt(`0x${m[2]}`), target: BigInt(`0x${m[3]}`), runs: BigInt(m[5]!), ins });
	}
	return blocks;
}

export function opNumbers(header: string): Record<string, number> {
	const body = header.match(/enum kb_op\s*\{([\s\S]*?)\};/)![1]!.replace(/\/\*[\s\S]*?\*\//g, '');
	const names = body.split(',').map((s) => s.trim()).filter(Boolean);
	return Object.fromEntries(names.map((n, i) => [n.replace(/^KB_/, ''), i]));
}

/** how a block ends: a call has a return address pushed (a constant equal to the block's next) before its jump */
export function ending(b: Block, op: Record<string, number>): 'call' | 'jump' | 'indirect-call' | 'ret' | 'branch' | 'syscall' | 'fall' {
	const last = b.ins.at(-1)!;
	if (last.op === op.SYSCALL) return 'syscall';
	if (last.op === op.BR || last.op === op.BRZ) return 'branch';
	if (last.op !== op.JMP) return 'fall';
	const pushed = b.ins.some((x) => x.op === op.MOVI && BigInt.asUintN(64, x.imm) === b.next) && b.ins.some((x) => x.op === op.ST);
	const before = b.ins.at(-2);
	const direct = before?.op === op.MOVI && before.a === last.b;
	if (pushed) return direct ? 'call' : 'indirect-call';
	return direct ? 'jump' : 'ret';
}

export function functions(blocks: Block[], op: Record<string, number>, program: bigint): Fn[] {
	const byPc = new Map(blocks.map((b) => [b.pc, b]));
	const entries = new Set<bigint>([program]);
	for (const b of blocks) if (ending(b, op) === 'call') entries.add(BigInt.asUintN(64, b.ins.at(-2)!.imm));
	const claimed = new Map<bigint, bigint>();
	const out: Fn[] = [];
	for (const entry of [...entries].sort((x, y) => (x < y ? -1 : 1))) {
		const root = byPc.get(entry);
		if (!root) continue;
		const fn: Fn = { entry, blocks: [], self: 0n, lo: root.pc, hi: root.next, calls: 0n, callees: new Map(), indirect: 0n, syscalls: 0n, vector: 0n };
		const stack = [root];
		const seen = new Set<bigint>();
		while (stack.length) {
			const b = stack.pop()!;
			if (seen.has(b.pc) || (claimed.has(b.pc) && claimed.get(b.pc) !== entry)) continue;
			seen.add(b.pc);
			claimed.set(b.pc, entry);
			fn.blocks.push(b);
			fn.self += b.runs * BigInt(b.ins.length);
			if (b.pc < fn.lo) fn.lo = b.pc;
			if (b.next > fn.hi) fn.hi = b.next;
			const end = ending(b, op);
			const succ: bigint[] = [];
			if (end === 'call') {
				fn.calls += b.runs;
				const callee = BigInt.asUintN(64, b.ins.at(-2)!.imm);
				fn.callees.set(callee, (fn.callees.get(callee) ?? 0n) + b.runs);
				succ.push(b.next);
			} else if (end === 'indirect-call') {
				fn.calls += b.runs;
				fn.indirect += b.runs;
				succ.push(b.next);
			} else if (end === 'jump') succ.push(b.target);
			else if (end === 'branch') succ.push(b.target, b.next);
			else if (end === 'fall' || end === 'syscall') succ.push(b.next);
			if (end === 'syscall') fn.syscalls += b.runs;
			for (const x of b.ins) if (x.op === op.SSE || x.op === op.X87) fn.vector += b.runs;
			for (const t of succ) {
				const nb = byPc.get(t);
				if (nb) stack.push(nb);
			}
		}
		out.push(fn);
	}
	return out.sort((x, y) => (y.self > x.self ? 1 : y.self < x.self ? -1 : 0));
}

/**
 * The code a function runs as lift.ts `--ranges` text: the [pc, next) of each of its blocks, merged. With
 * `callees`, the functions it calls (transitively) that run at least `minShare` of all ops are included.
 */
export function rangesOf(fns: Fn[], total: bigint, rank: number, callees = false, minShare = 0.01): string {
	const byEntry = new Map(fns.map((f) => [f.entry, f]));
	const root = fns[rank]!;
	const picked = new Set<Fn>([root]);
	for (const f of callees ? picked : []) {
		for (const c of f.callees.keys()) {
			const g = byEntry.get(c);
			if (g && !picked.has(g) && Number(g.self) >= minShare * Number(total)) picked.add(g);
		}
	}
	const spans = [...picked].flatMap((f) => f.blocks.map((b) => [b.pc, b.next] as const)).sort((x, y) => (x[0] < y[0] ? -1 : x[0] > y[0] ? 1 : 0));
	const merged: [bigint, bigint][] = [];
	for (const [lo, hi] of spans) {
		const last = merged.at(-1);
		if (last && lo <= last[1]) last[1] = hi > last[1] ? hi : last[1];
		else merged.push([lo, hi]);
	}
	return merged.map(([lo, hi]) => `0x${lo.toString(16)}-0x${hi.toString(16)}`).join(',');
}

if (process.argv[1]?.endsWith('functions.ts')) {
	const args = process.argv.slice(2);
	const top = args.includes('--top') ? Number(args[args.indexOf('--top') + 1]) : 12;
	const dumps = args.filter((a, i) => !a.startsWith('--') && args[i - 1] !== '--top');
	const root = new URL('../../../', import.meta.url).pathname;
	const op = opNumbers(readFileSync(`${root}src/gmux/katybug/kb.h`, 'utf8'));
	for (const dump of dumps) {
		const blocks = parse(readFileSync(dump, 'utf8'));
		const total = blocks.reduce((s, b) => s + b.runs * BigInt(b.ins.length), 0n);
		const hex = (v: bigint) => `0x${v.toString(16)}`;
		const show = args.find((a) => a.startsWith('--block='))?.slice(8);
		if (show) {
			const names = Object.fromEntries(Object.entries(op).map(([k, v]) => [v, k]));
			const b = blocks.find((x) => x.pc === BigInt(`0x${show}`));
			console.log(`${show}: ${b ? b.ins.map((x) => names[x.op]).join(' ') : 'not in the dump'}`);
			continue;
		}
		const first = [...blocks].sort((x, y) => (x.pc < y.pc ? -1 : 1))[0]!.pc;
		const ranked = functions(blocks, op, first);
		const emit = args.find((a) => a.startsWith('--emit='))?.slice(7);
		if (emit) {
			const [rank, withCallees] = emit.split('+');
			console.log(rangesOf(ranked, total, Number(rank), withCallees === 'callees'));
			continue;
		}
		console.log(`${dump}: ${blocks.length} blocks, ${total} IR ops run`);
		console.log('| entry | blocks | self share | code range | calls | callees | indirect | syscalls | sse/x87 ops |');
		console.log('| --- | --- | --- | --- | --- | --- | --- | --- | --- |');
		for (const f of ranked.slice(0, top))
			console.log(
				`| ${hex(f.entry)} | ${f.blocks.length} | ${((100 * Number(f.self)) / Number(total)).toFixed(2)}% | ${hex(f.lo)}-${hex(f.hi)} | ${f.calls} | ${f.callees.size} | ${f.indirect} | ${f.syscalls} | ${f.vector} |`
			);
		if (args.includes('--calls'))
			for (const f of ranked.slice(0, top))
				console.log(`${hex(f.entry)} calls ${[...f.callees].map(([t, n]) => `${hex(t)} x${n}`).join(', ')}`);
	}
}
