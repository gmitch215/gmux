import binaryen from 'binaryen';
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { DlProcess, dylinkInfo, type DlInstance } from '../../src/worker/machine/dl.ts';

const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

function build(text: string, dylink?: number[]): Uint8Array {
	const module = binaryen.parseText(text);
	module.setFeatures(
		binaryen.Features.MutableGlobals |
			binaryen.Features.ReferenceTypes |
			binaryen.Features.ExceptionHandling
	);
	const bytes = module.emitBinary();
	module.dispose();
	if (!dylink) return bytes;
	// dylink.0 goes first: id 0, size, name, then its memory-info subsection
	const name = [...new TextEncoder().encode('dylink.0')];
	const body = [name.length, ...name, 1, dylink.length, ...dylink];
	return new Uint8Array([...bytes.subarray(0, 8), 0, body.length, ...body, ...bytes.subarray(8)]);
}

// memory 8 bytes aligned 4 (2^2), one table slot
const SIDE = build(
	`(module
	(import "env" "memory" (memory 1))
	(import "env" "__indirect_function_table" (table 0 funcref))
	(import "env" "__memory_base" (global $mb i32))
	(import "env" "__table_base" (global $tb i32))
	(import "env" "__stack_pointer" (global $sp (mut i32)))
	(import "env" "__gmux_fuel" (func $fuel (result i32)))
	(import "env" "twice" (func $twice (param i32) (result i32)))
	(import "GOT.mem" "counter" (global $counter (mut i32)))
	(import "GOT.func" "helper" (global $helper (mut i32)))
	(global $low (mut i32) (i32.const 0))
	(global (export "counter") i32 (i32.const 4))
	(elem (global.get $tb) $inner)
	(func $inner (result i32) (i32.const 7))
	(func (export "__wasm_apply_data_relocs") (i32.store (global.get $mb) (global.get $tb)))
	(func (export "quad") (param i32) (result i32) (call $twice (call $twice (local.get 0))))
	(func (export "bump") (result i32)
		(i32.store (global.get $counter) (i32.add (i32.load (global.get $counter)) (i32.const 1)))
		(i32.load (global.get $counter)))
	(func (export "helper_index") (result i32) (global.get $helper))
	(func (export "inner_via_data") (result i32) (call_indirect (result i32) (i32.load (global.get $mb))))
	(func (export "fuel") (result i32) (call $fuel))
	(func (export "__gmux_set_stack_limits") (param i32 i32) (global.set $low (local.get 1)))
	(func (export "low") (result i32) (global.get $low)))`,
	[8, 2, 1, 0]
);

const PROGRAM = build(`(module
	(func (export "twice") (param i32) (result i32) (i32.mul (local.get 0) (i32.const 2)))
	(func (export "helper") (result i32) (i32.const 99))
	(global (export "shared") i32 (i32.const 16)))`);

const DATA_START = 0x8000;
const LIB_AT = 1024;
const INFO = 64;
const MEMORY_BASE = 4096;

function setup(extra: [Uint8Array, WebAssembly.Module][] = [], programBytes = PROGRAM) {
	const memory = new WebAssembly.Memory({ initial: 1 });
	const registry = new Map([[sha256(SIDE), new WebAssembly.Module(SIDE)]]);
	for (const [bytes, module] of extra) registry.set(sha256(bytes), module);
	const process = new DlProcess(memory, registry, sha256, DATA_START);
	const instance = (): DlInstance => ({
		exports: new WebAssembly.Instance(new WebAssembly.Module(programBytes)).exports as Record<
			string,
			any
		>,
		table: new WebAssembly.Table({ initial: 4, element: 'anyfunc' }),
		stackPointer: new WebAssembly.Global({ value: 'i32', mutable: true }, 60000),
		env: { memory, __gmux_fuel: () => 42 }
	});
	const view = process.view();
	const program = instance();
	view.attach(program);
	const calls = view.imports();
	const put = (bytes: Uint8Array) => new Uint8Array(memory.buffer).set(bytes, LIB_AT);
	const error = () => {
		const n = calls.__gmux_dlerror!(2048, 256);
		return new TextDecoder().decode(new Uint8Array(memory.buffer, 2048, n));
	};
	const name = (text: string) => {
		new Uint8Array(memory.buffer).set([...new TextEncoder().encode(text), 0], 3000);
		return 3000;
	};
	const open = (bytes = SIDE) => {
		put(bytes);
		if (calls.__gmux_dlprep!(LIB_AT, bytes.length, INFO) < 0) return -1;
		return calls.__gmux_dlopen!(LIB_AT, bytes.length, MEMORY_BASE);
	};
	return { memory, process, view, program, calls, instance, open, error, name };
}

describe('dylinkInfo', () => {
	it('reads the memory and table needs', () => {
		expect(dylinkInfo(SIDE)).toEqual({ memorySize: 8, memoryAlign: 4, tableSize: 1 });
	});
	it('has none for a program, an ELF or garbage', () => {
		expect(dylinkInfo(PROGRAM)).toBeNull();
		expect(dylinkInfo(new Uint8Array([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1, 0]))).toBeNull();
		expect(dylinkInfo(new Uint8Array([0, 0x61, 0x73, 0x6d, 1, 0, 0, 0, 0, 0x7f]))).toBeNull();
	});
});

describe('dlopen', () => {
	it('prepares, relocates and resolves a side module', () => {
		const { memory, calls, program, open, name } = setup();
		{
			const view = new DataView(memory.buffer);
			expect(open()).toBe(1);
			expect([
				view.getUint32(INFO, true),
				view.getUint32(INFO + 4, true),
				view.getUint32(INFO + 8, true)
			]).toEqual([8, 4, 1]);
			// the data relocation stored the library's own function slot at its memory base
			const slot = view.getUint32(MEMORY_BASE, true);
			expect(slot).toBe(4);
			expect((program.table.get(slot) as () => number)()).toBe(7);
		}
		const quad = calls.__gmux_dlsym!(1, name('quad'));
		expect((program.table.get(quad) as (x: number) => number)(5)).toBe(20);
		expect(calls.__gmux_dlsym!(1, name('quad'))).toBe(quad);
		// GOT.mem found no program symbol, so it is the library's own data
		expect(calls.__gmux_dlsym!(1, name('counter'))).toBe(MEMORY_BASE + 4);
		const bump = program.table.get(calls.__gmux_dlsym!(1, name('bump'))) as () => number;
		bump();
		expect(bump()).toBe(2);
		// GOT.func: the program's function, given a slot
		const helper = (
			program.table.get(calls.__gmux_dlsym!(1, name('helper_index'))) as () => number
		)();
		expect((program.table.get(helper) as () => number)()).toBe(99);
		expect(
			(program.table.get(calls.__gmux_dlsym!(1, name('inner_via_data'))) as () => number)()
		).toBe(7);
		// the host's own imports come from the program's
		expect((program.table.get(calls.__gmux_dlsym!(1, name('fuel'))) as () => number)()).toBe(
			42
		);
		// the program itself: handle 0, data exports from its data start
		expect(calls.__gmux_dlsym!(0, name('shared'))).toBe(DATA_START + 16);
		expect(calls.__gmux_dlsym!(1, name('missing'))).toBe(0);
	});

	it('refuses bytes the registry does not hold, with the reason', () => {
		const { open, error } = setup();
		const other = build('(module (func (export "f")))', [0, 0, 0, 0]);
		expect(open(other)).toBe(-1);
		expect(error()).toMatch(
			/not in the exec registry \(sha256 [0-9a-f]{64}\); code cannot be compiled at run time/
		);
		expect(open(new Uint8Array([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1, 0]))).toBe(-1);
		expect(error()).toBe('an ELF shared object, not a wasm side module');
		expect(open(PROGRAM)).toBe(-1);
		expect(error()).toMatch(/no dylink.0 section/);
	});

	it('refuses an executable', () => {
		const exe = build('(module (func (export "_start")))', [0, 0, 0, 0]);
		const { open, error } = setup([[exe, new WebAssembly.Module(exe)]]);
		expect(open(exe)).toBe(-1);
		expect(error()).toBe('an executable, not a shared library');
	});

	it('refuses an import nothing defines', () => {
		const lonely = build(
			`(module (import "env" "nowhere" (func)) (func (export "f")))`,
			[0, 0, 0, 0]
		);
		const { open, error } = setup([[lonely, new WebAssembly.Module(lonely)]]);
		expect(open(lonely)).toBe(-1);
		expect(error()).toBe('undefined symbol: nowhere');
	});

	it('gives a new instance (a thread) the loaded libraries without relocating again', () => {
		const { process, open, calls, name, memory, instance } = setup();
		open();
		const quad = calls.__gmux_dlsym!(1, name('quad'));
		new DataView(memory.buffer).setUint32(MEMORY_BASE, 12345, true);
		const thread = instance();
		process.view().attach(thread);
		expect(new DataView(memory.buffer).getUint32(MEMORY_BASE, true)).toBe(12345);
		expect((thread.table.get(quad) as (x: number) => number)(3)).toBe(12);
		expect((thread.table.get(4) as () => number)()).toBe(7);
	});

	it('comes back from a snapshot', () => {
		const { process, open, calls, name, memory, instance } = setup();
		open();
		const quad = calls.__gmux_dlsym!(1, name('quad'));
		const saved = JSON.parse(JSON.stringify(process.save()));
		const again = new DlProcess(
			memory,
			new Map([[sha256(SIDE), new WebAssembly.Module(SIDE)]]),
			sha256,
			DATA_START
		);
		again.load(saved);
		const program = instance();
		again.view().attach(program);
		expect((program.table.get(quad) as (x: number) => number)(4)).toBe(16);
		expect(() => new DlProcess(memory, new Map(), sha256, DATA_START).load(saved)).toThrow(
			/no side module/
		);
	});

	it('forwards stack limits and forgets a closed library', () => {
		const { view, open, calls, name, program } = setup();
		view.stackLimits(9000, 5000);
		open();
		const low = program.table.get(calls.__gmux_dlsym!(1, name('low'))) as () => number;
		expect(low()).toBe(5000);
		view.stackLimits(8000, 4000);
		expect(low()).toBe(4000);
		expect(calls.__gmux_dlclose!(1)).toBe(0);
		expect(calls.__gmux_dlsym!(1, name('quad'))).toBe(0);
	});
});

// an evacuable program (experiments/evacuation/scripts/evacuate.ts --resume) and a side module that
// shares its unwind state and resume table instead of having its own
const RESUMABLE_PROGRAM = build(`(module
	(tag (export "gmux_ckpt"))
	(global (export "gmux_fp") (mut i32) (i32.const 0))
	(global (export "gmux_unwinding") (mut i32) (i32.const 0))
	(table (export "gmux_resume") 1 funcref)
	(func (export "twice") (param i32) (result i32) (i32.mul (local.get 0) (i32.const 2)))
	(func (export "twice$resume") (result i32) (i32.const 222))
	(func (export "helper") (result i32) (i32.const 99)))`);

const RESUMABLE_SIDE = build(
	`(module
	(import "env" "memory" (memory 1))
	(import "env" "__indirect_function_table" (table $calls 0 funcref))
	(import "env" "__memory_base" (global $mb i32))
	(import "env" "__table_base" (global $tb i32))
	(import "gmux" "fp" (global $fp (mut i32)))
	(import "gmux" "unwinding" (global $unwinding (mut i32)))
	(import "gmux" "ckpt" (tag $ckpt))
	(import "gmux" "resume" (table $resume 0 funcref))
	(import "env" "twice" (func $twice (param i32) (result i32)))
	(import "env" "twice$resume" (func $twice_resume (result i32)))
	(import "env" "helper$resume" (func $helper_resume (result i32)))
	(elem (table $calls) (global.get $tb) func $quad)
	(elem (table $resume) (global.get $tb) func $quad_resume)
	(func $quad (export "quad") (param i32) (result i32) (call $twice (call $twice (local.get 0))))
	(func $quad_resume (export "quad$resume") (result i32) (i32.const 444))
	(func (export "fp_now") (result i32) (global.get $fp))
	(func (export "twice_resumed") (result i32) (call $twice_resume))
	(func (export "helper_resumed") (result i32) (call $helper_resume)))`,
	[0, 0, 1, 0]
);

describe('dlopen of resumable side modules', () => {
	const side: [Uint8Array, WebAssembly.Module][] = [
		[RESUMABLE_SIDE, new WebAssembly.Module(RESUMABLE_SIDE)]
	];

	it('shares the program state and keeps the resume table beside the call table', () => {
		const { program, calls, name, open } = setup(side, RESUMABLE_PROGRAM);
		const resume = program.exports.gmux_resume as WebAssembly.Table;
		expect(open(RESUMABLE_SIDE)).toBe(1);
		expect(resume.length).toBe(program.table.length);
		// the library's own slot, its variant at the same index
		expect((resume.get(4) as () => number)()).toBe(444);
		const quad = calls.__gmux_dlsym!(1, name('quad'));
		expect(resume.length).toBe(program.table.length);
		expect((program.table.get(quad) as (x: number) => number)(5)).toBe(20);
		expect((resume.get(quad) as () => number)()).toBe(444);
		const call = (symbol: string) =>
			(program.table.get(calls.__gmux_dlsym!(1, name(symbol))) as () => number)();
		(program.exports.gmux_fp as WebAssembly.Global).value = 77;
		expect(call('fp_now')).toBe(77);
		expect(call('twice_resumed')).toBe(222);
		// a function with no variant cannot be on a checkpointed stack: its stub only throws
		expect(() => call('helper_resumed')).toThrow('no resume variant: helper$resume');
	});

	it('gives a new instance the variants again', () => {
		const { process, calls, name, open, instance } = setup(side, RESUMABLE_PROGRAM);
		open(RESUMABLE_SIDE);
		const quad = calls.__gmux_dlsym!(1, name('quad'));
		const thread = instance();
		process.view().attach(thread);
		const resume = thread.exports.gmux_resume as WebAssembly.Table;
		expect(resume.length).toBe(thread.table.length);
		expect((resume.get(4) as () => number)()).toBe(444);
		expect((resume.get(quad) as () => number)()).toBe(444);
	});

	it('refuses one whose program has no resumable frames', () => {
		const { open, error } = setup(side);
		expect(open(RESUMABLE_SIDE)).toBe(-1);
		expect(error()).toMatch(/unsupported import gmux\.\w+: the program is not evacuable/);
	});
});
