import { execFileSync, spawnSync } from 'node:child_process';
import {
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	symlinkSync,
	writeFileSync
} from 'node:fs';
import { join } from 'node:path';
import { formatLcov, report, type FileCoverage } from './lcov.ts';

/**
 * The `patch` flag: which of the kernel patches' changed lines run. vmlinux is staged as
 * scripts/build-kernel.sh stages it, plus an entry counter in every function (a second memory,
 * exported as gmux_cov, 8 bytes a function), the probes run on it (tests/c/run.ts with
 * patch-hook.ts reading the counters at exit), and every added line of a src/kernel/patches hunk
 * takes the entry count of the function it sits in. A hunk in a function the wasm has no body for
 * (inlined, a macro, a header) is not measurable and is left out rather than shown as missed.
 * `scripts/lcov/patch.ts <linux-wasm out dir> | --staged <vmlinux.wasm with names>`
 * `[--out coverage/patch.info]`; the rest of build/ (busybox, probes) comes from build/
 */

/** an entry counter after each function's locals; returns the functions in index order */
export function countEntries(wat: string): { text: string; names: string[] } {
	const lines = wat.split('\n');
	const names: string[] = [];
	const out: string[] = [];
	const bump = (k: number) =>
		`(i64.store 1 (i32.const ${8 * k}) (i64.add (i64.load 1 (i32.const ${8 * k})) (i64.const 1)))`;
	let memory = -1;
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i]!;
		if (!line.startsWith('  (func ')) {
			out.push(line);
			continue;
		}
		if (memory < 0) memory = out.length;
		const k = names.length;
		names.push(line.match(/^ {2}\(func \$(\S+)/)?.[1] ?? `#${k}`);
		if (count(line, '(') === count(line, ')')) {
			// the whole function on one line
			const end = line.lastIndexOf(')');
			out.push(`${line.slice(0, end)} ${bump(k)})`);
			continue;
		}
		out.push(line);
		while (lines[i + 1]?.trimStart().startsWith('(local ')) out.push(lines[++i]!);
		out.push(`    ${bump(k)}`);
	}
	const pages = Math.max(1, Math.ceil((8 * names.length) / 65536));
	out.splice(memory, 0, `  (memory $gmux.cov (export "gmux_cov") ${pages})`);
	return { text: out.join('\n'), names };
}
const count = (s: string, c: string) => s.split(c).length - 1;

/** a C function's name from a line that starts one (at column 0), with its syscall aliases */
export function definition(s: string): string[] | null {
	if (/^(\s|#|$|\}|\{|\/\*|\*|\/\/)/.test(s) || /[;=]\s*$/.test(s) || /^\w+:/.test(s))
		return null;
	if (/^(if|for|while|switch|return|else|do|typedef|extern)\b/.test(s)) return null;
	// an initializer (a table of function pointers) is data
	if (/(^|[^=!<>])=([^=]|$)/.test(s)) return null;
	const sys = s.match(/^(?:COMPAT_)?SYSCALL_DEFINE\d\((\w+)/);
	if (sys) return [`__do_sys_${sys[1]}`, `__se_sys_${sys[1]}`, `sys_${sys[1]}`];
	const m = s.match(/\b([A-Za-z_]\w*)\s*\(/);
	if (!m || /^(void|char|short|int|long|unsigned|signed|float|double|const|static)$/.test(m[1]!))
		return null;
	return [m[1]!];
}

export interface PatchLine {
	/** the line in the .patch file */
	line: number;
	/** the patched file, and the line there (after this patch) */
	file: string;
	at: number;
	text: string;
}

/** every added line of a patch's C files that is not blank, a comment or a directive */
export function added(patch: string): PatchLine[] {
	const out: PatchLine[] = [];
	const lines = patch.split('\n');
	let file = '';
	let at = 0;
	// lines of the hunk still to come, before and after
	let old = 0;
	let now = 0;
	for (let i = 0; i < lines.length; i++) {
		const l = lines[i]!;
		if (old <= 0 && now <= 0) {
			const target = l.match(/^\+\+\+ (?:b\/)?(\S+)/);
			if (target) file = /\.[ch]$/.test(target[1]!) ? target[1]! : '';
			const hunk = l.match(/^@@ -\d+(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/);
			if (hunk) {
				old = Number(hunk[1] ?? 1);
				at = Number(hunk[2]);
				now = Number(hunk[3] ?? 1);
			}
			continue;
		}
		if (l[0] === '-') old--;
		else if (l[0] === ' ' || l[0] === '+' || l === '') {
			const s = l.slice(1);
			if (l[0] === '+' && file && s.trim() && !/^\s*(#|\/\*|\*|\/\/)/.test(s))
				out.push({ line: i + 1, file, at, text: s });
			if (l[0] !== '+') old--;
			now--;
			at++;
		}
	}
	return out;
}

/** the function around a line of a C file (1-based), from the nearest definition above it */
export function enclosing(src: string[], at: number): string[] | null {
	for (let i = at - 1; i >= 0; i--) {
		const s = src[i]!;
		if (i < at - 1 && s.startsWith('}')) return null;
		if (!/^[A-Za-z_]/.test(s) || /^\w+:\s*$/.test(s)) continue;
		// a column-0 line other than a definition is the file's scope (a declaration)
		return definition(s);
	}
	return null;
}

/** the files each patch leaves, applied in order over the pristine ones (as build-linux.sh does) */
export function trees(base: string, patches: string[], work: string): string[] {
	let prev = base;
	return patches.map((p, n) => {
		const dir = join(work, `s${n}`);
		mkdirSync(work, { recursive: true });
		execFileSync('cp', ['-R', prev, dir]);
		// not the repository the work directory may sit in
		execFileSync('git', ['apply', p], {
			cwd: dir,
			env: { ...process.env, GIT_CEILING_DIRECTORIES: work }
		});
		return (prev = dir);
	});
}

/** entry counts by function name (the wat's duplicate-name suffixes folded together) */
export function byName(names: string[], counts: number[]): Map<string, number> {
	const m = new Map<string, number>();
	names.forEach((n, k) => {
		const base = n.replace(/\.\d+$/, '');
		m.set(base, (m.get(base) ?? 0) + (counts[k] ?? 0));
	});
	return m;
}

/** a patch's added lines at their functions' entry counts; tree is the source after this patch */
export function patchCoverage(
	file: string,
	patch: string,
	tree: string,
	counts: Map<string, number>
) {
	const f: FileCoverage = { file, lines: new Map(), functions: new Map() };
	const sources = new Map<string, string[]>();
	let unmeasured = 0;
	for (const { line, file: c, at } of added(patch)) {
		if (!sources.has(c))
			sources.set(
				c,
				existsSync(join(tree, c)) ? readFileSync(join(tree, c), 'utf8').split('\n') : []
			);
		const fn = enclosing(sources.get(c)!, at);
		if (!fn) continue;
		const name = fn.find((n) => counts.has(n));
		if (!name) {
			unmeasured++;
			continue;
		}
		const n = counts.get(name)!;
		f.lines.set(line, n);
		if (!f.functions!.has(name)) f.functions!.set(name, [line, n]);
	}
	return { coverage: f, unmeasured };
}

if (import.meta.main) {
	const root = join(import.meta.dirname, '../..');
	const args = process.argv.slice(2);
	const at = args.indexOf('--out');
	const outFile = join(root, at >= 0 ? args[at + 1]! : 'coverage/patch.info');
	const opt = (name: string) => (args.includes(name) ? args[args.indexOf(name) + 1]! : undefined);
	const staged = args.indexOf('--staged');
	const input = opt('--staged') ?? opt('--out-dir');
	const linux = opt('--linux');
	const pristine = opt('--kernel-base');
	const reuse = opt('--reuse');
	if ((!input && !reuse) || (!linux && !pristine)) {
		console.error(
			'usage: scripts/lcov/patch.ts --out-dir <linux-wasm out> | --staged <vmlinux.wasm with names>\n' +
				'  | --reuse <an earlier run under build/coverage/patch>\n' +
				'  --linux <the pipeline kernel checkout, patches applied> | --kernel-base <pristine files>'
		);
		process.exit(2);
	}
	const work = join(root, 'build/coverage/patch', new Date().toISOString().replace(/[:.]/g, '-'));
	const countsFile = join(reuse ?? work, 'counts.json');
	const namesFile = join(reuse ?? work, 'functions.json');
	let status: number | null = null;
	if (!reuse) status = probe();
	if (!existsSync(countsFile)) {
		console.error(`coverage patch: the probes wrote no counters (exit ${status})`);
		process.exit(1);
	}
	const names = JSON.parse(readFileSync(namesFile, 'utf8')) as string[];
	const counts = byName(names, JSON.parse(readFileSync(countsFile, 'utf8')) as number[]);
	const files: FileCoverage[] = [];
	const dir = 'src/kernel/patches';
	const patches = readdirSync(join(root, dir))
		.filter((f) => f.endsWith('.patch'))
		.sort();
	// the source after each patch, from the pristine files every patch touches
	let base = pristine;
	if (!base) {
		base = join(work, 'base');
		const touched = new Set(
			patches.flatMap((p) =>
				[...readFileSync(join(root, dir, p), 'utf8').matchAll(/^\+\+\+ b\/(\S+)/gm)].map(
					(m) => m[1]!
				)
			)
		);
		for (const f of touched) {
			const r = spawnSync('git', ['-C', linux!, 'show', `HEAD:${f}`], { maxBuffer: 1 << 28 });
			if (r.status !== 0) continue;
			mkdirSync(join(base, f, '..'), { recursive: true });
			writeFileSync(join(base, f), r.stdout);
		}
	}
	const after = trees(
		base,
		patches.map((p) => join(root, dir, p)),
		join(work, 'trees')
	);
	for (const [k, name] of patches.entries()) {
		const { coverage, unmeasured } = patchCoverage(
			`${dir}/${name}`,
			readFileSync(join(root, dir, name), 'utf8'),
			after[k]!,
			counts
		);
		const hit = [...coverage.lines.values()].filter((n) => n > 0).length;
		console.log(
			`${name}: ${hit}/${coverage.lines.size} lines run${unmeasured ? `, ${unmeasured} not measurable` : ''}`
		);
		if (coverage.lines.size) files.push(coverage);
	}
	const lcov = formatLcov(files);
	mkdirSync(join(outFile, '..'), { recursive: true });
	writeFileSync(outFile, lcov);
	console.log(
		`${names.length} functions counted, ${[...counts.values()].filter((n) => n > 0).length} names entered`
	);
	process.exit(report('coverage patch', lcov));

	/** the counted kernel staged into work/build, and the probes run on it; their exit status */
	function probe(): number | null {
		const build = join(work, 'build');
		mkdirSync(join(build, 'kernel'), { recursive: true });
		const ts = (script: string, ...a: string[]) =>
			execFileSync(join(root, 'scripts/ts'), [join(root, 'scripts/wasm', script), ...a], {
				stdio: 'inherit'
			});
		const bk = readFileSync(join(root, 'scripts/build-kernel.sh'), 'utf8');
		const wat = join(work, 'vmlinux.wat');
		if (staged >= 0) execFileSync('wasm2wat', ['--enable-threads', input, '-o', wat]);
		else {
			// build-kernel.sh's own keep list and task globals
			const keep = execFileSync(
				'bash',
				['-c', `${bk.match(/^(keep=|keep\+=|for n in ).*$/gm)!.join('\n')}\necho "$keep"`],
				{
					encoding: 'utf8'
				}
			).trim();
			execFileSync('wasm2wat', [
				'--enable-threads',
				join(input, 'vmlinux.wasm'),
				'-o',
				join(work, 'raw.wat')
			]);
			ts('strip-exports.ts', join(work, 'raw.wat'), wat, keep);
		}
		const { text, names } = countEntries(readFileSync(wat, 'utf8'));
		writeFileSync(join(work, 'vmlinux.cov.wat'), text);
		writeFileSync(join(work, 'functions.json'), JSON.stringify(names));
		const vmlinux = join(build, 'kernel/vmlinux.wasm');
		const counted = staged >= 0 ? vmlinux : join(work, 'vmlinux.cov.wasm');
		execFileSync('wat2wasm', [
			'--enable-threads',
			'--enable-multi-memory',
			join(work, 'vmlinux.cov.wat'),
			'-o',
			counted
		]);
		if (staged < 0) ts('export-globals.ts', counted, vmlinux, ...bk.match(/gmux_\w+=\d+/g)!);
		ts('memory-note.ts', vmlinux);
		// the rest of the build as it is
		for (const name of readdirSync(join(root, 'build')))
			if (name !== 'kernel' && name !== 'coverage')
				symlinkSync(join(root, 'build', name), join(build, name));
		for (const name of readdirSync(join(root, 'build/kernel')))
			if (name !== 'vmlinux.wasm')
				symlinkSync(join(root, 'build/kernel', name), join(build, 'kernel', name));
		const probes = spawnSync(
			'node',
			[
				'--no-warnings',
				'--experimental-strip-types',
				'--import',
				join(root, 'scripts/lcov/patch-hook.ts'),
				join(root, 'tests/c/run.ts')
			],
			{
				cwd: root,
				env: { ...process.env, GMUX_BUILD: build, GMUX_PATCH_COVERAGE: countsFile },
				encoding: 'utf8',
				maxBuffer: 1 << 28
			}
		);
		process.stdout.write(
			probes.stdout
				.split('\n')
				.filter((l) => /^(PASS|FAIL) /.test(l))
				.join('\n') + '\n'
		);
		if (probes.status !== 0) process.stderr.write(probes.stderr.slice(-2000));
		return probes.status;
	}
}
