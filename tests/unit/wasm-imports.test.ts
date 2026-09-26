import binaryen from 'binaryen';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const wat = `(module
	(import "env" "memory" (memory 1 65536 shared))
	(import "env" "__indirect_function_table" (table 4 funcref))
	(import "env" "__stack_pointer" (global (mut i32)))
	(import "env" "__memory_base" (global i32))
	(import "env" "__wasm_syscall_1" (func (param i32 i32) (result i32)))
	(import "env" "__wasm_abort" (func))
	(global $g (mut i32) (i32.const 0))
	(func $main (export "__main_argc_argv") (param i32 i32) (result i32) (i32.const 0))
	(func (export "_start"))
	(export "gmux_sp" (global $g))
)`;

function build() {
	const module = binaryen.parseText(wat);
	module.setFeatures(binaryen.Features.Atomics | binaryen.Features.MutableGlobals);
	const bytes = module.emitBinary();
	module.dispose();
	const path = join(mkdtempSync(join(tmpdir(), 'wasm-imports-')), 'm.wasm');
	writeFileSync(path, bytes);
	return { bytes, path };
}

const run = (...args: string[]) =>
	execFileSync('python3', ['scripts/wasm-imports.py', ...args], { encoding: 'utf8' })
		.trim()
		.split('\n');

describe('scripts/wasm-imports.py', () => {
	const { bytes, path } = build();
	const module = new WebAssembly.Module(bytes);

	it('lists every import in the order V8 reports', () => {
		expect(run(path)).toEqual(WebAssembly.Module.imports(module).map((i) => i.name));
	});

	it('lists only function exports with --exports', () => {
		const functions = WebAssembly.Module.exports(module).filter((e) => e.kind === 'function');
		expect(run('--exports', path)).toEqual(functions.map((e) => e.name));
		expect(run('--exports', path)).not.toContain('gmux_sp');
	});

	it('refuses a file that is not wasm', () => {
		const text = join(mkdtempSync(join(tmpdir(), 'wasm-imports-')), 'x.txt');
		writeFileSync(text, 'not wasm');
		expect(() => run(text)).toThrow();
	});
});
