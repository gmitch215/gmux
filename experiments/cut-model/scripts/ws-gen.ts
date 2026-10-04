import { readFileSync } from 'node:fs';

/**
 * The block-cache working-set guest: B small blocks, each ending in a jump to the next, so every
 * transition is a block-cache lookup (4,096 buckets, the newest block first in its bucket).
 *
 * - `dir`: one pseudo-random cycle over all B blocks with direct jumps. A chaining build links
 *   every transition, a build without chaining looks each one up, so base minus chain reads what a
 *   lookup costs at that working set.
 * - `ind`: B blocks held but a cycle over H of them (H = B is the whole set), each jumping
 *   through a table entry (no block can chain). One pass over all B in a random order decodes them
 *   first, then the table is rewritten to the H-cycle; so the hot blocks sit at random depths in
 *   their buckets, and block 0 counts passes and exits after `rounds` of them.
 *
 * - `dirh`: B blocks held and a cycle over H of them with direct jumps, the decoding pass first
 *   (a flag switches each block from its decoding successor to its hot one). A chaining build links
 *   the hot cycle, so base minus chain reads what a lookup costs when a program holds B blocks and
 *   dispatches over H of them.
 *
 * - `dirs`: as `dirh`, but the cycle visits the first H blocks in the order they were decoded, so
 *   consecutive lookups hit blocks that sit together in the cache's arena.
 *
 * `ws-gen.ts gen <x86_64|aarch64> <ind|dir|dirh|dirs> <B> <H> <rounds> [guards]` writes the assembly;
 * `ws-gen.ts depth <B> <H> <nm output>` prints the depth a lookup of a hot block walks (from the
 * blocks' addresses, the nm of the linked guest, and the order they were first run).
 */

export const BUCKETS = 4096;

function rng(seed: number) {
	let s = seed >>> 0 || 1;
	return () => {
		s ^= s << 13;
		s >>>= 0;
		s ^= s >>> 17;
		s ^= s << 5;
		s >>>= 0;
		return s;
	};
}

/** a single cycle through `ids` (the order they run in) where no block's successor sits right after it in memory */
function cycle(ids: number[], seed: number): number[] {
	const n = ids.length;
	for (let attempt = 0; ; attempt++) {
		const r = rng(seed * 2654435761 + attempt * 40503 + n);
		const order = [...ids];
		for (let i = n - 1; i > 1; i--) {
			const j = 1 + (r() % i);
			[order[i], order[j]] = [order[j]!, order[i]!];
		}
		let ok = true;
		for (let k = 0; k < n && ok; k++) {
			const a = order[k]!;
			const b = order[(k + 1) % n]!;
			ok = n < 3 || (b !== a + 1 && b !== a);
		}
		if (ok) return order;
	}
}

/** the plan for B held blocks and H hot ones: the order of the decoding pass over all of them, the cycle over the hot ones (block 0 among them, first) */
export function plan(blocks: number, hot: number) {
	const all = Array.from({ length: blocks }, (_, i) => i);
	const warm = cycle(all, blocks * 31 + hot);
	if (hot >= blocks) return { warm, hot: cycle(all, blocks * 17 + 1) };
	const r = rng(blocks * 7 + hot);
	const rest = all.slice(1);
	for (let i = rest.length - 1; i > 0; i--) {
		const j = r() % (i + 1);
		[rest[i], rest[j]] = [rest[j]!, rest[i]!];
	}
	return { warm, hot: cycle([0, ...rest.slice(0, hot - 1)], blocks * 17 + hot) };
}

const next = (order: number[]) => {
	const m = new Map<number, number>();
	order.forEach((b, k) => m.set(b, order[(k + 1) % order.length]!));
	return m;
};

/** `guards` segments of work, each ending in a branch that never leaves, lead every block: a block a trace of that length follows */
export function gen(arch: string, mode: string, blocks: number, hot: number, rounds: number, guards = 0): string {
	const x86 = arch === 'x86_64';
	const ind = mode === 'ind';
	const seq = mode === 'dirs';
	const dirh = mode === 'dirh' || seq;
	const planned = plan(blocks, ind || dirh ? hot : blocks);
	const warm = planned.warm;
	const hotOrder = seq ? warm.slice(0, Math.min(hot, blocks)) : planned.hot;
	const nextWarm = next(warm);
	const nextHot = next(hotOrder);
	const r = rng(blocks + 7);
	const start = ind || dirh ? warm[0]! : 0;
	const lastWarm = warm[blocks - 1]!;
	const out: string[] = ['.text', '.globl _start', '_start:'];
	const count = rounds + 2;
	if (x86) out.push(`\tmov $${count}, %r12`, '\txor %ebx, %ebx', '\txor %r13d, %r13d', '\txor %r14d, %r14d', `\tjmp blk${start}`);
	else out.push(`\tmovz x12, #${count & 0xffff}`, `\tmovk x12, #${count >>> 16}, lsl #16`, '\tmov x19, #0', '\tmov x13, #0', '\tmov x14, #0', `\tb blk${start}`);
	for (let i = 0; i < blocks; i++) {
		out.push(`blk${i}:`);
		const hotNext = nextHot.get(i) ?? nextWarm.get(i);
		if (x86) {
			if (i === 0) out.push('\tsub $1, %r12', '\tjz done');
			out.push('\tadd $1, %rbx', '\tadd $3, %rbx');
			for (let g = 0; g < guards; g++) out.push('\tadd $5, %rbx', '\tadd $7, %rbx', '\tadd $9, %rbx', '\ttest %r13, %r13', '\tjne done');
			if (dirh) out.push('\ttest %r14, %r14', `\tjnz blk${hotNext}`, ...(i === lastWarm ? ['\tmov $1, %r14d', '\tjmp blk0'] : [`\tjmp blk${nextWarm.get(i)}`]));
			else out.push(ind ? `\tjmp *tbl+${8 * i}(%rip)` : `\tjmp blk${nextHot.get(i)}`);
			out.push(`\t.skip ${r() % 8}`);
		} else {
			if (i === 0) out.push('\tsubs x12, x12, #1', '\tb.ne 1f', '\tb done', '1:');
			out.push('\tadd x19, x19, #1', '\tadd x19, x19, #3');
			for (let g = 0; g < guards; g++) out.push('\tadd x19, x19, #5', '\tadd x19, x19, #7', '\tadd x19, x19, #9', '\tcbnz x13, 2f');
			const tail = i === lastWarm ? ['\tmov x14, #1', '\tb blk0'] : [`\tb blk${nextWarm.get(i)}`];
			// cbnz reaches 1 MiB; blocks with guards are long enough to need a short hop and a b
			if (dirh) out.push(...(guards ? ['\tcbz x14, 3f', `\tb blk${hotNext}`, '3:'] : [`\tcbnz x14, blk${hotNext}`]), ...tail);
			else if (ind) out.push(`\tadrp x0, tbl+${8 * i}`, `\tldr x0, [x0, :lo12:tbl+${8 * i}]`, '\tbr x0');
			else out.push(`\tb blk${nextHot.get(i)}`);
			if (guards) out.push('2:', '\tb done');
		}
	}
	if (ind) {
		if (x86) {
			out.push('swap:', '\tlea tbl(%rip), %rsi', '\tlea tblh(%rip), %rdi', `\tmov $${blocks}, %ecx`);
			out.push('1:', '\tmov (%rdi), %rax', '\tmov %rax, (%rsi)', '\tadd $8, %rsi', '\tadd $8, %rdi', '\tdec %ecx', '\tjnz 1b', '\tjmp blk0');
		} else {
			out.push('swap:', '\tadrp x0, tbl', '\tadd x0, x0, :lo12:tbl', '\tadrp x1, tblh', '\tadd x1, x1, :lo12:tblh');
			out.push(`\tmovz x2, #${blocks & 0xffff}`, `\tmovk x2, #${blocks >>> 16}, lsl #16`);
			out.push('1:', '\tldr x3, [x1], #8', '\tstr x3, [x0], #8', '\tsubs x2, x2, #1', '\tb.ne 1b', '\tb blk0');
		}
	}
	out.push('done:');
	if (x86) {
		out.push('\tpush %rbx', '\tmov $1, %eax', '\tmov $1, %edi', '\tmov %rsp, %rsi', '\tmov $8, %edx', '\tsyscall');
		out.push('\tmov $231, %eax', '\txor %edi, %edi', '\tsyscall');
	} else {
		out.push('\tstr x19, [sp, #-16]!', '\tmov x0, #1', '\tmov x1, sp', '\tmov x2, #8', '\tmov x8, #64', '\tsvc 0');
		out.push('\tmov x0, #0', '\tmov x8, #94', '\tsvc 0');
	}
	if (ind) {
		const last = warm[blocks - 1]!;
		out.push('.data', '.p2align 3', 'tbl:');
		for (let i = 0; i < blocks; i++) out.push(`\t.quad ${i === last ? 'swap' : `blk${nextWarm.get(i)}`}`);
		out.push('tblh:');
		for (let i = 0; i < blocks; i++) out.push(`\t.quad blk${nextHot.get(i) ?? nextWarm.get(i)}`);
	}
	return out.join('\n') + '\n';
}

/** the depth a lookup of each hot block walks: the cache holds the newest block first in its bucket, and the decoding pass runs the blocks in `warm` order */
export function depth(blocks: number, hot: number, addrs: number[]) {
	const hash = (pc: number) => ((pc >>> 2) ^ (pc >>> 14)) & (BUCKETS - 1);
	const { warm, hot: hotOrder } = plan(blocks, hot);
	const inBucket = new Map<number, number[]>();
	for (const b of warm) {
		const h = hash(addrs[b]!);
		inBucket.set(h, [...(inBucket.get(h) ?? []), b]);
	}
	let sum = 0;
	let max = 0;
	for (const b of hotOrder) {
		const list = inBucket.get(hash(addrs[b]!))!;
		const d = list.length - list.indexOf(b);
		sum += d;
		max = Math.max(max, d);
	}
	return { blocks, hot: hotOrder.length, bucketsUsed: inBucket.size, meanDepth: sum / hotOrder.length, maxDepth: max };
}

if (process.argv[1]?.endsWith('ws-gen.ts')) {
	const [cmd, a, b, c, d, e, f] = process.argv.slice(2);
	if (cmd === 'gen' && a && b && c && d && e) process.stdout.write(gen(a, b, Number(c), Number(d), Number(e), Number(f ?? 0)));
	else if (cmd === 'depth' && a && b && c) {
		const addrs: number[] = [];
		for (const line of readFileSync(c, 'utf8').split('\n')) {
			const m = /^([0-9a-f]+) \w blk(\d+)$/.exec(line.trim());
			if (m) addrs[Number(m[2])] = parseInt(m[1]!, 16);
		}
		console.log(JSON.stringify(depth(Number(a), Number(b), addrs)));
	} else {
		console.error('usage: ws-gen.ts gen <x86_64|aarch64> <ind|dir> <B> <H> <rounds> | depth <B> <H> <nm output>');
		process.exitCode = 2;
	}
}
