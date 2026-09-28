import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { formatLcov, report, type FileCoverage } from './lcov.ts';

/**
 * The `wat` flag: a counter per function and per block of every wat the unit suite parses (the
 * tests/fixtures toy kernels and programs, and what scripts/wasm/*-pass.ts made of them), read after
 * the suite and mapped back to lines. The counters go in inline, so the instrumented text keeps its
 * line numbers; a line counts as its innermost function or block at its first token. A pass's
 * output lines map to the input lines they kept (diff), and the lines it inserted to the template
 * lines in the pass's source that produced them.
 * `scripts/lcov/wat.ts [--out coverage/wat.info]` runs the suite (tests/lcov/vitest.config.ts)
 * and merges; `scripts/lcov/wat.ts --merge <dir>` merges a run's records only
 */

export interface Token {
	t: '(' | ')' | 'a';
	text: string;
	line: number;
	at: number;
}

export function tokenize(src: string): Token[] {
	const out: Token[] = [];
	let line = 1;
	let i = 0;
	while (i < src.length) {
		const c = src[i]!;
		if (c === '\n') {
			line++;
			i++;
		} else if (c === ' ' || c === '\t' || c === '\r') i++;
		else if (c === ';' && src[i + 1] === ';') while (i < src.length && src[i] !== '\n') i++;
		else if (c === '(' && src[i + 1] === ';') {
			let depth = 0;
			do {
				if (src[i] === '(' && src[i + 1] === ';') (depth++, (i += 2));
				else if (src[i] === ';' && src[i + 1] === ')') (depth--, (i += 2));
				else if (src[i++] === '\n') line++;
			} while (depth > 0 && i < src.length);
		} else if (c === '(' || c === ')') out.push({ t: c, text: c, line, at: i++ });
		else if (c === '"') {
			const s = i++;
			while (i < src.length && src[i] !== '"') i += src[i] === '\\' ? 2 : 1;
			out.push({ t: 'a', text: src.slice(s, ++i), line, at: s });
		} else {
			const s = i;
			while (i < src.length && !' \t\r\n()";'.includes(src[i]!)) i++;
			if (i === s) i++;
			else out.push({ t: 'a', text: src.slice(s, i), line, at: s });
		}
	}
	return out;
}

export interface Instrumented {
	text: string;
	counters: number;
	/** line -> counter of its innermost function or block */
	lines: Map<number, number>;
}

const FUNC_HEADER = ['export', 'import', 'type', 'param', 'result', 'local'];
const BRANCH = ['br', 'br_if', 'br_table', 'return', 'unreachable', 'throw', 'rethrow'];
const BLOCK_HEADER = ['type', 'param', 'result'];

export const counterName = (unit: string, n: number) => `__cov_${unit}_${n}`;

/** counters inline after each function's and block's header; unit keeps the names unique */
export function instrument(src: string, unit: string): Instrumented {
	const toks = tokenize(src);
	const inserts: [number, string][] = [];
	const lines = new Map<number, number>();
	const bump = (n: number) => {
		const g = `$${counterName(unit, n)}`;
		return `(global.set ${g} (i32.add (global.get ${g}) (i32.const 1))) `;
	};
	const frames: { head: string; depth: number }[] = [];
	const regions: number[] = [];
	const imported = new Set<number>();
	let counters = 0;
	let inFunc = false;
	let moduleClose = -1;
	let pending: { n: number; header: string[]; label: boolean; tag: boolean } | null = null;
	const open = (n: number, header: string[], label: boolean, tag = false) => {
		regions.push(n);
		pending = { n, header, label, tag };
	};
	const note = (tk: Token) => {
		if (inFunc && tk.t !== ')' && regions.length && !lines.has(tk.line))
			lines.set(tk.line, regions.at(-1)!);
	};
	// the code after a block gets a counter of its own, since the block may have branched away
	let after = false;
	for (let i = 0; i < toks.length; i++) {
		const tk = toks[i]!;
		if (after) {
			after = false;
			const w = tk.t === 'a' ? tk.text : '';
			if (
				tk.t !== ')' &&
				!['else', 'end', 'catch', 'catch_all', 'delegate'].includes(w) &&
				regions.length
			) {
				const n = counters++;
				regions[regions.length - 1] = n;
				inserts.push([tk.at, bump(n)]);
			}
		}
		const p = pending as { n: number; header: string[]; label: boolean; tag: boolean } | null;
		if (p) {
			if (tk.t === 'a' && (p.tag || (p.label && tk.text.startsWith('$')))) {
				p.tag = p.label = false;
				note(tk);
				continue;
			}
			const head = toks[i + 1];
			if (tk.t === '(' && head?.t === 'a' && p.header.includes(head.text)) {
				if (head.text === 'import') imported.add(p.n);
				for (let depth = 0; i < toks.length; i++) {
					depth += toks[i]!.t === '(' ? 1 : toks[i]!.t === ')' ? -1 : 0;
					if (!depth) break;
				}
				continue;
			}
			if (!imported.has(p.n)) inserts.push([tk.at, bump(p.n)]);
			pending = null;
		}
		if (tk.t === '(') {
			const head = toks[i + 1]?.t === 'a' ? toks[i + 1]!.text : '';
			// a definition is a module field, not the func of an import or a type
			const field = frames.at(-1)?.head === 'module';
			frames.push({ head, depth: regions.length });
			if (head) i++;
			if (head === 'module') continue;
			if (head === 'func' && field) {
				inFunc = true;
				open(counters++, FUNC_HEADER, true);
			} else if (!inFunc) continue;
			else if (head === 'block' || head === 'loop') open(counters++, BLOCK_HEADER, true);
			else if (head === 'then' || head === 'else' || head === 'do' || head === 'catch_all')
				open(counters++, [], false);
			else if (head === 'catch') open(counters++, [], false, true);
			note(tk);
		} else if (tk.t === ')') {
			const f = frames.pop();
			if (!f) continue;
			if (f.head === 'module') moduleClose = tk.at;
			if (f.head === 'func') inFunc = false;
			regions.length = Math.min(regions.length, f.depth);
			if (
				inFunc &&
				(['block', 'loop', 'if', 'try'].includes(f.head) || BRANCH.includes(f.head))
			)
				after = true;
		} else if (inFunc) {
			const w = tk.text;
			if (w === 'end' || w === 'delegate') {
				note(tk);
				regions.pop();
				after = true;
				if (toks[i + 1]?.t === 'a' && toks[i + 1]!.text.startsWith('$')) i++;
				continue;
			}
			if (BRANCH.includes(w)) {
				// the code after a branch runs only when it is not taken
				note(tk);
				while (toks[i + 1]?.t === 'a' && /^(\$|\d)/.test(toks[i + 1]!.text)) i++;
				after = true;
				continue;
			}
			if (w === 'block' || w === 'loop' || w === 'if' || w === 'try')
				open(counters++, BLOCK_HEADER, true);
			else if (w === 'else' || w === 'catch' || w === 'catch_all') {
				regions.pop();
				open(counters++, [], w === 'else', w === 'catch');
			}
			note(tk);
		}
	}
	for (const [line, n] of lines) if (imported.has(n)) lines.delete(line);
	if (moduleClose < 0) return { text: src, counters: 0, lines: new Map() };
	const globals = Array.from({ length: counters }, (_, n) => {
		const g = counterName(unit, n);
		return `(global $${g} (export "${g}") (mut i32) (i32.const 0))`;
	});
	inserts.push([moduleClose, globals.join(' ')]);
	let text = src;
	for (const [at, s] of inserts.sort((a, b) => b[0] - a[0]))
		text = text.slice(0, at) + s + text.slice(at);
	return { text, counters, lines };
}

/** where a line came from: a repo file's line, or nowhere the report can name */
export type Origin = { file: string; line: number } | null;

/** for each line of b, the line of a it kept (Myers' diff), or -1 for an inserted one */
export function kept(a: string[], b: string[]): Int32Array {
	const n = a.length;
	const m = b.length;
	const off = n + m + 1;
	const v = new Int32Array(2 * off + 1);
	const trace: Int32Array[] = [];
	search: for (let d = 0; d <= n + m; d++) {
		trace.push(v.slice());
		for (let k = -d; k <= d; k += 2) {
			let x =
				k === -d || (k !== d && v[off + k - 1]! < v[off + k + 1]!)
					? v[off + k + 1]!
					: v[off + k - 1]! + 1;
			let y = x - k;
			while (x < n && y < m && a[x] === b[y]) (x++, y++);
			v[off + k] = x;
			if (x >= n && y >= m) break search;
		}
	}
	const map = new Int32Array(m).fill(-1);
	let x = n;
	let y = m;
	for (let d = trace.length - 1; d >= 0; d--) {
		const w = trace[d]!;
		const k = x - y;
		const pk = k === -d || (k !== d && w[off + k - 1]! < w[off + k + 1]!) ? k + 1 : k - 1;
		const px = w[off + pk]!;
		const py = px - pk;
		while (x > px && y > py) map[--y] = --x;
		if (d > 0) ((x = px), (y = py));
	}
	return map;
}

export interface Template {
	/** the line in the pass's source */
	line: number;
	re: RegExp;
	/** an instruction or a function (not a declaration), so a line the report shows even at 0 */
	code: boolean;
}

const WAT_WORD =
	/^\(?(local|global|i32|i64|f32|f64|v128|memory|table|call|call_indirect|return|return_call|br|br_if|br_table|if|else|end|loop|block|then|drop|select|unreachable|nop|try|catch|catch_all|throw|rethrow|delegate|ref|func|param|result|import|export|type|elem|data|module)\b/;
const DECLARATION =
	/^\((import|export|type|param|result|local|global|elem|data|table|memory|module)\b/;
const HOLE = '\u0000';

/** whether the literal at offset is an element of an array literal followed by .map or .join */
function joined(source: string, offset: number): boolean {
	let depth = 0;
	for (let i = offset; i >= 0; i--) {
		const c = source[i];
		if (c === ']') depth++;
		else if (c === '[' && !depth--) {
			for (let j = i + 1, d = 1; j < source.length; j++) {
				d += source[j] === '[' ? 1 : source[j] === ']' ? -1 : 0;
				if (!d) return /^\s*\.\s*(map|join)\b/.test(source.slice(j + 1, j + 40));
			}
			return false;
		} else if (c === ';' || c === '{' || c === '}') return false;
	}
	return false;
}

/** the wat lines a pass's TypeScript source writes out, from its string and template literals */
export function templates(source: string): Template[] {
	// fragments: line, text, literal; literals: first and last line, offset
	const frags: [number, string, number][] = [];
	const lits: [number, number, number][] = [];
	let line = 1;
	// the literal being read, and the templates whose ${} it sits in
	const bufs: string[] = [];
	const ids: number[] = [];
	const quotes: string[] = [];
	const braces: number[] = [];
	let state: 'code' | 'str' | 'line' | 'block' = 'code';
	const flush = () => {
		frags.push([line, bufs[bufs.length - 1]!, ids[ids.length - 1]!]);
		bufs[bufs.length - 1] = '';
	};
	for (let i = 0; i < source.length; i++) {
		const c = source[i]!;
		if (state === 'code') {
			if (c === '/' && source[i + 1] === '/') state = 'line';
			else if (c === '/' && source[i + 1] === '*') state = 'block';
			else if (c === "'" || c === '"' || c === '`') {
				state = 'str';
				quotes.push(c);
				bufs.push('');
				ids.push(lits.push([line, line, i]) - 1);
			} else if (c === '{' && braces.length) braces[braces.length - 1]!++;
			else if (c === '}' && braces.length && !braces[braces.length - 1]!--) {
				braces.pop();
				state = 'str';
			}
		} else if (state === 'line') {
			if (c === '\n') state = 'code';
		} else if (state === 'block') {
			if (c === '*' && source[i + 1] === '/') ((state = 'code'), i++);
		} else if (c === '\\') {
			const e = source[++i]!;
			if (e === 'n') flush();
			else bufs[bufs.length - 1] += e === 't' ? '\t' : e;
		} else if (c === quotes[quotes.length - 1]) {
			flush();
			lits[ids.pop()!]![1] = line;
			bufs.pop();
			quotes.pop();
			state =
				braces.length && quotes.length === braces.length
					? 'code'
					: quotes.length
						? 'str'
						: 'code';
		} else if (quotes[quotes.length - 1] === '`' && c === '$' && source[i + 1] === '{') {
			bufs[bufs.length - 1] += HOLE;
			braces.push(0);
			state = 'code';
			i++;
		} else if (c === '\n') flush();
		else bufs[bufs.length - 1] += c;
		if (c === '\n') line++;
	}
	const out: Template[] = [];
	for (const [at, raw, lit] of frags) {
		const text = raw.trim();
		if (!WAT_WORD.test(text) || !text.replaceAll(HOLE, '').trim()) continue;
		// wat is a literal over several lines, an instruction with operands, or a lone word in an array
		// of lines that is mapped or joined; a lone word elsewhere ('i32', 'loop', an opcode list) is
		// a key or a comparison, and so is anything a line is compared against
		const [first, last, offset] = lits[lit]!;
		if (first === last && !/[\s(]/.test(text) && !joined(source, offset)) continue;
		if (
			/(With|includes|indexOf|search|match|split|replace|test|[=!]==?)\s*\(?\s*$/.test(
				source.slice(offset - 24, offset)
			)
		)
			continue;
		const re = text
			.split(HOLE)
			.map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
			.join('.*?');
		out.push({ line: at, re: new RegExp(`^${re}$`), code: !DECLARATION.test(text) });
	}
	return out;
}

/** each output line's template line, for the lines a pass inserted (kept[y] < 0) */
export function attribute(out: string[], keptMap: Int32Array, tpls: Template[]): (number | null)[] {
	const res: (number | null)[] = Array(out.length).fill(null);
	const matches = (y: number) =>
		keptMap[y]! < 0 && out[y]!.trim()
			? tpls.filter((t) => t.re.test(out[y]!.trim())).map((t) => t.line)
			: [];
	let prev = -1;
	for (let y = 0; y < out.length; y++) {
		const c = matches(y);
		if (!c.length) {
			prev = -1;
			continue;
		}
		let pick = c.includes(prev + 1) ? prev + 1 : -1;
		if (pick < 0) {
			let best = -1;
			for (const line of c) {
				let run = 0;
				while (y + run + 1 < out.length && matches(y + run + 1).includes(line + run + 1))
					run++;
				if (run > best) ((best = run), (pick = line));
			}
		}
		res[y] = prev = pick;
	}
	return res;
}

export const sha = (text: string) => createHash('sha256').update(text).digest('hex');

/** a unit's lines as report entries: its counters' totals at the lines they came from */
export function entries(lines: Map<number, number>, origins: Origin[], counts: number[]) {
	const out: [string, number, number][] = [];
	for (const [line, n] of lines) {
		const o = origins[line - 1];
		if (o) out.push([o.file, o.line, counts[n] ?? 0]);
	}
	return out;
}

const PASSES = 'scripts/wasm';
const FIXTURES = 'tests/fixtures';

/** every fixture's and every pass template's line at 0, plus the records a run wrote */
export function merge(root: string, dir: string): FileCoverage[] {
	const files = new Map<string, FileCoverage>();
	const add = (file: string, line: number, n: number) => {
		if (!files.has(file)) files.set(file, { file, lines: new Map() });
		const f = files.get(file)!;
		f.lines.set(line, (f.lines.get(line) ?? 0) + n);
	};
	for (const name of readdirSync(join(root, FIXTURES)).filter((f) => f.endsWith('.wat'))) {
		const file = `${FIXTURES}/${name}`;
		for (const line of instrument(readFileSync(join(root, file), 'utf8'), 'm').lines.keys())
			add(file, line, 0);
	}
	for (const name of readdirSync(join(root, PASSES)).filter((f) => f.endsWith('-pass.ts'))) {
		const file = `${PASSES}/${name}`;
		for (const t of templates(readFileSync(join(root, file), 'utf8')))
			if (t.code) add(file, t.line, 0);
	}
	if (existsSync(dir))
		for (const name of readdirSync(dir).filter((f) => f.endsWith('.json')))
			for (const [file, line, n] of JSON.parse(readFileSync(join(dir, name), 'utf8')) as [
				string,
				number,
				number
			][])
				add(file, line, n);
	return [...files.values()];
}

if (import.meta.main) {
	const root = join(import.meta.dirname, '../..');
	const args = process.argv.slice(2);
	const at = args.indexOf('--out');
	const outFile = join(root, at >= 0 ? args[at + 1]! : 'coverage/wat.info');
	const m = args.indexOf('--merge');
	let dir = m >= 0 ? args[m + 1]! : '';
	if (!dir) {
		dir = join(root, 'build/coverage/wat', new Date().toISOString().replace(/[:.]/g, '-'));
		mkdirSync(dir, { recursive: true });
		execFileSync('bunx', ['vitest', 'run', '--config', 'tests/lcov/vitest.config.ts'], {
			cwd: root,
			stdio: 'inherit',
			env: { ...process.env, GMUX_WAT_COVERAGE: dir }
		});
	}
	const lcov = formatLcov(merge(root, dir));
	mkdirSync(join(outFile, '..'), { recursive: true });
	writeFileSync(outFile, lcov);
	process.exit(report('coverage wat', lcov));
}
