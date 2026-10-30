import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';

/**
 * Maps the ops of an instrumented module back to the line table of the module it came from. `instrument.sh` rewrites
 * the module through wat, so the DWARF of `katybug.wasm` names offsets `katybug.inst.wasm` does not have; the passes only
 * insert ops (fuel and stack checks), so every op of the original is found again, in order, in the final module.
 * The result is a source map v3 whose sources are the line table's files (the emitter's and lifter's categories) and
 * whose columns are the final module's byte offsets, appended as a `sourceMappingURL` section, and a table of
 * `inst offset, pre offset, category, guest pc` per op.
 *
 * `opmap.ts [--aot-h=<aot.h>] [--ops=<ops.tsv>] <pre.wasm> <inst.wasm> <out.wasm> <out.map>`
 * needs wasm-objdump (`WASM_OBJDUMP`) and llvm-dwarfdump (`LLVM_DWARFDUMP`)
 */

export interface Op {
	off: number;
	name: string;
	text: string;
}
export interface Fn {
	start: number;
	// the function's index in the module, imports counted
	index: number;
	name: string;
	ops: Op[];
}
export interface Row {
	addr: number;
	line: number;
	file: string;
	end: boolean;
}

// wasm-objdump -d: `000169 func[0] <name>:` then ` 00016a: 0b   | end`
export function parseObjdump(text: string): Fn[] {
	const fns: Fn[] = [];
	for (const l of text.split('\n')) {
		const f = /^([0-9a-f]{6}) func\[(\d+)\](?: <(.*)>)?:/.exec(l);
		if (f) {
			fns.push({ start: parseInt(f[1]!, 16), index: Number(f[2]), name: f[3] ?? '', ops: [] });
			continue;
		}
		const o = /^ ([0-9a-f]{6}): [0-9a-f ]+\| (.*)$/.exec(l);
		if (o && fns.length && !o[2]!.startsWith('local[')) {
			const t = o[2]!.replace(/\s*<[^>]*>\s*$/, '').trim();
			fns.at(-1)!.ops.push({ off: parseInt(o[1]!, 16), name: t.split(/\s+/)[0]!, text: t });
		}
	}
	return fns;
}

// llvm-dwarfdump --debug-line: a file table and a row table per line program; rows name a file by its index
export function parseLines(text: string): Row[] {
	const rows: Row[] = [];
	let files = new Map<number, string>();
	let name = -1;
	for (const l of text.split('\n')) {
		if (l.startsWith('debug_line[')) files = new Map();
		const fi = /^file_names\[\s*(\d+)\]/.exec(l);
		if (fi) name = Number(fi[1]);
		const nm = /^\s+name: "(.*)"/.exec(l);
		if (nm && name >= 0) {
			files.set(name, nm[1]!.split('/').at(-1)!);
			name = -1;
		}
		const r = /^0x([0-9a-f]+)\s+(\d+)\s+\d+\s+(\d+)\s+\d+\s+\d+\s+\d+\s+(.*)$/.exec(l);
		if (r) rows.push({ addr: parseInt(r[1]!, 16), line: Number(r[2]), file: files.get(Number(r[3])) ?? '?', end: r[4]!.includes('end_sequence') });
	}
	return rows;
}

// ops whose immediates are indexes the passes move (a new import, global, local and function shift them): matched by name only
const INDEXED = new Set(['call', 'call_indirect', 'return_call', 'return_call_indirect', 'ref.func', 'local.get', 'local.set', 'local.tee', 'global.get', 'global.set']);
const key = (o: Op) => (INDEXED.has(o.name) ? o.name : o.text);
// what the passes insert as one run (fuel-pass.ts, stack-pass.ts), by op name
const WINDOWS = [
	'global.get i32.const i32.sub global.set global.get i32.const i32.lt_s if call global.set end',
	'local.get i32.const i32.sub local.tee i32.const i32.lt_s if local.get global.set call local.tee global.set end',
	'local.tee global.get i32.sub global.get i32.gt_u if local.get call else local.get end'
].map((w) => w.split(' '));

/** the index in `inst` of each op of `pre`; throws where an op of `pre` has no place left. The rest of `inst` is inserted */
export function align(pre: Op[], inst: Op[]): number[] {
	const at: number[] = [];
	let i = 0;
	for (let j = 0; j < inst.length; j++) {
		const w = WINDOWS.find((p) => p.every((n, k) => inst[j + k]?.name === n));
		if (w && (i >= pre.length || key(pre[i]!) === (inst[j + w.length] === undefined ? '' : key(inst[j + w.length]!)))) {
			j += w.length - 1;
			continue;
		}
		if (i < pre.length && key(pre[i]!) === key(inst[j]!)) {
			at.push(j);
			i++;
		}
	}
	if (i < pre.length) throw new Error(`op ${i} of ${pre.length} (${pre[i]!.text}) has no match in ${inst.length} ops`);
	return at;
}

const run = (bin: string, args: string[]) => execFileSync(bin, args, { encoding: 'utf8', maxBuffer: 1 << 30 });

// where the line table's addresses start: the code section's payload, count included
export function codeStart(headers: string): number {
	const m = /Code start=0x([0-9a-f]+)/.exec(headers);
	if (!m) throw new Error('no code section');
	return parseInt(m[1]!, 16);
}

/** the row covering each op: the last row at or before it, unless a sequence ended first */
export function rowsOf(ops: Op[], rows: Row[], base: number): (Row | undefined)[] {
	const sorted = rows.map((r) => ({ ...r, addr: r.addr + base })).sort((a, b) => a.addr - b.addr || Number(b.end) - Number(a.end));
	const out: (Row | undefined)[] = [];
	let k = 0;
	for (const o of ops) {
		while (k + 1 < sorted.length && sorted[k + 1]!.addr <= o.off) k++;
		const r = sorted[k];
		out.push(r && !r.end && r.addr <= o.off ? r : undefined);
	}
	return out;
}

// aot.h's inline helpers by the category of what they compute, by line
export function helperRanges(text: string): { from: number; cat: string }[] {
	const out: { from: number; cat: string }[] = [];
	text.split('\n').forEach((l, n) => {
		const f = /^static [^(]*?\b(\w+)\(/.exec(l.replace(/__attribute__\(\([^)]*\)\)/g, ''));
		if (!f) return;
		const name = f[1]!;
		const cat = /flags|cond/.test(name) ? 'flags' : /mask|sext|parity|umulh|smulh|muldiv/.test(name) ? 'arith' : /host|slow|gen|continue|ic_/.test(name) ? 'guards' : 'calls';
		out.push({ from: n + 1, cat });
	});
	return out;
}

export function categoryOf(r: Row | undefined, cats: Set<string>, helpers: { from: number; cat: string }[]): string {
	if (!r) return 'unmapped';
	if (cats.has(r.file)) return r.file;
	if (r.file === 'aot.h') return helpers.filter((h) => h.from <= r.line).at(-1)?.cat ?? 'calls';
	return 'runtime';
}

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
export const vlq = (n: number) => {
	let v = n < 0 ? (-n << 1) | 1 : n << 1;
	let s = '';
	do {
		let d = v & 31;
		v >>>= 5;
		if (v > 0) d |= 32;
		s += B64[d];
	} while (v > 0);
	return s;
};

export function sourceMap(segs: { col: number; src: number; line: number }[], sources: string[]): string {
	let pc = 0;
	let ps = 0;
	let pl = 0;
	const out = segs.map((s) => {
		const x = vlq(s.col - pc) + vlq(s.src - ps) + vlq(s.line - pl) + vlq(0);
		pc = s.col;
		ps = s.src;
		pl = s.line;
		return x;
	});
	return JSON.stringify({ version: 3, sources, names: [], mappings: out.join(',') });
}

const leb = (n: number) => {
	const b: number[] = [];
	do {
		let x = n & 127;
		n >>>= 7;
		if (n) x |= 128;
		b.push(x);
	} while (n);
	return b;
};
export function sourceMappingSection(url: string): Buffer {
	const name = Buffer.from('sourceMappingURL');
	const u = Buffer.from(url);
	const body = Buffer.concat([Buffer.from(leb(name.length)), name, Buffer.from(leb(u.length)), u]);
	return Buffer.concat([Buffer.from([0, ...leb(body.length)]), body]);
}

if (import.meta.main) {
	const args = process.argv.slice(2);
	const flag = (n: string) => args.find((a) => a.startsWith(`--${n}=`))?.slice(n.length + 3);
	const [prePath = '', instPath = '', outPath = '', mapPath = ''] = args.filter((a) => !a.startsWith('--'));
	const objdump = process.env.WASM_OBJDUMP ?? 'wasm-objdump';
	const dwarf = process.env.LLVM_DWARFDUMP ?? 'llvm-dwarfdump';
	const preFns = parseObjdump(run(objdump, ['-d', prePath]));
	const instFns = parseObjdump(run(objdump, ['-d', instPath]));
	const rows = parseLines(run(dwarf, ['--debug-line', prePath]));
	const base = codeStart(run(objdump, ['-h', prePath]));
	const aotH = flag('aot-h');
	const helpers = aotH ? helperRanges(readFileSync(aotH, 'utf8')) : [];
	const cats = new Set(['arith', 'state', 'flags', 'address', 'guards', 'guest', 'dispatch', 'calls', 'safepoints']);
	const extra = instFns.length - preFns.length;
	if (extra !== 0 && extra !== 1) throw new Error(`${instFns.length} functions after ${preFns.length}`);
	const sources: string[] = [];
	const src = (c: string) => (sources.includes(c) ? sources.indexOf(c) : sources.push(c) - 1);
	const segs: { col: number; src: number; line: number }[] = [];
	const lines: string[] = ['inst\tpre\tcategory\tline'];
	const tally = new Map<string, number>();
	const byFile = new Map<string, number>();
	let inserted = 0;
	let total = 0;
	let matched = 0;
	instFns.forEach((fn, k) => {
		const pf = preFns[k - extra];
		const instOf = pf ? align(pf.ops, fn.ops) : [];
		const rowFor = pf ? rowsOf(pf.ops, rows, base) : [];
		const byInst = new Map(instOf.map((j, p) => [j, p]));
		fn.ops.forEach((o, j) => {
			const p = byInst.get(j);
			const r = p === undefined ? undefined : rowFor[p];
			const cat = p === undefined ? 'instrumentation' : categoryOf(r, cats, helpers);
			segs.push({ col: o.off, src: src(cat), line: r?.line ?? 0 });
			lines.push(`${o.off}\t${p === undefined ? '' : pf!.ops[p]!.off}\t${cat}\t${r?.line ?? ''}`);
			tally.set(cat, (tally.get(cat) ?? 0) + 1);
			if (r) byFile.set(r.file, (byFile.get(r.file) ?? 0) + 1);
			total++;
			if (p === undefined) inserted++;
			else matched++;
		});
	});
	const preOps = preFns.reduce((s, f) => s + f.ops.length, 0);
	if (matched !== preOps) throw new Error(`aligned ${matched} ops, the original has ${preOps}`);
	const mapName = mapPath.split('/').at(-1)!;
	writeFileSync(mapPath, sourceMap(segs, sources));
	writeFileSync(outPath, Buffer.concat([readFileSync(instPath), sourceMappingSection(mapName)]));
	const ops = flag('ops');
	if (ops) writeFileSync(ops, lines.join('\n') + '\n');
	console.error(`${total} ops in ${instFns.length} functions: ${matched} aligned (the original has ${preOps}), ${inserted} inserted`);
	for (const [c, n] of [...tally].sort((a, b) => b[1] - a[1])) console.error(`${c}\t${n}\t${((100 * n) / total).toFixed(1)}%`);
	console.error('files of the rows:', [...byFile].sort((a, b) => b[1] - a[1]).slice(0, 14).map(([f, n]) => `${f} ${n}`).join(', '));
}
