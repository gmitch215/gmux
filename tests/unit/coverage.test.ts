import binaryen from 'binaryen';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { checkLcov, formatLcov, parseLcov, repoPath, report } from '../../scripts/lcov/lcov.ts';
import {
	added,
	byName,
	countEntries,
	definition,
	enclosing,
	patchCoverage,
	trees
} from '../../scripts/lcov/patch.ts';
import {
	attribute,
	counterName,
	entries,
	instrument,
	kept,
	templates,
	tokenize
} from '../../scripts/lcov/wat.ts';

/** a wat instrumented, compiled and run: fn(exports), then each line's count */
function counted(wat: string, run: (x: Record<string, (...a: number[]) => number>) => void) {
	const u = instrument(wat, 't');
	const m = binaryen.parseText(u.text);
	m.setFeatures(binaryen.Features.MutableGlobals);
	const bytes = m.emitBinary();
	m.dispose();
	const i = new WebAssembly.Instance(new WebAssembly.Module(bytes), {
		env: { f: () => 0 }
	});
	run(i.exports as Record<string, (...a: number[]) => number>);
	const counts = Array.from({ length: u.counters }, (_, n) =>
		Number((i.exports[counterName('t', n)] as WebAssembly.Global).value)
	);
	return new Map([...u.lines].map(([line, n]) => [line, counts[n]!]));
}

describe('lcov.ts', () => {
	it('writes and reads back lines and functions', () => {
		const text = formatLcov([
			{ file: 'src/b.c', lines: new Map([[3, 0]]) },
			{
				file: 'src/a.c',
				lines: new Map([
					[2, 5],
					[1, 1]
				]),
				functions: new Map([['main', [1, 1]]])
			}
		]);
		expect(text.indexOf('SF:src/a.c')).toBeLessThan(text.indexOf('SF:src/b.c'));
		expect(text).toContain('DA:1,1\nDA:2,5\nLF:2\nLH:2');
		const [a, b] = parseLcov(text);
		expect(a).toEqual({
			file: 'src/a.c',
			lines: new Map([
				[1, 1],
				[2, 5]
			]),
			functions: new Map([['main', [1, 1]]])
		});
		expect(b!.lines).toEqual(new Map([[3, 0]]));
	});

	it('refuses the paths Codecov cannot place', () => {
		const bad = ['/abs/x.c', '../up.c', 'C:/x.c', 'a\\b.c'];
		const text = formatLcov(
			[...bad, 'ok.c'].map((file) => ({ file, lines: new Map([[1, 1]]) }))
		);
		const c = checkLcov(text);
		expect([c.files, c.lines, c.hit]).toEqual([5, 5, 5]);
		expect(new Set(c.bad)).toEqual(new Set(bad));
		const log = vi.spyOn(console, 'error').mockImplementation(() => {});
		expect(report('t', text)).toBe(1);
		expect(report('t', '')).toBe(1);
		log.mockRestore();
		const out = vi.spyOn(console, 'log').mockImplementation(() => {});
		expect(
			report(
				't',
				formatLcov([
					{
						file: 'ok.c',
						lines: new Map([
							[1, 0],
							[2, 3]
						])
					}
				])
			)
		).toBe(0);
		expect(out).toHaveBeenCalledWith('t: 1 files, 1/2 lines (50.00%), all paths repo-relative');
		out.mockRestore();
	});

	it('makes a path repo-relative, or refuses one outside the repo', () => {
		expect(repoPath('/r', '/r/src/gmux/katybug/x86.c')).toBe('src/gmux/katybug/x86.c');
		expect(repoPath('/r', 'src/a.c')).toBe('src/a.c');
		expect(repoPath('/r', '/usr/include/stdio.h')).toBeNull();
	});
});

describe('wat.ts', () => {
	it('tokenizes around comments and keeps parentheses inside strings', () => {
		const t = tokenize('(a ;; (x\n (; (; y ;) ;) "(s)" $b)');
		expect(t.map((x) => x.text)).toEqual(['(', 'a', '"(s)"', '$b', ')']);
		expect(t[2]!.line).toBe(2);
	});

	it('counts each function and folded block at its lines, imports and types left alone', () => {
		const wat = [
			'(module',
			'  (import "env" "f" (func $f (result i32)))',
			'  (type $t (func))',
			'  (func (export "g") (param $n i32) (result i32)',
			'    (local $i i32)',
			'    (if (local.get $n)',
			'      (then (return (i32.const 1)))',
			'      (else (drop (call $f))))',
			'    (loop $l',
			'      (local.set $i (i32.add (local.get $i) (i32.const 1)))',
			'      (br_if $l (i32.lt_u (local.get $i) (i32.const 3))))',
			'    (i32.const 0))',
			'  (func $never (export "never")',
			'    nop))'
		].join('\n');
		const lines = counted(wat, (x) => (x.g!(0), x.g!(1)));
		expect([...lines].sort((a, b) => a[0] - b[0])).toEqual([
			[4, 2],
			[6, 2],
			[7, 1],
			[8, 1],
			[9, 3],
			[10, 3],
			[11, 3],
			[12, 1],
			[13, 0],
			[14, 0]
		]);
	});

	it('counts flat blocks, else branches and, apart, the code after a block that can return', () => {
		const wat = [
			'(module',
			'  (func (export "h") (param $p0 i32) (result i32)',
			'    block $B0',
			'      local.get $p0',
			'      br_if $B0',
			'      i32.const 5',
			'      return',
			'    end',
			'    local.get $p0',
			'    if (result i32)',
			'      i32.const 1',
			'    else',
			'      i32.const 2',
			'    end))'
		].join('\n');
		const lines = counted(wat, (x) => (x.h!(0), x.h!(4), x.h!(9)));
		expect(lines.get(2)).toBe(3);
		expect(lines.get(4)).toBe(3);
		expect(lines.get(6)).toBe(1);
		expect(lines.get(9)).toBe(2);
		expect(lines.get(11)).toBe(2);
		expect(lines.get(13)).toBe(0);
	});

	it('finds the lines a pass inserted and the template lines that wrote them', () => {
		const source = [
			"const skip = line.startsWith('loop');",
			"const keys = [['i32', 4]];",
			'const check = (ind: string) =>',
			'	[',
			"		'global.get $g',",
			"		'i32.const 1',",
			"		'i32.sub'",
			'	]',
			'		.map((l) => ind + l)',
			"		.join('\\n');",
			'const call = (n: string) => `    local.get ${n}',
			'    call $gmux.check`;',
			"for (const op of ['i32.load', 'i64.load']) keys.push([op, 0]);"
		].join('\n');
		const t = templates(source);
		expect(t.map((x) => x.line)).toEqual([5, 6, 7, 11, 12]);
		expect(t[3]!.re.test('local.get $p0')).toBe(true);
		const before = ['(func', '  loop', '  end)'];
		const after = [
			'(func',
			'  loop',
			'    global.get $g',
			'    i32.const 1',
			'    i32.sub',
			'    local.get $x',
			'    call $gmux.check',
			'  end)'
		];
		const map = kept(before, after);
		expect([...map]).toEqual([0, 1, -1, -1, -1, -1, -1, 2]);
		expect(attribute(after, map, t)).toEqual([null, null, 5, 6, 7, 11, 12, null]);
	});

	it('reports a unit line at the file line it came from, or not at all', () => {
		const lines = new Map([
			[1, 0],
			[2, 1]
		]);
		expect(entries(lines, [{ file: 'a.wat', line: 7 }, null], [4])).toEqual([['a.wat', 7, 4]]);
	});
});

describe('patch.ts', () => {
	it('counts every entry into every function, the one-line ones too', () => {
		const wat = [
			'(module',
			'  (import "env" "memory" (memory (;0;) 1))',
			'  (func $a (type 0) (result i32)',
			'    (local i32)',
			'    i32.const 7)',
			'  (func $b (type 1))',
			'  (type (;0;) (func (result i32)))',
			'  (type (;1;) (func))',
			'  (export "a" (func $a))',
			'  (export "b" (func $b)))'
		].join('\n');
		const { text, names } = countEntries(wat);
		expect(names).toEqual(['a', 'b']);
		const m = binaryen.parseText(text);
		m.setFeatures(binaryen.Features.MultiMemory);
		const i = new WebAssembly.Instance(new WebAssembly.Module(m.emitBinary()), {
			env: { memory: new WebAssembly.Memory({ initial: 1 }) }
		});
		m.dispose();
		const x = i.exports as Record<string, () => number>;
		x.a!();
		x.a!();
		x.b!();
		expect([
			...new BigUint64Array((i.exports.gmux_cov as WebAssembly.Memory).buffer, 0, 2)
		]).toEqual([2n, 1n]);
	});

	it('names the function a line of C starts, and nothing for anything else', () => {
		expect(definition('static int __init wasm_owner_init(void)')).toEqual(['wasm_owner_init']);
		expect(definition('struct page *wasm_page(unsigned long a)')).toEqual(['wasm_page']);
		expect(definition('SYSCALL_DEFINE3(mremap, unsigned long, addr,')).toEqual([
			'__do_sys_mremap',
			'__se_sys_mremap',
			'sys_mremap'
		]);
		for (const s of [
			'int f(void);',
			'static const struct x y = {',
			'long (* const t[4])(void) = {',
			'out:',
			'\tf(x);',
			'#define F(x) x',
			'}'
		])
			expect(definition(s)).toBeNull();
	});

	it('reads the added lines of C hunks with their lines after the patch', () => {
		const patch = [
			'Subject: [PATCH] x',
			'---',
			'--- a/mm/a.c',
			'+++ b/mm/a.c',
			'@@ -10,4 +10,6 @@',
			' int f(void)',
			' {',
			'-\treturn 0;',
			'+\t/* why */',
			'+\tg();',
			'+',
			'+\treturn 1;',
			' }',
			'--- a/Kconfig',
			'+++ b/Kconfig',
			'@@ -1 +1,2 @@',
			' config X',
			'+\tbool',
			'--- /dev/null',
			'+++ b/arch/new.c',
			'@@ -0,0 +1,2 @@',
			'+#include <x.h>',
			'+int h(void) { return 2; }'
		].join('\n');
		expect(added(patch).map(({ line, file, at }) => [line, file, at])).toEqual([
			[10, 'mm/a.c', 13],
			[12, 'mm/a.c', 15],
			[23, 'arch/new.c', 2]
		]);
	});

	it('finds the enclosing function, and the file scope after one closes', () => {
		const src = [
			'static long',
			'wasm_f(int a,',
			'\t     int b)',
			'{',
			'out:',
			'\treturn a;',
			'}',
			'static int x;'
		];
		expect(enclosing(src, 6)).toEqual(['wasm_f']);
		expect(enclosing(src, 7)).toEqual(['wasm_f']);
		expect(enclosing(src, 8)).toBeNull();
	});

	it('maps a patch onto entry counts, leaving out a function with no body in the wasm', () => {
		const dir = mkdtempSync(join(tmpdir(), 'gmux-patch-cov-'));
		mkdirSync(join(dir, 'mm'));
		writeFileSync(
			join(dir, 'mm/a.c'),
			[
				'int run(void)',
				'{',
				'\tx();',
				'}',
				'static inline int gone(void)',
				'{',
				'\ty();',
				'}'
			].join('\n')
		);
		const patch = [
			'--- a/mm/a.c',
			'+++ b/mm/a.c',
			'@@ -1,8 +1,8 @@',
			' int run(void)',
			' {',
			'-\tz();',
			'+\tx();',
			' }',
			' static inline int gone(void)',
			' {',
			'-\tz();',
			'+\ty();',
			' }'
		].join('\n');
		const counts = byName(['run', 'other.1', 'other'], [3, 1, 1]);
		expect(counts.get('other')).toBe(2);
		const { coverage, unmeasured } = patchCoverage('p.patch', patch, dir, counts);
		expect([...coverage.lines]).toEqual([[7, 3]]);
		expect(coverage.functions).toEqual(new Map([['run', [7, 3]]]));
		expect(unmeasured).toBe(1);
	});

	it('applies the patches in order over the pristine files', () => {
		const dir = mkdtempSync(join(tmpdir(), 'gmux-patch-trees-'));
		mkdirSync(join(dir, 'base'));
		writeFileSync(join(dir, 'base/a.c'), 'one\n');
		const p = (from: string, to: string, name: string) => {
			writeFileSync(join(dir, name), `--- a/a.c\n+++ b/a.c\n@@ -1 +1 @@\n-${from}\n+${to}\n`);
			return join(dir, name);
		};
		const [s0, s1] = trees(
			join(dir, 'base'),
			[p('one', 'two', '1.patch'), p('two', 'three', '2.patch')],
			join(dir, 'trees')
		);
		expect(require('node:fs').readFileSync(join(s0!, 'a.c'), 'utf8')).toBe('two\n');
		expect(require('node:fs').readFileSync(join(s1!, 'a.c'), 'utf8')).toBe('three\n');
	});
});
