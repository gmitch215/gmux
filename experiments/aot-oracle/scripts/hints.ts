import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { hinted, type Entry } from '../../wasm-features/scripts/branch-hint.ts';
import { align, parseObjdump, type Fn } from './opmap.ts';
import { opName, parse, type Block } from './region-ir.ts';

/**
 * Writes the metadata.code.branch_hint section into an instrumented module from a hot dump's branch counts.
 *
 * `hints.ts <none|dump|all|inv> <pre.wasm> <inst.wasm> <hints.tsv> <out.wasm> <dump.hot>...`
 *
 * Input contract:
 * - `pre.wasm` is the linked module and `inst.wasm` the same module after `instrument.sh` (built with GMUX_NAMES=1, so the
 *   region functions carry their names). The passes only insert ops, so `opmap.ts`'s `align` finds each op of `pre` again.
 *   `opmap.ts` keys an op by category and guest pc, not by the IR op that wrote it, so a hint is keyed by `emit.ts`'s own
 *   ordinal instead: `hints.tsv` lists every wasm `if` of each emitted function in the order written.
 * - `hints.tsv` is `emit.ts`'s sidecar (`hintsTsv`): fn, ordinal, class, block pc, op index, static guard.
 * - the dumps are the ones the arm was emitted from; a block's `branch` line gives the runs that took its final branch and the
 *   runs that fell through, and its `exits` line the runs that left at each interior exit.
 *
 * Modes: `none` copies `inst`; `dump` hints guest branches (`br`, `exit`) from the counts; `all` adds the static guard classes;
 * `inv` is `dump` with every value reversed and `allinv` is `all` with every value reversed. A site gets a hint only when its two counts differ; two zero counts, an absent
 * `branch` line and equal counts get none. A function whose `if` count differs from its rows throws.
 */
export type Mode = 'none' | 'dump' | 'all' | 'inv' | 'allinv';
export interface Row {
	fn: string;
	ordinal: number;
	cls: string;
	pc?: bigint;
	op?: number;
	guard?: 0 | 1;
}
export interface ClassStat {
	sites: number;
	hinted: number;
	likely: number;
	// the runs that went the hinted way and all runs through the hinted sites (counted classes only)
	agree: bigint;
	total: bigint;
}

export function readRows(text: string): Row[] {
	const [head, ...lines] = text.split('\n');
	if (head !== 'fn\tordinal\tclass\tpc\top\tguard') throw new Error(`not a hints.tsv: ${head}`);
	return lines
		.filter(Boolean)
		.map((l) => l.split('\t'))
		.map(([fn, ordinal, cls, pc, op, guard]) => ({
			fn: fn!,
			ordinal: Number(ordinal),
			cls: cls!,
			...(pc ? { pc: BigInt(`0x${pc}`) } : {}),
			...(op ? { op: Number(op) } : {}),
			...(guard ? { guard: Number(guard) as 0 | 1 } : {})
		}));
}

const WRAP = 1n << 32n;
export const COUNTED = new Set(['br', 'exit']);

// [taken, not taken] for the site, or undefined where the dump has nothing
export function counts(r: Row, blocks: Map<bigint, Block>): [bigint, bigint] | undefined {
	const b = r.pc === undefined ? undefined : blocks.get(r.pc);
	if (!b) throw new Error(`${r.fn} if ${r.ordinal}: no block ${r.pc?.toString(16)} in the dump`);
	const x = b.ins[r.op!];
	if (!x) throw new Error(`${r.fn} if ${r.ordinal}: block ${r.pc!.toString(16)} has no op ${r.op}`);
	const name = opName(x.op);
	if (r.cls === 'br') {
		if (name !== 'BR' && name !== 'BRZ') throw new Error(`${r.fn} if ${r.ordinal}: op ${r.op} of block ${r.pc!.toString(16)} is ${name}, not a branch`);
		if (b.taken === undefined || b.fall === undefined) return undefined;
		// the counters are 32-bit: a block that ran more often than they hold may have wrapped
		if (b.runs >= WRAP) throw new Error(`block ${r.pc!.toString(16)} ran ${b.runs} times; its 32-bit taken and fall counts may have wrapped`);
		if (b.taken + b.fall > b.runs) throw new Error(`block ${r.pc!.toString(16)}: taken ${b.taken} + fall ${b.fall} exceeds runs ${b.runs}`);
		return [b.taken, b.fall];
	}
	if (name !== 'EXIT') throw new Error(`${r.fn} if ${r.ordinal}: op ${r.op} of block ${r.pc!.toString(16)} is ${name}, not an exit`);
	// an interior exit is only reached by the runs that left at none of the exits before it
	let reached = b.runs;
	for (const [i, n] of b.exits ?? []) if (i < r.op!) reached -= n;
	const left = b.exits?.get(r.op!) ?? 0n;
	if (reached < left) throw new Error(`block ${r.pc!.toString(16)}: ${left} runs left at op ${r.op} of ${reached} that reached it`);
	return [left, reached - left];
}

/** the value to hint, or undefined: 1 where the then arm is the likely one */
export function pick(r: Row, blocks: Map<bigint, Block>, mode: Mode, stats: Map<string, ClassStat>): 0 | 1 | undefined {
	const st = stats.get(r.cls) ?? stats.set(r.cls, { sites: 0, hinted: 0, likely: 0, agree: 0n, total: 0n }).get(r.cls)!;
	st.sites++;
	if (mode === 'none') return undefined;
	let v: 0 | 1 | undefined;
	if (COUNTED.has(r.cls)) {
		const c = counts(r, blocks);
		if (!c || c[0] === c[1]) return undefined;
		v = c[0] > c[1] ? 1 : 0;
		st.agree += v === 1 ? c[0] : c[1];
		st.total += c[0] + c[1];
		if (mode === 'inv' || mode === 'allinv') v = v === 1 ? 0 : 1;
	} else if (mode === 'all') v = r.guard;
	else if (mode === 'allinv' && r.guard !== undefined) v = r.guard === 1 ? 0 : 1;
	if (v === undefined) return undefined;
	st.hinted++;
	if (v === 1) st.likely++;
	return v;
}

/** the entries of the section, by the index of each function in `inst` */
export function plan(pre: Fn[], inst: Fn[], rows: Row[], blocks: Map<bigint, Block>, mode: Mode) {
	const extra = inst.length - pre.length;
	if (extra !== 0 && extra !== 1) throw new Error(`${inst.length} functions after ${pre.length}`);
	const byFn = new Map<string, Row[]>();
	for (const r of rows) byFn.set(r.fn, [...(byFn.get(r.fn) ?? []), r]);
	const stats = new Map<string, ClassStat>();
	const entries: Entry[] = [];
	const seen = new Set<string>();
	inst.forEach((fn, k) => {
		const mine = byFn.get(fn.name);
		if (!mine) return;
		const pf = pre[k - extra];
		if (!pf) throw new Error(`${fn.name} has no function in the module before the passes`);
		if (pf.name && pf.name !== fn.name) throw new Error(`function ${k} is ${fn.name} after the passes and ${pf.name} before`);
		seen.add(fn.name);
		const ifs = pf.ops.map((o, p) => [o, p] as const).filter(([o]) => o.name === 'if');
		if (ifs.length !== mine.length) throw new Error(`${fn.name}: ${ifs.length} ifs in the module, ${mine.length} rows in the sidecar`);
		mine.forEach((r, n) => {
			if (r.ordinal !== n) throw new Error(`${fn.name}: row ${n} has ordinal ${r.ordinal}`);
		});
		const instOf = align(pf.ops, fn.ops);
		const hints: [number, number][] = [];
		mine.forEach((r, n) => {
			const v = pick(r, blocks, mode, stats);
			if (v === undefined) return;
			const op = fn.ops[instOf[ifs[n]![1]]!]!;
			if (op.name !== 'if') throw new Error(`${fn.name}: if ${n} lands on ${op.name} after the passes`);
			hints.push([op.off - fn.start, v]);
		});
		entries.push({ index: fn.index, hints });
	});
	for (const f of byFn.keys()) if (!seen.has(f)) throw new Error(`the sidecar names ${f}, which is not in the module`);
	return { entries, stats };
}

export const blocksOf = (paths: string[]) => {
	const blocks = new Map<bigint, Block>();
	for (const p of new Set(paths))
		for (const b of parse(p)) {
			if (blocks.has(b.pc)) throw new Error(`block ${b.pc.toString(16)} is in two dumps (or twice in ${p})`);
			blocks.set(b.pc, b);
		}
	return blocks;
};

if (import.meta.main) {
	const [mode = '', prePath = '', instPath = '', tsv = '', outPath = '', ...dumps] = process.argv.slice(2);
	if (!['none', 'dump', 'all', 'inv', 'allinv'].includes(mode) || !outPath) throw new Error('hints.ts <none|dump|all|inv|allinv> <pre.wasm> <inst.wasm> <hints.tsv> <out.wasm> <dump.hot>...');
	const objdump = process.env.WASM_OBJDUMP ?? 'wasm-objdump';
	const run = (p: string) => parseObjdump(execFileSync(objdump, ['-d', p], { encoding: 'utf8', maxBuffer: 1 << 30 }));
	const inst = readFileSync(instPath);
	if (mode === 'none') {
		writeFileSync(outPath, inst);
		process.exit(0);
	}
	const instFns = run(instPath);
	const { entries, stats } = plan(run(prePath), instFns, readRows(readFileSync(tsv, 'utf8')), blocksOf(dumps), mode as Mode);
	writeFileSync(outPath, hinted(inst, entries, instFns[0]!.index));
	console.error('class\tsites\thinted\tlikely\tunlikely\tagreeing runs\truns through hinted sites');
	for (const [c, s] of [...stats].sort()) console.error(`${c}\t${s.sites}\t${s.hinted}\t${s.likely}\t${s.hinted - s.likely}\t${COUNTED.has(c) ? s.agree : ''}\t${COUNTED.has(c) ? s.total : ''}`);
	console.error(`wrote ${outPath}: ${entries.reduce((n, e) => n + e.hints.length, 0)} hints in ${entries.filter((e) => e.hints.length).length} functions`);
}
