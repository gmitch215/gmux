import {
	FALL,
	FC,
	FK,
	condReads,
	constJump,
	flagEffect,
	flagLiveness,
	opName,
	parseRanges,
	selectBlocks,
	type Block
} from './region-ir.ts';

/**
 * Counts the FLAGS ops of a region by what reads their flags before another op rewrites them, weighted by the dump's block runs.
 *
 * `flag-consumers.ts <dump.hot> <coverage 0..1> [--ranges=<lo>-<hi>,...]`
 */

export const RECIPE_KINDS = new Set(['ADD', 'SUB', 'LOGIC', 'INC', 'DEC', 'NEG']);
type Reader = 'branch' | 'sel' | 'carry' | 'fault' | 'helper' | 'liveout';

export interface Census {
	ops: bigint;
	byKind: Map<string, bigint>;
	bucket: Map<string, bigint>;
	// recipe kind and no reader that needs the flags on the hot path (faults are a cold stub)
	removable: bigint;
	// recipe kind, read by a carry consumer (one flag materialized at the consumer)
	removableCarry: bigint;
	// everything else: a kind the recipe does not take, or a flag live at a helper, syscall or block exit
	eager: bigint;
	// reaches a faultable access before every flag is rewritten
	reachesFault: bigint;
	// the next op after the FLAGS op is a load or store
	nextIsMemory: bigint;
	liveout: bigint;
	// ops whose reads are all in the producer's block and are all branches, setcc or sel
	static: { ops: number; removable: number };
}

export function census(all: Block[], chosen: Block[]): Census {
	const index = new Map(chosen.map((b, j) => [b.pc, j]));
	const { edge } = flagLiveness(chosen, index, new Map(), new Map(all.map((b) => [b.pc, b])), { mode: 'live', mutate: '', identity: false });
	const c: Census = {
		ops: 0n,
		byKind: new Map(),
		bucket: new Map(),
		removable: 0n,
		removableCarry: 0n,
		eager: 0n,
		reachesFault: 0n,
		nextIsMemory: 0n,
		liveout: 0n,
		static: { ops: 0, removable: 0 }
	};
	const add = (m: Map<string, bigint>, k: string, v: bigint) => m.set(k, (m.get(k) ?? 0n) + v);
	for (const b of chosen) {
		const w = b.runs;
		const last = opName(b.ins.at(-1)!.op);
		b.ins.forEach((x, i) => {
			if (opName(x.op) !== 'FLAGS') return;
			const kind = FK[Number(x.imm)]!;
			let rem = flagEffect(x, false).may;
			const seen = new Set<Reader>();
			const nx = b.ins[i + 1];
			const nextMem = nx !== undefined && ['LD', 'LDS', 'ST'].includes(opName(nx.op));
			let ended = false;
			for (let k = i + 1; k < b.ins.length && rem; k++) {
				const y = b.ins[k]!;
				const name = opName(y.op);
				const e = flagEffect(y, true);
				const imm = Number(y.imm);
				if (name === 'BR') {
					if (condReads(imm) & rem) seen.add('branch');
					if (edge(b.target) & rem) seen.add('liveout');
				} else if (name === 'BRZ') {
					if (edge(b.target) & rem) seen.add('liveout');
				} else if (name === 'EXIT') {
					const to = BigInt.asUintN(64, b.pc + BigInt.asIntN(32, y.imm >> 16n));
					if (!(y.imm & 0x100n) && condReads(imm & 0xff) & rem) seen.add('branch');
					if (edge(to) & rem) seen.add('liveout');
				} else if (name === 'SETCC' || name === 'SEL') {
					if (condReads(imm) & rem) seen.add('sel');
				} else if (name === 'CARRY') {
					if (FC & rem) seen.add('carry');
				} else if (name === 'FLAGS' || name === 'X86FLAGS') {
					if (e.use & FC & rem) seen.add('carry');
					if (name === 'X86FLAGS' && y.imm === 0n) seen.add('helper');
				} else if (name === 'LD' || name === 'LDS' || name === 'ST') seen.add('fault');
				else if (e.all) seen.add('helper');
				if (name !== 'SETCC' && name !== 'SEL' && name !== 'BR' && name !== 'EXIT') rem &= ~e.def;
				if (name === 'JMP') ended = true;
			}
			if (rem && !ended) {
				const to = last === 'JMP' ? constJump(b) : last === 'SYSCALL' ? undefined : b.next;
				if (last === 'SYSCALL') seen.add('helper');
				else if ((to === undefined ? FALL : edge(to)) & rem) seen.add('liveout');
			}
			c.ops += w;
			add(c.byKind, kind, w);
			let bucket: string;
			const only = (...r: Reader[]) => [...seen].every((s) => r.includes(s));
			if (seen.size === 0) bucket = 'read by nothing';
			else if (only('fault', 'helper', 'liveout')) bucket = 'read only at a fault, syscall or exit';
			else if (only('branch')) bucket = 'branch only';
			else if (only('branch', 'sel')) bucket = 'setcc or sel';
			else if (only('branch', 'sel', 'carry')) bucket = 'carry consumer';
			else bucket = 'consumer and a fault or exit';
			add(c.bucket, bucket, w);
			if (seen.has('fault')) c.reachesFault += w;
			if (seen.has('liveout')) c.liveout += w;
			if (nextMem) c.nextIsMemory += w;
			const recipe = RECIPE_KINDS.has(kind);
			const hot = seen.has('helper') || seen.has('liveout');
			c.static.ops++;
			if (recipe && !hot && !seen.has('carry')) {
				c.removable += w;
				c.static.removable++;
			} else if (recipe && !hot) c.removableCarry += w;
			else c.eager += w;
		});
	}
	return c;
}

if (import.meta.main) {
	const args = process.argv.slice(2);
	const ranges = args.find((a) => a.startsWith('--ranges='))?.slice(9);
	const [path = '', cov = '1'] = args.filter((a) => !a.startsWith('--'));
	const { all, chosen } = selectBlocks(path, ranges === undefined ? undefined : parseRanges(ranges), Number(cov));
	const c = census(all, chosen);
	const pct = (v: bigint) => `${((100 * Number(v)) / Number(c.ops || 1n)).toFixed(1)}%`;
	console.log(`${path} cov ${cov}${ranges ? ' ranges' : ''}: ${chosen.length} blocks, FLAGS ops weighted ${c.ops}, static ${c.static.ops}`);
	for (const [k, v] of [...c.byKind].sort((p, q) => (q[1] > p[1] ? 1 : -1))) console.log(`  kind ${k}\t${pct(v)}`);
	for (const [k, v] of [...c.bucket].sort((p, q) => (q[1] > p[1] ? 1 : -1))) console.log(`  ${k}\t${pct(v)}`);
	console.log(`  next op is a load or store\t${pct(c.nextIsMemory)}`);
	console.log(`  reaches a faultable access\t${pct(c.reachesFault)}`);
	console.log(`  flag live past the block (hot materialization)\t${pct(c.liveout)}`);
	console.log(`  recipe removes outright (no hot reader, no carry)\t${pct(c.removable)}`);
	console.log(`  recipe, carry consumer (one flag at the consumer)\t${pct(c.removableCarry)}`);
	console.log(`  stays eager (kind or hot reader)\t${pct(c.eager)}`);
}
