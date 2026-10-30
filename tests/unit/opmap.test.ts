import { describe, expect, it } from 'vitest';
import {
	align,
	categoryOf,
	helperRanges,
	parseLines,
	parseObjdump,
	rowsOf,
	sourceMap,
	sourceMappingSection,
	vlq,
	type Op
} from '../../experiments/aot-oracle/scripts/opmap.ts';
import {
	classOf,
	lastAtMost,
	parseDis,
	parseScript,
	shapeOf,
	stretchOf
} from '../../experiments/aot-oracle/scripts/v8attr.ts';

const ops = (names: string[]): Op[] =>
	names.map((t, k) => ({ off: k, name: t.split(' ')[0]!, text: t }));
const FUEL = 'global.get global.get i32.const'.split(' ');

describe('opmap', () => {
	it('reads functions and ops from wasm-objdump, without the local declarations', () => {
		const fns = parseObjdump(
			[
				'000169 func[0] <a>:',
				' 00016a: 01 7e                      | local[0] type=i64',
				' 00016c: 20 00                      | local.get 0',
				' 00016e: 10 05                      | call 5 <f>',
				' 000170: 0b                         | end',
				'000172 func[1] <b>:',
				' 000173: 0b                         | end'
			].join('\n')
		);
		expect(fns.map((f) => f.start)).toEqual([0x169, 0x172]);
		expect(fns[0]!.ops.map((o) => [o.off, o.text])).toEqual([
			[0x16c, 'local.get 0'],
			[0x16e, 'call 5'],
			[0x170, 'end']
		]);
	});

	it('reads the rows of a line table with the files of its own program', () => {
		const rows = parseLines(
			[
				'debug_line[0x00000000]',
				'file_names[  1]:',
				'           name: "arith"',
				'file_names[  2]:',
				'           name: "/x/flags"',
				'Address            Line   Column File   ISA Discriminator OpIndex Flags',
				'0x0000000000000005      7      0      1   0             0       0  is_stmt',
				'0x000000000000000b      9      0      2   0             0       0  is_stmt',
				'0x000000000000000f      9      0      2   0             0       0  is_stmt end_sequence'
			].join('\n')
		);
		expect(rows.map((r) => [r.addr, r.line, r.file, r.end])).toEqual([
			[5, 7, 'arith', false],
			[11, 9, 'flags', false],
			[15, 9, 'flags', true]
		]);
	});

	it('finds every op of the original in the instrumented function when nothing was inserted', () => {
		const pre = ops(['local.get 0', 'i32.const 1', 'i32.add', 'end']);
		expect(align(pre, ops(['local.get 3', 'i32.const 1', 'i32.add', 'end']))).toEqual([
			0, 1, 2, 3
		]);
	});

	it('skips the fuel check after a loop and the stack check after a subtraction, as the passes write them', () => {
		const pre = ops([
			'loop',
			'global.get 2',
			'i32.const 16',
			'i32.sub',
			'local.tee 4',
			'global.set 0',
			'end'
		]);
		const fuel =
			'global.get i32.const i32.sub global.set global.get i32.const i32.lt_s if call global.set end'.split(
				' '
			);
		const stack =
			'local.tee global.get i32.sub global.get i32.gt_u if local.get call else local.get end'.split(
				' '
			);
		const inst = ops([
			'loop',
			...fuel,
			'global.get 3',
			'i32.const 16',
			'i32.sub',
			...stack,
			'local.tee 5',
			'global.set 1',
			'end'
		]);
		const at = align(pre, inst);
		expect(at.map((j) => inst[j]!.text)).toEqual(
			pre.map((o) =>
				o.name.startsWith('local') || o.name.startsWith('global')
					? o.name + ' ' + (o.name === 'global.get' ? 3 : o.name === 'local.tee' ? 5 : 1)
					: o.text
			)
		);
		// the inserted ops are the rest
		expect(inst.length - at.length).toBe(fuel.length + stack.length);
		// the original subtraction, not the one inside the check
		expect(at[3]).toBe(1 + fuel.length + 2);
	});

	it('refuses a module whose original ops are not all there', () => {
		expect(() =>
			align(ops(['i32.const 1', 'i32.add']), ops(['i32.const 1', 'i32.sub']))
		).toThrow(/no match/);
		expect(FUEL.length).toBe(3);
	});

	it('gives an op the row at or before it, and nothing after a sequence ended', () => {
		const rows = [
			{ addr: 5, line: 7, file: 'arith', end: false },
			{ addr: 11, line: 9, file: 'flags', end: false },
			{ addr: 15, line: 9, file: 'flags', end: true }
		];
		const at = (off: number) => ({ off, name: 'x', text: 'x' });
		const got = rowsOf([at(100), at(105), at(110), at(111), at(115), at(120)], rows, 100);
		expect(got.map((r) => r?.file)).toEqual([
			undefined,
			'arith',
			'arith',
			'flags',
			undefined,
			undefined
		]);
	});

	it('names the category of an aot.h helper by the function around the line', () => {
		expect(
			helperRanges('static inline __attribute__((always_inline)) void aot_flags(\n')
		).toEqual([{ from: 1, cat: 'flags' }]);
		const h = helperRanges(
			[
				'static inline void aot_flags(int x)',
				'{',
				'}',
				'static inline int aot_mask(int w)',
				'{',
				'}'
			].join('\n')
		);
		const cats = new Set(['arith']);
		expect(categoryOf({ addr: 0, line: 2, file: 'aot.h', end: false }, cats, h)).toBe('flags');
		expect(categoryOf({ addr: 0, line: 5, file: 'aot.h', end: false }, cats, h)).toBe('arith');
		expect(categoryOf({ addr: 0, line: 5, file: 'arith', end: false }, cats, h)).toBe('arith');
		expect(categoryOf({ addr: 0, line: 5, file: 'mem.c', end: false }, cats, h)).toBe(
			'runtime'
		);
		expect(categoryOf(undefined, cats, h)).toBe('unmapped');
	});

	it('writes a source map with the columns as byte offsets, and the section that names it', () => {
		expect(vlq(0)).toBe('A');
		expect(vlq(1)).toBe('C');
		expect(vlq(-1)).toBe('D');
		expect(vlq(16)).toBe('gB');
		const m = JSON.parse(
			sourceMap(
				[
					{ col: 5, src: 0, line: 7 },
					{ col: 7, src: 1, line: 9 }
				],
				['arith', 'flags']
			)
		);
		expect(m.sources).toEqual(['arith', 'flags']);
		expect(m.mappings).toBe('KAOA,EC' + 'EA');
		const s = sourceMappingSection('a.map');
		expect(s[0]).toBe(0);
		expect(s.toString('latin1')).toContain('sourceMappingURL\x05a.map');
	});
});

describe('v8attr', () => {
	const script = [
		' 36868baa4b5e JS:f_arith-5-turbofan+0x9e (/tmp/jitted-1-2.so)',
		'  ffffffffab833081 [unknown] ([unknown])',
		' 7f00 JS:run.js:7+0x10 (/tmp/x.so)',
		' e54286 v8::internal::Code::size() const+0x86 (/bin/node)'
	].join('\n');
	const dis = [
		'--- WebAssembly code ---',
		'name: f_arith',
		'index: 5',
		'Instructions (size = 12)',
		'0x1000     0  55                   push rbp',
		'0x1001     1  488945e0             REX.W movq [rbp-0x20],rax',
		'0x1005     5  488b4de8             REX.W movq rcx,[rbp-0x18]',
		'0x1009     9  e8aa000000           call 0x2000',
		'Source positions:',
		' pc offset  position',
		'        64        29',
		'        9b        38',
		'',
		'--- End code ---'
	].join('\n');

	it('parses perf script lines into function, index and offset', () => {
		const s = parseScript(script);
		expect(s.map((x) => [x.name, x.index, x.off])).toEqual([
			['f_arith', 5, 0x9e],
			['[unknown]', -1, 0],
			['JS:run.js:7', -1, 0x10],
			['v8::internal::Code::size() const', -1, 0x86]
		]);
	});

	it('classifies samples by where they ran', () => {
		const s = parseScript(script);
		const names = new Set(['step']);
		const region = /^f_/;
		expect(s.map((x) => classOf(x, names, region))).toEqual([
			'region',
			'kernel or unresolved',
			'host JS',
			'V8 and node'
		]);
		expect(classOf({ name: 'step', index: 3, off: 0, dso: '' }, names, region)).toBe(
			'katybug (interpreter and runtime)'
		);
		expect(classOf({ name: 'other', index: 3, off: 0, dso: '' }, names, region)).toBe(
			'other wasm'
		);
	});

	it('parses a print-wasm-code block and names the shape of each instruction', () => {
		const [c] = parseDis(dis);
		expect(c!.name).toBe('f_arith');
		expect(c!.index).toBe(5);
		expect(c!.insns.map((i) => i.off)).toEqual([0, 1, 5, 9]);
		expect(c!.positions).toEqual([
			{ pc: 0x64, pos: 29 },
			{ pc: 0x9b, pos: 38 }
		]);
		expect(c!.insns.map((i) => shapeOf(i.text))).toEqual([
			'other',
			'spill store',
			'spill load',
			'call'
		]);
		expect(shapeOf('jnz 0x1234  <+0xfa>')).toBe('branch');
	});

	it('cuts a stretch at the next op that has a table entry of its own', () => {
		const ops = [
			'i32.load',
			'local.set',
			'i32.add',
			'i64.store32',
			'i32.load8_u',
			'i32.const',
			'call'
		].map((name) => ({ name }));
		expect(stretchOf(ops, 0)).toEqual(['i32.load', 'local.set', 'i32.add']);
		expect(stretchOf(ops, 4)).toEqual(['i32.load8_u', 'i32.const']);
		expect(stretchOf(ops, 6)).toEqual(['call']);
		expect(stretchOf(ops, 0, 2)).toEqual(['i32.load', 'local.set']);
		expect(stretchOf([{ name: 'i32.div_u' }, { name: 'i32.add' }], 0)).toEqual([
			'i32.div_u',
			'i32.add'
		]);
	});

	it('takes the last entry at or before an offset', () => {
		const l = [{ k: 2 }, { k: 5 }, { k: 9 }];
		expect(lastAtMost(l, 5, (x) => x.k)).toEqual({ k: 5 });
		expect(lastAtMost(l, 8, (x) => x.k)).toEqual({ k: 5 });
		expect(lastAtMost(l, 1, (x) => x.k)).toBeUndefined();
	});
});
