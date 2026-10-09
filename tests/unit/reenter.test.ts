import { execFileSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { countInsns } from '../../experiments/reenter/scripts/insn.ts';
import { dispatchWat, entriesOf } from '../../experiments/reenter/scripts/link.ts';
import { ieWat, upWat } from '../../experiments/reenter/scripts/rt.ts';
import { prepareToy, runGrow, runToy } from '../../experiments/reenter/scripts/toy.ts';

const hasTools = (() => {
	try {
		execFileSync('wasm-tools', ['--version'], { stdio: 'ignore' });
		return true;
	} catch {
		return false;
	}
})();
const wasm3 = process.env.REENTER_WASM3;
const mutant = process.env.REENTER_MUTANT_WASM3;
const assemble = (wat: string) =>
	new Uint8Array(execFileSync('wasm-tools', ['parse', '-o', '/dev/stdout'], { input: wat }));
const toy = new URL('../../experiments/reenter/toy.wat', import.meta.url).pathname;
const toyGrow = new URL('../../experiments/reenter/toy-grow.wat', import.meta.url).pathname;

describe('dispatcher', () => {
	const entries = [
		{ arity: 2, returns: true },
		{ arity: 3, returns: true },
		{ arity: 1, returns: false }
	];

	it('names one br_table target per entry and traps on an unknown id', () => {
		const wat = dispatchWat(entries, false);
		expect(wat).toContain('(br_table $b0 $b1 $b2 $d (local.get $id))');
		expect(wat).toContain('(unreachable)');
		expect(dispatchWat(entries, true)).toContain('call_indirect (type $s1)');
	});

	it('reads the arity from a wasm3 signature', () => {
		expect(entriesOf({ rung: 0, imports: { f: 'i(iii)', g: 'v(i)' } })).toEqual([
			{ name: 'f', arity: 3, returns: true },
			{ name: 'g', arity: 1, returns: false }
		]);
	});

	it.skipIf(!hasTools)(
		'calls the function its id names with its own arguments, and answers 0 for a void one',
		() => {
			const calls: number[][] = [];
			const dispatcher = new WebAssembly.Instance(
				new WebAssembly.Module(assemble(dispatchWat(entries, false))),
				{
					native: {
						f0: (a: number, b: number) => a * 10 + b,
						f1: (a: number, b: number, c: number) => a + b * 100 + c * 10000,
						f2: (a: number) => void calls.push([a])
					}
				}
			).exports.host_direct as (...a: number[]) => number;
			expect(dispatcher(0, 3, 4, 9, 9, 9, 9, 9, 9)).toBe(34);
			expect(dispatcher(1, 1, 2, 3, 9, 9, 9, 9, 9)).toBe(30201);
			expect(dispatcher(2, 7, 9, 9, 9, 9, 9, 9, 9)).toBe(0);
			expect(calls).toEqual([[7]]);
			expect(() => dispatcher(3, 0, 0, 0, 0, 0, 0, 0, 0)).toThrow(/unreachable/);
		}
	);

	it.skipIf(!hasTools)('assembles the native loops and the interpreted nops', () => {
		expect(() => assemble(upWat([2, 3, 5, 7]))).not.toThrow();
		expect(() => assemble(ieWat([2, 3, 5, 7]))).not.toThrow();
	});
});

describe('base in the offset immediate', () => {
	const module = (body: string) =>
		new WebAssembly.Instance(
			new WebAssembly.Module(
				assemble(
					`(module (memory (export "m") 1) (func (export "f") (param i32) (result i32) ${body}))`
				)
			)
		).exports as { f: (p: number) => number; m: WebAssembly.Memory };

	it.skipIf(!hasTools)('wraps with an explicit add and traps as an offset', () => {
		const add = module('local.get 0 i32.const 16 i32.add i32.load');
		const offset = module('local.get 0 i32.load offset=16');
		new DataView(add.m.buffer).setUint32(0, 0xabcd, true);
		expect(add.f(0xfffffff0 | 0)).toBe(0xabcd);
		expect(() => offset.f(0xfffffff0 | 0)).toThrow(WebAssembly.RuntimeError);
	});
});

describe('machine code counts', () => {
	// the opening of longest_match's optimised code as V8 prints it, rebased variant
	const x64 = [
		'0x16f7cadad6c0     0  55                   push rbp',
		'0x16f7cadad6c1     1  4889e5               REX.W movq rbp,rsp',
		'0x16f7cadad6c7     7  4881ec90000000       REX.W subq rsp,0x90',
		'0x16f7cadad6ce     e  488b5e1f             REX.W movq rbx,[rsi+0x1f]',
		'0x16f7cadad6d6    16  8b09                 movl rcx,[rcx]',
		'0x16f7cadad6d8    18  8d3401               leal rsi,[rcx+rax*1]',
		'0x16f7cadad6db    1b  8b7c337c             movl rdi,[rbx+rsi*1+0x7c]',
		'0x16f7cadad6e2    22  41c1e802             shrl r8,2',
		'0x16f7cadad6f3    33  44398c338c000000     cmpl [rbx+rsi*1+0x8c],r9',
		'0x16f7cadad710    50  4181c306010000       addl r11,0x106',
		'0x16f7cadad740    80  4103fb               addl rdi,r11',
		'0x16f7cadad743    83  4c8975e8             REX.W movq [rbp-0x18],r14',
		'0x16f7cadad747    87  448db702010000       leal r14,[rdi+0x102]',
		'0x16f7cadad75e    9e  0fb60403             movzxbl rax,[rbx+rax*1]',
		'0x16f7cadad70b    4b  442b5c332c           subl r11,[rbx+rsi*1+0x2c]',
		'0x16f7cadad000     0  488b5de0             REX.W movq rbx,[rbp-0x20]',
		'0x16f7cadad004     4  897170                movl [rbx+rcx*1+0x70],rdi',
		'0x16f7cadad007     7  0f1f00               nop'
	];
	const arm64 = [
		'0xfd1e0fa7720     0  d2800610       movz x16, #0x30',
		'0xfd1e0fa7724     4  a9be43e7       stp x7, x16, [sp, #-32]!',
		'0xfd1e0fa7728     8  a9017bfd       stp fp, lr, [sp, #16]',
		'0xfd1e0fa772c     c  910043fd       add fp, sp, #0x10 (16)',
		'0xfd1e0fa7730    10  d10243ff       sub sp, sp, #0x90 (144)',
		'0xfd1e0fa7734    14  f841f0e1       ldur x1, [x7, #31]',
		'0xfd1e0fa773c    1c  b9400063       ldr w3, [x3]',
		'0xfd1e0fa7740    20  0b030004       add w4, w0, w3',
		'0xfd1e0fa7744    24  8b040024       add x4, x1, x4',
		'0xfd1e0fa7748    28  b9407c85       ldr w5, [x4, #124]',
		'0xfd1e0fa7960   240  b9007082       str w2, [x4, #112]',
		'0xfd1e0fa79dc   2bc  f90047eb       str x11, [sp, #136]',
		'0xfd1e0fa77a0    80  386f682f       ldrb w15, [x1, x15]'
	];

	it('counts x86-64 loads, stores, adds and leas from memory-operand text', () => {
		expect(countInsns(['Instructions (size = 3)', ...x64], 'x64')).toEqual({
			instructions: 18,
			loads: 7,
			stores: 2,
			frame: 2,
			adds: 2,
			leas: 2
		});
	});

	it('counts arm64 loads, stores and adds the same way', () => {
		expect(countInsns(arm64, 'arm64')).toEqual({
			instructions: 13,
			loads: 4,
			stores: 4,
			frame: 3,
			adds: 3,
			leas: 0
		});
	});
});

describe.skipIf(!hasTools || !wasm3)(
	'a promoted function calls an interpreted one that calls a promoted one again',
	() => {
		const dir = mkdtempSync(join(tmpdir(), 'reenter-'));
		const sets = { mixed: ['hotA', 'leafH', 'viaTab', 'callTrap'] };
		const failed = (checks: { ok: boolean; name: string; detail: string }[]) =>
			checks.filter((c) => !c.ok).map((c) => `${c.name}: ${c.detail}`);

		it('answers what V8 answers over JavaScript, to depth 400', async () => {
			prepareToy(toy, join(dir, 'glued'), sets);
			expect(failed(await runToy(wasm3!, join(dir, 'glued'), 'glued', 400))).toEqual([]);
		});

		it('answers what V8 answers with no JavaScript in the loop, to depth 1000', async () => {
			prepareToy(toy, join(dir, 'direct'), sets);
			expect(failed(await runToy(wasm3!, join(dir, 'direct'), 'direct'))).toEqual([]);
		});

		it('keeps the stack limit at the buffer end when memory grows under a host call', async () => {
			prepareToy(toyGrow, join(dir, 'grow'), { mixed: ['callGrow'] }, false);
			expect(failed(await runGrow(wasm3!, join(dir, 'grow')))).toEqual([]);
		});

		it.skipIf(!mutant)('fails when the nested entry starts at the stack origin', async () => {
			prepareToy(toy, join(dir, 'mutant'), sets);
			expect(
				failed(await runToy(mutant!, join(dir, 'mutant'), 'direct')).length
			).toBeGreaterThan(0);
		});
	}
);
