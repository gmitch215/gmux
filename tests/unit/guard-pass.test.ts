import binaryen from 'binaryen';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// wasm2wat --generate-names layout, which scripts/wasm/guard-pass.ts reads line by line
const TOY = `(module
  (type $t0 (func))
  (import "env" "yield" (func $yield (type $t0)))
  (import "env" "memory" (memory $env.memory 1))
  (func $twice (export "twice") (param $p0 i32) (result i32)
    local.get $p0
    i32.load
    call $yield
    local.get $p0
    i32.load
    i32.add)
  (func $spin (export "spin") (param $p0 i32) (param $p1 i32) (result i32)
    (local $l2 i32)
    loop $L0
      local.get $l2
      local.get $p0
      i32.load
      i32.add
      local.set $l2
      local.get $p1
      i32.const 1
      i32.sub
      local.tee $p1
      br_if $L0
    end
    local.get $l2)
  (table $T0 1 funcref)
  (elem (i32.const 0) func $yield)
  (func $calls (export "calls") (param $p0 i32) (param $p1 i32)
    loop $L0
      i32.const 0
      call_indirect $T0 (type $t0)
      local.get $p0
      i32.load
      drop
      local.get $p1
      i32.const 1
      i32.sub
      local.tee $p1
      br_if $L0
    end)
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
  (func $copy (export "copy") (param $p0 i32) (param $p1 i32) (param $p2 i32)
    local.get $p0
    local.get $p1
    local.get $p2
    memory.copy)
  (func $load (export "load") (param $p0 i32) (result i32)
    local.get $p0
    i32.load)
  (func $load8 (export "load8") (param $p0 i32) (result i32)
    local.get $p0
    i32.load8_u offset=1))
`;

const TABLE = 0x8000;
const SET = 0x9000;
const TAG = 5;
// pages: 2 its own, 3 and 4 regions it maps writable and read-only (ids 4 and 5), 5 another
// process's, 6 a region it maps writable (id 1), 7 one it maps read-only (id 2), 8 one it does not
// map (id 3), 10 the highest id (4095), which it does not map, 11 the one below it (4094), which
// it maps writable, the rest the kernel's
const OWNERS = [0, 0, TAG, 0x8004, 0x8005, 7, 0x8001, 0x8002, 0x8003, 0, 0xffff, 0xfffe];

type Mode = 'called' | 'inline';

/** the toy through the guard pass (and the fuel pass after it, as instrument.sh runs it) */
function guarded(mode: Mode, set = SET, hooks: { yield?: () => void; fuel?: () => void } = {}) {
	const dir = mkdtempSync(join(tmpdir(), 'gmux-guard-'));
	writeFileSync(join(dir, 'in.wat'), TOY);
	execFileSync('scripts/ts', [
		'scripts/wasm/guard-pass.ts',
		join(dir, 'in.wat'),
		join(dir, 'out.wat'),
		...(mode === 'inline' ? ['--inline'] : [])
	]);
	let wat = join(dir, 'out.wat');
	if (hooks.fuel) {
		execFileSync('scripts/ts', ['scripts/wasm/fuel-pass.ts', wat, join(dir, 'fuel.wat')]);
		wat = join(dir, 'fuel.wat');
	}
	const module = binaryen.parseText(readFileSync(wat, 'utf8'));
	module.setFeatures(binaryen.Features.BulkMemory | binaryen.Features.MutableGlobals);
	const bytes = module.emitBinary();
	module.dispose();
	const memory = new WebAssembly.Memory({ initial: 1 });
	new Uint16Array(memory.buffer, TABLE, 16).set(OWNERS);
	const bits = new Uint8Array(memory.buffer, SET, 1024);
	// id 1 readable and writable, id 2 readable, id 4 readable and writable, id 5 readable, id 4094
	// readable and writable
	bits[0] = (3 << 2) | (1 << 4);
	bits[1] = 3 | (1 << 2);
	bits[1023] = 3 << 4;
	const denied: number[] = [];
	const instance = new WebAssembly.Instance(new WebAssembly.Module(bytes), {
		env: {
			memory,
			yield: () => hooks.yield?.(),
			// every loop head yields
			__gmux_fuel: () => (hooks.fuel?.(), 0),
			__gmux_denied: (address: number) => {
				denied.push(address);
				throw new WebAssembly.RuntimeError('denied');
			}
		},
		gmux: {
			table: new WebAssembly.Global({ value: 'i32', mutable: false }, TABLE),
			tag: new WebAssembly.Global({ value: 'i32', mutable: false }, TAG),
			set: new WebAssembly.Global({ value: 'i32', mutable: false }, set)
		}
	});
	const x = instance.exports as Record<string, (...args: number[]) => number>;
	const view = new DataView(memory.buffer);
	/** what the kernel does when a page leaves the process: the page takes another tag */
	const revoke = (page: number) => view.setUint16(TABLE + 2 * page, 7, true);
	return { x, view, denied, revoke };
}

describe('guard-pass.ts', () => {
	for (const mode of ['called', 'inline'] as const) {
		describe(`${mode} check`, () => {
			it('lets a store reach its own pages, writable shared pages and writable regions, at its own offset', () => {
				const { x, view, denied } = guarded(mode);
				x.store!(0x2000, 11);
				x.store!(0x3000, 12);
				x.store!(0x6000, 13);
				expect(view.getUint32(0x2004, true)).toBe(11);
				expect(view.getUint32(0x3004, true)).toBe(12);
				expect(view.getUint32(0x6004, true)).toBe(13);
				expect(denied).toEqual([]);
			});

			it('refuses a store to read-only, foreign, unmapped-region and kernel pages before it writes', () => {
				const { x, view, denied } = guarded(mode);
				expect(() => x.store!(0x4000, 1)).toThrow('denied');
				expect(() => x.store!(0x5000, 1)).toThrow('denied');
				expect(() => x.store!(0x7000, 1)).toThrow('denied');
				expect(() => x.store!(0x8000, 1)).toThrow('denied');
				expect(() => x.store8!(0x100, 1)).toThrow('denied');
				expect(denied).toEqual([0x4004, 0x5004, 0x7004, 0x8004, 0x100]);
				expect(view.getUint32(0x5004, true)).toBe(0);
			});

			it('gives the highest region ids no pass beyond the set', () => {
				const { x, view, denied } = guarded(mode);
				expect(() => x.store!(0xa000, 1)).toThrow('denied');
				expect(() => x.load!(0xa000)).toThrow('denied');
				x.store!(0xb000, 9);
				expect(view.getUint32(0xb004, true)).toBe(9);
				expect(denied).toEqual([0xa004, 0xa000]);
			});

			it('checks the last byte of a store that crosses into the next page', () => {
				const { x, denied } = guarded(mode);
				x.store!(0x2ffa, 1);
				expect(() => x.store!(0x3ffa, 1)).toThrow('denied');
				expect(denied).toEqual([0x4001]);
			});

			it('lets a load read its own, shared and mapped-region pages', () => {
				const { x, view, denied } = guarded(mode);
				for (const page of [0x2000, 0x3000, 0x4000, 0x6000, 0x7000]) {
					view.setUint32(page, page + 1, true);
					expect(x.load!(page)).toBe(page + 1);
				}
				expect(x.load8!(0x2000)).toBe((0x2001 >> 8) & 0xff);
				expect(denied).toEqual([]);
			});

			it('refuses a load from foreign, unmapped-region and kernel pages', () => {
				const { x, view, denied } = guarded(mode);
				view.setUint32(0x5000, 99, true);
				expect(() => x.load!(0x5000)).toThrow('denied');
				expect(() => x.load!(0x8000)).toThrow('denied');
				expect(() => x.load8!(0x100)).toThrow('denied');
				expect(denied).toEqual([0x5000, 0x8000, 0x101]);
			});

			it('checks the last byte of a load that crosses into the next page', () => {
				const { x, denied } = guarded(mode);
				x.load!(0x2ffc);
				expect(() => x.load!(0x4ffe)).toThrow('denied');
				expect(denied).toEqual([0x5001]);
			});

			it('refuses every region without a set', () => {
				const { x, denied } = guarded(mode, 0);
				expect(() => x.load!(0x6000)).toThrow('denied');
				expect(() => x.store!(0x6000, 1)).toThrow('denied');
				x.store!(0x2000, 1);
				expect(denied).toEqual([0x6000, 0x6004]);
			});

			it('checks every page memory.fill writes', () => {
				const { x, view, denied } = guarded(mode);
				x.fill!(0x2f00, 0x200);
				expect(view.getUint8(0x30ff)).toBe(7);
				expect(() => x.fill!(0x3f00, 0x200)).toThrow('denied');
				expect(denied).toEqual([0x4000]);
			});

			it('checks every page memory.copy writes and reads', () => {
				const { x, view, denied } = guarded(mode);
				view.setUint8(0x4010, 42);
				x.copy!(0x2000, 0x4010, 1);
				expect(view.getUint8(0x2000)).toBe(42);
				expect(() => x.copy!(0x2000, 0x5000, 0x10)).toThrow('denied');
				expect(() => x.copy!(0x4000, 0x2000, 0x10)).toThrow('denied');
				expect(denied).toEqual([0x5000, 0x4000]);
			});

			it('refuses a page revoked while the process was parked in a call', () => {
				const { x, view, denied, revoke } = guarded(mode, SET, { yield: () => revoke(2) });
				view.setUint32(0x2000, 5, true);
				expect(() => x.twice!(0x2000)).toThrow('denied');
				expect(denied).toEqual([0x2000]);
			});

			it('refuses a page revoked in a call between two runs of the same access', () => {
				let yields = 0;
				const { x, denied, revoke } = guarded(mode, SET, {
					yield: () => ++yields === 2 && revoke(2)
				});
				expect(() => x.calls!(0x2000, 3)).toThrow('denied');
				expect(yields).toBe(2);
				expect(denied).toEqual([0x2000]);
			});

			it('refuses a page revoked at a loop head yield', () => {
				// the fuel pass's budget starts at 100,000, then each loop head yields
				let yields = 0;
				const { x, denied, revoke } = guarded(mode, SET, {
					fuel: () => ++yields === 3 && revoke(2)
				});
				expect(x.spin!(0x2000, 100_001)).toBe(0);
				expect(() => x.spin!(0x2000, 5)).toThrow('denied');
				expect(yields).toBe(3);
				expect(denied).toEqual([0x2000]);
			});
		});
	}
});
