import { readFileSync } from 'node:fs';

/**
 * Functions of a guest program from a KATYBUG_HOT dump of an unfused, untraced build (-DKB_FUSE=0
 * -DKB_TRACE=1: every block ends at its first branch, call or return), ranked by the guest
 * instructions they run themselves. A function is what is reachable from a call target through
 * branches, fall-through and direct jumps, without following a call into its callee. The program
 * is stripped, so a function is its entry address and the code range its blocks span. Blocks no call target
 * reaches (an indirect call's or a jump table's) seed functions of their own; `--no-orphans` leaves them out and
 * `--claimed` prints the share of ops claimed, the top functions' cumulative share and the endings run.
 *
 * `functions.ts <dump.hot>... [--top n]`, one table per run on stdout. `--emit=<rank>[+callees]` prints one
 * lift.ts ranges text for the function (and its hot callees); `--emit-split=<rank>[:<n>]` prints one per line for the
 * function and its n hottest callees (all worth keeping, without n), each to be a region of its own;
 * `--emit-top=<n>` prints one per line for the n functions with the most self ops, no callees.
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

/**
 * how a block ends: a call has a return address pushed (a constant equal to the block's next) before its jump;
 * a return jumps to a value loaded off the stack pointer (x86-64's r4), any other jump through a register is a
 * computed jump (a jump table: a table load, a base add, the jump)
 */
export function ending(
	b: Block,
	op: Record<string, number>
): 'call' | 'jump' | 'indirect-call' | 'ret' | 'computed-jump' | 'branch' | 'syscall' | 'fall' {
	const last = b.ins.at(-1)!;
	if (last.op === op.SYSCALL) return 'syscall';
	if (last.op === op.BR || last.op === op.BRZ) return 'branch';
	if (last.op !== op.JMP) return 'fall';
	const pushed = b.ins.some((x) => x.op === op.MOVI && BigInt.asUintN(64, x.imm) === b.next) && b.ins.some((x) => x.op === op.ST);
	const before = b.ins.at(-2);
	const direct = before?.op === op.MOVI && before.a === last.b;
	if (pushed) return direct ? 'call' : 'indirect-call';
	if (direct) return 'jump';
	const notDefs = new Set([op.ST, op.FLAGS, op.BR, op.BRZ, op.JMP, op.SYSCALL, op.TRAP, op.PC, op.SETTP, op.CCMP]);
	const def = b.ins.findLast((x) => x.a === last.b && !notDefs.has(x.op));
	return def?.op === op.LD && def.b === 4 ? 'ret' : 'computed-jump';
}

/** the blocks a block flows to inside its function: a call is followed to its return site, not into the callee */
function successors(b: Block, end: ReturnType<typeof ending>): bigint[] {
	if (end === 'call' || end === 'indirect-call' || end === 'fall' || end === 'syscall') return [b.next];
	if (end === 'jump') return [b.target];
	if (end === 'branch') return [b.target, b.next];
	return [];
}

/**
 * The blocks no call target reaches (indirect-call and jump-table targets, code only a jump table enters) are
 * seeded too: one block per source component of the graph they make (a block nothing flows into, or the lowest
 * pc of a cycle nothing outside it flows into), so every block is in some function.
 */
function orphanRoots(unclaimed: Block[], ends: Map<bigint, ReturnType<typeof ending>>): bigint[] {
	const byPc = new Map(unclaimed.map((b) => [b.pc, b]));
	const succ = (b: Block) => successors(b, ends.get(b.pc)!).filter((t) => byPc.has(t));
	// iterative Tarjan: comp.get(pc) is a component number
	const index = new Map<bigint, number>();
	const low = new Map<bigint, number>();
	const comp = new Map<bigint, number>();
	const open: bigint[] = [];
	let counter = 0;
	let comps = 0;
	for (const start of unclaimed) {
		if (index.has(start.pc)) continue;
		const work: { b: Block; next: bigint[] }[] = [{ b: start, next: succ(start) }];
		index.set(start.pc, counter);
		low.set(start.pc, counter++);
		open.push(start.pc);
		while (work.length) {
			const top = work.at(-1)!;
			const t = top.next.pop();
			if (t !== undefined) {
				if (!index.has(t)) {
					const nb = byPc.get(t)!;
					index.set(t, counter);
					low.set(t, counter++);
					open.push(t);
					work.push({ b: nb, next: succ(nb) });
				} else if (!comp.has(t)) low.set(top.b.pc, Math.min(low.get(top.b.pc)!, index.get(t)!));
				continue;
			}
			work.pop();
			const pc = top.b.pc;
			if (low.get(pc) === index.get(pc)) {
				for (let x = open.pop()!; ; x = open.pop()!) {
					comp.set(x, comps);
					if (x === pc) break;
				}
				comps++;
			}
			const parent = work.at(-1);
			if (parent) low.set(parent.b.pc, Math.min(low.get(parent.b.pc)!, low.get(pc)!));
		}
	}
	const fed = new Set<number>();
	for (const b of unclaimed) for (const t of succ(b)) if (comp.get(t) !== comp.get(b.pc)) fed.add(comp.get(t)!);
	const lowest = new Map<number, bigint>();
	for (const b of unclaimed) {
		const c = comp.get(b.pc)!;
		if (!fed.has(c) && (lowest.get(c) ?? b.pc) >= b.pc) lowest.set(c, b.pc);
	}
	return [...lowest.values()].sort((x, y) => (x < y ? -1 : 1));
}

/** `orphans` false seeds from call targets only, as before the orphan roots were added */
export function functions(blocks: Block[], op: Record<string, number>, program: bigint, orphans = true): Fn[] {
	const byPc = new Map(blocks.map((b) => [b.pc, b]));
	const ends = new Map(blocks.map((b) => [b.pc, ending(b, op)]));
	const entries = new Set<bigint>([program]);
	for (const b of blocks) if (ends.get(b.pc) === 'call') entries.add(BigInt.asUintN(64, b.ins.at(-2)!.imm));
	const claimed = new Map<bigint, bigint>();
	const out: Fn[] = [];
	const grow = (entry: bigint) => {
		const root = byPc.get(entry);
		if (!root) return;
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
			const end = ends.get(b.pc)!;
			if (end === 'call') {
				fn.calls += b.runs;
				const callee = BigInt.asUintN(64, b.ins.at(-2)!.imm);
				fn.callees.set(callee, (fn.callees.get(callee) ?? 0n) + b.runs);
			} else if (end === 'indirect-call') {
				fn.calls += b.runs;
				fn.indirect += b.runs;
			}
			if (end === 'syscall') fn.syscalls += b.runs;
			for (const x of b.ins) if (x.op === op.SSE || x.op === op.X87) fn.vector += b.runs;
			for (const t of successors(b, end)) {
				const nb = byPc.get(t);
				if (nb) stack.push(nb);
			}
		}
		out.push(fn);
	};
	for (const entry of [...entries].sort((x, y) => (x < y ? -1 : 1))) grow(entry);
	if (orphans) for (const entry of orphanRoots(blocks.filter((b) => !claimed.has(b.pc)), ends)) grow(entry);
	return out.sort((x, y) => (y.self > x.self ? 1 : y.self < x.self ? -1 : 0));
}

/** the share of all ops that sit in a function's blocks, and the cumulative self share of the top n functions */
export function shares(fns: Fn[], total: bigint, tops: number[]): { claimed: number; top: number[] } {
	const share = (fs: Fn[]) => Number(fs.reduce((s, f) => s + f.self, 0n)) / Number(total);
	return { claimed: share(fns), top: tops.map((n) => share(fns.slice(0, n))) };
}

/**
 * The code a function runs as lift.ts `--ranges` text: the [pc, next) of each of its blocks, merged. With
 * `callees`, the functions it calls (transitively) that run at least `minShare` of all ops are included.
 */
export function rangesOf(fns: Fn[], total: bigint, rank: number, callees = false, minShare = 0.01): string {
	return mergedRanges(pickedOf(fns, total, rank, callees, minShare));
}

/** the function of that rank, then the callees (transitively) worth keeping, most self ops first, at most `most` of them */
export function pickedOf(fns: Fn[], total: bigint, rank: number, callees = false, minShare = 0.01, most = Infinity): Fn[] {
	const byEntry = new Map(fns.map((f) => [f.entry, f]));
	const root = fns[rank]!;
	const picked = new Set<Fn>([root]);
	for (const f of callees ? picked : []) {
		for (const c of f.callees.keys()) {
			const g = byEntry.get(c);
			if (g && !picked.has(g) && Number(g.self) >= minShare * Number(total)) picked.add(g);
		}
	}
	return [root, ...[...picked].slice(1).sort((x, y) => (y.self > x.self ? 1 : y.self < x.self ? -1 : 0)).slice(0, most)];
}

function mergedRanges(picked: Fn[]): string {
	const spans = picked.flatMap((f) => f.blocks.map((b) => [b.pc, b.next] as const)).sort((x, y) => (x[0] < y[0] ? -1 : x[0] > y[0] ? 1 : 0));
	const merged: [bigint, bigint][] = [];
	for (const [lo, hi] of spans) {
		const last = merged.at(-1);
		if (last && lo <= last[1]) last[1] = hi > last[1] ? hi : last[1];
		else merged.push([lo, hi]);
	}
	return merged.map(([lo, hi]) => `0x${lo.toString(16)}-0x${hi.toString(16)}`).join(',');
}

/** the same functions as rangesOf, one ranges text per function (the root first), for one region each */
export function splitRanges(fns: Fn[], total: bigint, rank: number, minShare = 0.01, most = Infinity): string[] {
	return pickedOf(fns, total, rank, true, minShare, most).map((f) => mergedRanges([f]));
}

/** one ranges text per function for the `n` with the most self ops, without their callees, for one region each */
export function topRanges(fns: Fn[], n: number): string[] {
	return fns.slice(0, n).map((f) => mergedRanges([f]));
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
		const ranked = functions(blocks, op, first, !args.includes('--no-orphans'));
			if (args.includes('--claimed')) {
				const tops = [5, 10, 20, 40, 60];
				const s = shares(ranked, total, tops);
				const pct = (v: number) => `${(100 * v).toFixed(2)}%`;
				const nblocks = ranked.reduce((c, f) => c + f.blocks.length, 0);
				console.log(`${dump}: ${blocks.length} blocks, ${total} IR ops, ${ranked.length} functions claim ${nblocks} blocks and ${pct(s.claimed)} of ops`);
				console.log(`cumulative self share of the top ${tops.map((t, i) => `${t}: ${pct(s.top[i]!)}`).join(', ')}`);
				let held = 0;
				const n90 = ranked.findIndex((f) => (held += Number(f.self)) >= 0.9 * Number(total)) + 1;
				console.log(`functions holding 90% of all ops: ${n90 || 'not reached'}`);
				const ends = new Map<string, bigint>();
				for (const b of blocks) ends.set(ending(b, op), (ends.get(ending(b, op)) ?? 0n) + b.runs);
				console.log(`block endings run: ${[...ends].map(([k, n]) => `${k} ${n}`).join(', ')}`);
				continue;
			}
		const topN = args.find((a) => a.startsWith('--emit-top='))?.slice(11);
		if (topN) {
			console.log(topRanges(ranked, Number(topN)).join('\n'));
			continue;
		}
		const split = args.find((a) => a.startsWith('--emit-split='))?.slice(13);
		if (split) {
			const [rank, most] = split.split(':');
			console.log(splitRanges(ranked, total, Number(rank), 0.01, most === undefined ? Infinity : Number(most)).join('\n'));
			continue;
		}
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
