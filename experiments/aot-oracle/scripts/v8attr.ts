import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { parseObjdump } from './opmap.ts';

/**
 * Attributes perf samples of a V8 run to the categories opmap.ts wrote. V8 gives perf a function and a machine offset
 * (`perf script -F ip,sym,symoff,dso` after `perf inject --jit`), and `--print-wasm-code` gives, per function, the machine
 * instructions and a table of (machine offset, wasm offset in the function body) at trapping and calling ops only. A sample takes the
 * category of the op the last table entry at or before its offset names, and a shape from the instruction it lands in.
 *
 * `v8attr.ts --script=<perf script> --dis=<print-wasm-code output>[,...] --module=<inst.wasm> --ops=<ops.tsv> [--region=<regexp>]`
 */

export interface Sample {
	name: string;
	index: number;
	off: number;
	dso: string;
}
export interface Code {
	name: string;
	index: number;
	insns: { off: number; text: string }[];
	positions: { pc: number; pos: number }[];
}

// ` 36868baa4b5e JS:f_arith-5-turbofan+0x9e (/path/jitted-1-2.so)`
export function parseScript(text: string): Sample[] {
	const out: Sample[] = [];
	for (const l of text.split('\n')) {
		const m = /^\s*([0-9a-f]+) (.+?)(?:\+0x([0-9a-f]+))? \((.*)\)$/.exec(l);
		if (!m) continue;
		const w = /^JS:(.*)-(\d+)-turbofan$/.exec(m[2]!);
		out.push({ name: w ? w[1]! : m[2]!, index: w ? Number(w[2]) : -1, off: m[3] ? parseInt(m[3], 16) : 0, dso: m[4]! });
	}
	return out;
}

// the blocks `--print-wasm-code` prints: a header, the instructions, a table of source positions
export function parseDis(text: string): Code[] {
	const out: Code[] = [];
	let cur: Code | undefined;
	let mode = '';
	for (const l of text.split('\n')) {
		if (l.startsWith('--- WebAssembly code ---')) {
			cur = { name: '', index: -1, insns: [], positions: [] };
			out.push(cur);
			mode = 'head';
		} else if (!cur) continue;
		else if (mode === 'head' && l.startsWith('name: ')) cur.name = l.slice(6);
		else if (mode === 'head' && l.startsWith('index: ')) cur.index = Number(l.slice(7));
		else if (l.startsWith('Instructions')) mode = 'insns';
		else if (l.startsWith('Source positions')) mode = 'pos';
		else if (/^(Safepoints|Deopt|Handler|RelocInfo|--- End)/.test(l)) mode = '';
		else if (mode === 'insns') {
			const m = /^0x[0-9a-f]+ +([0-9a-f]+) +[0-9a-f]+ +(.*)$/.exec(l);
			if (m) cur.insns.push({ off: parseInt(m[1]!, 16), text: m[2]!.replace(/^REX\.W /, '') });
		} else if (mode === 'pos') {
			const m = /^ +([0-9a-f]+) +(\d+)$/.exec(l);
			if (m) cur.positions.push({ pc: parseInt(m[1]!, 16), pos: Number(m[2]) });
		}
	}
	return out;
}

/** the shape of one x64 instruction as V8 prints it (destination first): a frame store or load (a spill), a call, a branch, or the rest */
export function shapeOf(text: string): string {
	const m = text.split(/\s+/)[0] ?? '';
	if (m === 'call' || m === 'ret' || m === 'retl') return 'call';
	if (/^j/.test(m)) return 'branch';
	const ops = text.slice(m.length).trim();
	if (!/\[rbp-0x[0-9a-f]+\]/.test(ops)) return 'other';
	return ops.startsWith('[rbp-') ? 'spill store' : 'spill load';
}

/** the last element of a list sorted by `key` whose key is at most `at` */
export function lastAtMost<T>(list: T[], at: number, key: (x: T) => number): T | undefined {
	let lo = 0;
	let hi = list.length;
	while (lo < hi) {
		const mid = (lo + hi) >> 1;
		if (key(list[mid]!) <= at) lo = mid + 1;
		else hi = mid;
	}
	return list[lo - 1];
}

const STOP = /^(?:[if](?:32|64)\.(?:load|store|atomic)|v128\.(?:load|store)|call|return_call|memory\.|unreachable)|\.(?:div|rem|trunc)/;

/**
 * The wasm ops from `ops[at]` up to, not including, the next op that has a table entry of its own (a memory access, a call, a division, a
 * truncation): the stretch of code the machine instructions after one table entry belong to. At most `max` ops.
 */
export function stretchOf(ops: { name: string }[], at: number, max = 14): string[] {
	const out = [ops[at]!.name];
	for (let k = at + 1; k < ops.length && out.length < max && !STOP.test(ops[k]!.name); k++) out.push(ops[k]!.name);
	return out;
}

export function classOf(s: Sample, katybug: Set<string>, region: RegExp): string {
	if (s.index >= 0) return region.test(s.name) ? 'region' : katybug.has(s.name) ? 'katybug (interpreter and runtime)' : 'other wasm';
	if (s.dso.includes('kernel') || s.dso === '[unknown]') return s.name === '[unknown]' ? 'kernel or unresolved' : 'host JS';
	if (s.name.startsWith('JS:')) return 'host JS';
	return 'V8 and node';
}

if (import.meta.main) {
	const args = process.argv.slice(2);
	const flag = (n: string) => args.find((a) => a.startsWith(`--${n}=`))?.slice(n.length + 3) ?? '';
	const samples = parseScript(readFileSync(flag('script'), 'utf8'));
	const codes = flag('dis')
		.split(',')
		.filter(Boolean)
		.flatMap((f) => parseDis(readFileSync(f, 'utf8')));
	const fns = parseObjdump(execFileSync(process.env.WASM_OBJDUMP ?? 'wasm-objdump', ['-d', flag('module')], { encoding: 'utf8', maxBuffer: 1 << 30 }));
	const names = new Set(fns.map((f) => f.name));
	const startOf = new Map(fns.map((f) => [f.index, f.start]));
	const rows = readFileSync(flag('ops'), 'utf8')
		.split('\n')
		.slice(1)
		.filter(Boolean)
		.map((l) => l.split('\t'));
	const byOff = new Map(rows.map((r) => [Number(r[0]), { cat: r[2]!, line: r[3]!, op: '' }]));
	for (const f of fns) for (const o of f.ops) if (byOff.has(o.off)) byOff.get(o.off)!.op = o.name;
	const region = new RegExp(flag('region') || '^r\\d+_(run|go)$');
	const total = samples.length;
	const cls = new Map<string, number>();
	const cat = new Map<string, number>();
	const shape = new Map<string, number>();
	const combined = new Map<string, number>();
	const perFn = new Map<string, number>();
	const pat = new Map<string, { n: number; lines: Map<string, number> }>();
	const spread = new Map<string, number>();
	const fnOf = new Map(fns.map((f) => [f.index, f]));
	const opIndex = new Map<number, Map<number, number>>();
	const bump = (m: Map<string, number>, k: string) => m.set(k, (m.get(k) ?? 0) + 1);
	const byKey = new Map(codes.map((c) => [`${c.name}|${c.index}`, c]));
	let inRegion = 0;
	for (const s of samples) {
		const c = classOf(s, names, region);
		bump(cls, c);
		if (c !== 'region') continue;
		inRegion++;
		const code = byKey.get(`${s.name}|${s.index}`);
		const insn = code && lastAtMost(code.insns, s.off, (i) => i.off);
		const sh = insn ? shapeOf(insn.text) : 'no listing';
		bump(shape, sh);
		const p = code && lastAtMost(code.positions, s.off, (q) => q.pc);
		const start = startOf.get(s.index);
		const hit = p && start !== undefined ? byOff.get(start + p.pos) : undefined;
		const k = hit ? hit.cat : 'unmapped';
		bump(cat, k);
		bump(perFn, `${s.name}\t${k}`);
		bump(combined, sh === 'spill store' || sh === 'spill load' || sh === 'call' ? sh : k);
		if (hit) {
			const f = fnOf.get(s.index);
			let at = opIndex.get(s.index);
			if (!at && f) opIndex.set(s.index, (at = new Map(f.ops.map((o, i) => [o.off, i]))));
			const ai = at?.get(start! + p!.pos) ?? -1;
			const seq = f && ai >= 0 ? stretchOf(f.ops, ai) : [hit.op];
			if (f && ai >= 0) {
				// inferred: each op of the stretch costs the same, so a sample is split over their categories
				for (let j = 0; j < seq.length; j++) {
					const jc = byOff.get(f.ops[ai + j]!.off)?.cat ?? 'unmapped';
					spread.set(jc, (spread.get(jc) ?? 0) + 1 / seq.length);
				}
			} else spread.set(k, (spread.get(k) ?? 0) + 1);
			const key = `${hit.cat}\t${seq.join(' ')}`;
			const e = pat.get(key) ?? pat.set(key, { n: 0, lines: new Map() }).get(key)!;
			e.n++;
			bump(e.lines, hit.line);
		} else spread.set('unmapped', (spread.get('unmapped') ?? 0) + 1);
	}
	const table = (title: string, m: Map<string, number>, of: number) => {
		console.log(`\n${title}\nrow\tsamples\tshare`);
		for (const [k, v] of [...m].sort((a, b) => b[1] - a[1])) console.log(`${k}\t${v}\t${((100 * v) / of).toFixed(1)}%`);
	};
	console.log(`samples ${total}, in region functions ${inRegion}`);
	table('where the samples are', cls, total);
	table('region samples by the op the last table entry names (category of the nearest preceding trapping or calling op)', cat, inRegion);
	table('region samples by the instruction shape', shape, inRegion);
	table('region samples, spills and calls by shape, the rest by the map', combined, inRegion);
	if (flag('per-function')) table('region samples by function and category', perFn, inRegion);
	table('region samples with each stretch spread over its ops by their categories (inferred: every op in a stretch costs the same)', spread, inRegion);
	console.log('\ntop patterns: category, the wasm ops from the table entry to the next one (the stretch), samples, share of region samples, hottest line (guest pc) of it');
	for (const [k, e] of [...pat].sort((a, b) => b[1].n - a[1].n).slice(0, 20)) {
		const top = [...e.lines].sort((a, b) => b[1] - a[1])[0]!;
		console.log(`${k}\t${e.n}\t${((100 * e.n) / inRegion).toFixed(1)}%\t${top[0]} (${top[1]})`);
	}
}
