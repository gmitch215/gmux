import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PerformanceObserver } from 'node:perf_hooks';
import { hostRuntime } from '../../../scripts/wasm/router-modules.ts';

/**
 * what one exec costs in the host, split into the parts a pool or a reset can move or remove, for a
 * BusyBox share build and Katybug, over a stand-in kernel (no machine). Per exec, mean microseconds:
 *   env      the Table, three Globals and the import object (four Suspending wrappers, closures)
 *   router   the syscall router instance with its Suspending hooks (only when a router is in use)
 *   queries  Module.imports and customSections as instantiateUser, tableEntries and shareable ask
 *   instance new WebAssembly.Instance with ready imports (data segments, start function, elem segment)
 *   first    __wasm_apply_data_relocs, the first call into the new instance
 *   reset    a finished process's instance made ready again: globals, global relocs, TLS base, pristine
 *            data copy and data relocs (share builds only)
 * `node --no-warnings --expose-gc --experimental-strip-types experiments/instances/scripts/exec-split.ts [execs] [rounds]`
 */
const root = new URL('../../../', import.meta.url).pathname;
const kernel = join(root, process.env.GMUX_BUILD ?? 'build', 'kernel');
const execs = Number(process.argv[2] ?? 2000);
const rounds = Number(process.argv[3] ?? 5);
const gc = (globalThis as { gc?: () => void }).gc;
if (!gc) throw new Error('run with --expose-gc');
const modules = hostRuntime();

const memory = new WebAssembly.Memory({ initial: 256, maximum: 4096, shared: true });
const dataStart = 0x400000;
const programs = {
	busybox: new WebAssembly.Module(readFileSync(join(kernel, 'busybox.share.wasm'))),
	katybug: new WebAssembly.Module(readFileSync(join(kernel, 'katybug.wasm')))
};

let gcMs = 0;
new PerformanceObserver((list) => {
	for (const e of list.getEntries()) gcMs += e.duration;
}).observe({ entryTypes: ['gc'] });

const note = (module: WebAssembly.Module, name: string) => {
	const s = WebAssembly.Module.customSections(module, name)[0];
	return s ? new DataView(s).getUint32(0, true) : null;
};

function env(module: WebAssembly.Module) {
	const global = new WebAssembly.Global({ value: 'i32', mutable: true }, 0x300000);
	const memoryBase = new WebAssembly.Global({ value: 'i32', mutable: note(module, 'gmux.share') !== null }, dataStart);
	const tableBase = new WebAssembly.Global({ value: 'i32', mutable: false }, 0);
	const call = (_sp: number, _tls: number, _nr: number) => 0;
	const e: Record<string, unknown> = {
		memory,
		__memory_base: memoryBase,
		__stack_pointer: global,
		__indirect_function_table: new WebAssembly.Table({
			initial: (note(module, 'gmux.table') ?? 4096) + 0,
			element: 'anyfunc'
		}),
		__table_base: tableBase,
		__table_base32: tableBase,
		__wasm_abort: () => {
			throw new WebAssembly.RuntimeError('abort');
		},
		__gmux_stack_move: (sp: number) => sp,
		__gmux_fuel: new WebAssembly.Suspending(() => 0),
		__gmux_vfork: new WebAssembly.Suspending((env: number) => env),
		__gmux_fork: () => -38,
		__gmux_vfork_exec: new WebAssembly.Suspending((a: number, b: number, c: number) => a + b + c),
		__gmux_vfork_exit: new WebAssembly.Suspending((s: number) => s)
	};
	for (let n = 0; n <= 6; n++) e[`__wasm_syscall_${n}`] = call;
	return { env: e, global, memoryBase };
}

function router() {
	const k: Record<string, unknown> = {};
	const h: Record<string, unknown> = {};
	for (let n = 0; n <= 6; n++) {
		k[n] = () => 0;
		h[n] = new WebAssembly.Suspending(() => 0);
	}
	return new WebAssembly.Instance(modules.route, {
		k: k as WebAssembly.ModuleImports,
		h: h as WebAssembly.ModuleImports,
		c: { 5: () => -1 },
		env: {
			memory,
			route: new WebAssembly.Global({ value: 'i32', mutable: true }, 0),
			cache: new WebAssembly.Global({ value: 'i32', mutable: true }, 0)
		}
	}).exports;
}

const queries = (module: WebAssembly.Module) => {
	let n = 0;
	for (let i = 0; i < 2; i++)
		n += WebAssembly.Module.imports(module).some((x) => x.module === 'gmux' && x.name === 'tlb')
			? 1
			: 0;
	n += note(module, 'gmux.table') ?? 0;
	n += WebAssembly.Module.customSections(module, 'gmux.share').length;
	return n;
};

const us = (ns: bigint, n: number) => Number(ns) / n / 1000;
const now = () => process.hrtime.bigint();

async function measure(name: keyof typeof programs) {
	const module = programs[name];
	const share = note(module, 'gmux.share');
	const out: Record<string, number> = {};
	let t: bigint;
	// warm up so V8 has compiled the module and tiered what it will
	for (let i = 0; i < 200; i++) {
		const e = env(module);
		const x = new WebAssembly.Instance(module, { env: e.env as WebAssembly.ModuleImports });
		(x.exports.__wasm_apply_data_relocs as () => void)();
	}
	gc();
	await new Promise((r) => setImmediate(r));
	gcMs = 0;
	const parts: Record<string, bigint> = { env: 0n, router: 0n, queries: 0n, instance: 0n, first: 0n };
	const t0 = now();
	for (let i = 0; i < execs; i++) {
		t = now();
		const e = env(module);
		parts.env += now() - t;
		t = now();
		router();
		parts.router += now() - t;
		t = now();
		queries(module);
		parts.queries += now() - t;
		t = now();
		const x = new WebAssembly.Instance(module, { env: e.env as WebAssembly.ModuleImports });
		parts.instance += now() - t;
		t = now();
		(x.exports.__wasm_apply_data_relocs as () => void)();
		parts.first += now() - t;
	}
	const total = now() - t0;
	await new Promise((r) => setImmediate(r));
	for (const [k, v] of Object.entries(parts)) out[k] = us(v, execs);
	out.total = us(total, execs);
	out.gcPerExec = (gcMs * 1000) / execs;
	if (share !== null) {
		const e = env(module);
		const x = new WebAssembly.Instance(module, { env: e.env as WebAssembly.ModuleImports });
		const ex = x.exports as Record<string, any>;
		const own = Object.keys(ex)
			.filter((k) => /^gmux_g\d+$/.test(k))
			.map((k) => ex[k] as WebAssembly.Global);
		const initial = own.map((g) => Number(g.value));
		const template = new Uint8Array(memory.buffer, dataStart, share).slice();
		const tls = (ex.__get_tls_base?.() ?? dataStart) - dataStart;
		const bytes = new Uint8Array(memory.buffer);
		gc();
		await new Promise((r) => setImmediate(r));
		gcMs = 0;
		t = now();
		for (let i = 0; i < execs; i++) {
			e.memoryBase.value = dataStart;
			e.global.value = 0x300000;
			for (let g = 0; g < own.length; g++) own[g]!.value = initial[g]!;
			ex.__wasm_apply_global_relocs();
			ex.__set_tls_base?.(dataStart + tls);
			bytes.set(template, dataStart);
			ex.__wasm_apply_data_relocs();
		}
		out.reset = us(now() - t, execs);
		await new Promise((r) => setImmediate(r));
		out.resetGcPerExec = (gcMs * 1000) / execs;
		// the parts of reset
		t = now();
		for (let i = 0; i < execs; i++) bytes.set(template, dataStart);
		out.resetCopy = us(now() - t, execs);
		t = now();
		for (let i = 0; i < execs; i++) {
			for (let g = 0; g < own.length; g++) own[g]!.value = initial[g]!;
			ex.__wasm_apply_global_relocs();
			ex.__set_tls_base?.(dataStart + tls);
		}
		out.resetGlobals = us(now() - t, execs);
		t = now();
		for (let i = 0; i < execs; i++) ex.__wasm_apply_data_relocs();
		out.resetRelocs = us(now() - t, execs);
		out.pristineBytes = share;
		out.globals = own.length;
	}
	return out;
}

const result: Record<string, Record<string, number>[]> = {};
for (let r = 0; r < rounds; r++)
	for (const name of Object.keys(programs) as (keyof typeof programs)[])
		(result[name] ??= []).push(
			Object.fromEntries(
				Object.entries(await measure(name)).map(([k, v]) => [k, +v.toFixed(3)])
			)
		);
console.log(JSON.stringify({ execs, rounds, node: process.version, result }));
process.exit(0);
