import binaryen from 'binaryen';
import cp from 'node:child_process';
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { join } from 'node:path';
import { afterAll } from 'vitest';
import {
	attribute,
	entries,
	instrument,
	kept,
	sha,
	templates,
	type Instrumented,
	type Origin,
	type Template
} from '../../scripts/lcov/wat.ts';

// the wat flag's recorder (scripts/lcov/wat.ts): counters into every fixture or pass output the
// suite parses, the instances that carry them, and a record per test file
interface Unit extends Instrumented {
	origins: Origin[];
}
interface State {
	origins: Map<string, Origin[]>;
	units: Map<string, Unit>;
	instances: WebAssembly.Instance[];
	templates: Map<string, Template[]>;
	seq: number;
	files: number;
}
const KEY = Symbol.for('gmux.wat-coverage');
const dir = process.env.GMUX_WAT_COVERAGE!;
const root = join(import.meta.dirname, '../..');
const g = globalThis as unknown as Record<symbol, State>;

if (!g[KEY]) {
	const s: State = (g[KEY] = {
		origins: new Map(),
		units: new Map(),
		instances: [],
		templates: new Map(),
		seq: 0,
		files: 0
	});
	for (const name of readdirSync(join(root, 'tests/fixtures')).filter((f) =>
		f.endsWith('.wat')
	)) {
		const text = readFileSync(join(root, 'tests/fixtures', name), 'utf8');
		s.origins.set(
			sha(text),
			text.split('\n').map((_, i) => ({ file: `tests/fixtures/${name}`, line: i + 1 }))
		);
	}
	// instances whose module carries counters
	const W = WebAssembly as unknown as Record<string, unknown>;
	const Instance = WebAssembly.Instance;
	const noted = (i: WebAssembly.Instance) => {
		for (const k in i.exports) if (k.startsWith('__cov_')) return (s.instances.push(i), i);
		return i;
	};
	const Hooked = function (module: WebAssembly.Module, imports?: WebAssembly.Imports) {
		return noted(new Instance(module, imports));
	};
	Hooked.prototype = Instance.prototype;
	W.Instance = Hooked;
	const instantiate = WebAssembly.instantiate;
	W.instantiate = async (...a: Parameters<typeof WebAssembly.instantiate>) => {
		const r = (await instantiate(...a)) as
			WebAssembly.Instance | WebAssembly.WebAssemblyInstantiatedSource;
		noted('instance' in r ? r.instance : r);
		return r;
	};
	// a pass run: its output's lines come from the input's or from the pass's templates
	const execFileSync = cp.execFileSync;
	cp.execFileSync = function (
		this: unknown,
		file: string,
		args?: readonly string[],
		opts?: object
	) {
		const r = (execFileSync as (...x: unknown[]) => unknown).call(this, file, args, opts);
		const pass = args?.[0]?.match(/(?:^|\/)(scripts\/wasm\/[\w-]+-pass\.ts)$/)?.[1];
		if (pass && args!.length >= 3) {
			const before = readFileSync(args![1]!, 'utf8');
			const after = readFileSync(args![2]!, 'utf8');
			if (!s.templates.has(pass))
				s.templates.set(pass, templates(readFileSync(join(root, pass), 'utf8')));
			const a = before.split('\n');
			const b = after.split('\n');
			const map = kept(a, b);
			const from = s.origins.get(sha(before));
			const tpl = attribute(b, map, s.templates.get(pass)!);
			s.origins.set(
				sha(after),
				b.map((_, y) =>
					map[y]! >= 0
						? (from?.[map[y]!] ?? null)
						: tpl[y] != null
							? { file: pass, line: tpl[y]! }
							: null
				)
			);
		}
		return r;
	} as typeof cp.execFileSync;
	syncBuiltinESMExports();
}
const s = g[KEY];

// binaryen is evaluated again for each test file
const B = binaryen as unknown as Record<string | symbol, unknown>;
if (!B[KEY]) {
	const parseText = binaryen.parseText;
	B.parseText = (text: string) => {
		const origins = s.origins.get(sha(text));
		if (!origins) return parseText(text);
		const unit = `${process.pid}_${s.seq++}`;
		const u = instrument(text, unit);
		s.units.set(unit, { ...u, origins });
		return parseText(u.text);
	};
	B[KEY] = true;
}

afterAll(() => {
	const counts = new Map<string, number[]>();
	for (const i of s.instances)
		for (const [k, v] of Object.entries(i.exports)) {
			const m = k.match(/^__cov_(\d+_\d+)_(\d+)$/);
			if (!m) continue;
			if (!counts.has(m[1]!)) counts.set(m[1]!, []);
			const c = counts.get(m[1]!)!;
			c[Number(m[2])] = (c[Number(m[2])] ?? 0) + Number((v as WebAssembly.Global).value);
		}
	const out: [string, number, number][] = [];
	for (const [unit, u] of s.units)
		out.push(...entries(u.lines, u.origins, counts.get(unit) ?? []));
	writeFileSync(join(dir, `${process.pid}-${s.files++}.json`), JSON.stringify(out));
	s.units.clear();
	s.instances.length = 0;
});
