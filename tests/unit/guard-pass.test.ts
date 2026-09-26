import binaryen from 'binaryen';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// wasm2wat --generate-names layout, which scripts/wasm/guard-pass.ts reads line by line
const TOY = `(module
  (import "env" "memory" (memory $env.memory 1))
  (func $store (export "store") (param $p0 i32) (param $p1 i32)
    local.get $p0
    local.get $p1
    i32.store offset=4)
  (func $store8 (export "store8") (param $p0 i32) (param $p1 i32)
    local.get $p0
    local.get $p1
    i32.store8)
  (func $fill (export "fill") (param $p0 i32) (param $p1 i32)
    local.get $p0
    i32.const 7
    local.get $p1
    memory.fill)
  (func $load (export "load") (param $p0 i32) (result i32)
    local.get $p0
    i32.load))
`;

const TABLE = 0x8000;
const TAG = 5;

function guarded(inline: boolean) {
	const dir = mkdtempSync(join(tmpdir(), 'gmux-guard-'));
	writeFileSync(join(dir, 'in.wat'), TOY);
	execFileSync('scripts/ts', [
		'scripts/wasm/guard-pass.ts',
		join(dir, 'in.wat'),
		join(dir, 'out.wat'),
		...(inline ? ['--inline'] : [])
	]);
	const module = binaryen.parseText(readFileSync(join(dir, 'out.wat'), 'utf8'));
	module.setFeatures(binaryen.Features.BulkMemory | binaryen.Features.MutableGlobals);
	const bytes = module.emitBinary();
	module.dispose();
	const memory = new WebAssembly.Memory({ initial: 1 });
	// pages: 2 its own, 3 shared writable, 4 shared read-only, 5 another process's, the rest the kernel's
	const owners = new Uint16Array(memory.buffer, TABLE, 16);
	owners.set([0, 0, TAG, 0xffff, 0xfffe, 7]);
	const denied: number[] = [];
	const instance = new WebAssembly.Instance(new WebAssembly.Module(bytes), {
		env: {
			memory,
			__gmux_denied: (address: number) => {
				denied.push(address);
				throw new WebAssembly.RuntimeError('denied');
			}
		},
		gmux: {
			table: new WebAssembly.Global({ value: 'i32', mutable: false }, TABLE),
			tag: new WebAssembly.Global({ value: 'i32', mutable: false }, TAG)
		}
	});
	const x = instance.exports as Record<string, (...args: number[]) => number>;
	const view = new DataView(memory.buffer);
	return { x, view, denied };
}

describe('guard-pass.ts', () => {
	for (const inline of [false, true]) {
		describe(inline ? 'inlined check' : 'called check', () => {
			it('lets a store reach its own pages and writable shared pages, at its own offset', () => {
				const { x, view, denied } = guarded(inline);
				x.store!(0x2000, 11);
				x.store!(0x3000, 12);
				expect(view.getUint32(0x2004, true)).toBe(11);
				expect(view.getUint32(0x3004, true)).toBe(12);
				expect(denied).toEqual([]);
			});

			it('refuses a store to read-only shared, foreign and kernel pages before it writes', () => {
				const { x, view, denied } = guarded(inline);
				expect(() => x.store!(0x4000, 1)).toThrow('denied');
				expect(() => x.store!(0x5000, 1)).toThrow('denied');
				expect(() => x.store8!(0x100, 1)).toThrow('denied');
				expect(denied).toEqual([0x4004, 0x5004, 0x100]);
				expect(view.getUint32(0x5004, true)).toBe(0);
			});

			it('checks the last byte of a store that crosses into the next page', () => {
				const { x, denied } = guarded(inline);
				x.store!(0x2ffa, 1);
				expect(() => x.store!(0x3ffa, 1)).toThrow('denied');
				expect(denied).toEqual([0x4001]);
			});

			it('checks every page memory.fill writes', () => {
				const { x, view, denied } = guarded(inline);
				x.fill!(0x2f00, 0x200);
				expect(view.getUint8(0x30ff)).toBe(7);
				expect(() => x.fill!(0x3f00, 0x200)).toThrow('denied');
				expect(denied).toEqual([0x4000]);
			});

			it('leaves loads unchecked', () => {
				const { x, view, denied } = guarded(inline);
				view.setUint32(0x5000, 99, true);
				expect(x.load!(0x5000)).toBe(99);
				expect(denied).toEqual([]);
			});
		});
	}
});
