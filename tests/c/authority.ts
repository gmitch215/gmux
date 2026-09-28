import { randomUUID } from 'node:crypto';
import { claim } from '../../src/worker/owner.ts';

/**
 * The host's side of the authority probe (tests/c/authority.c, SECURITY.md's authority domains):
 * values only the host holds, every memory and import a guest instance gets, and a scan of those
 * memories for the values. Root reads all of a machine's memory, so what is not in any of them is
 * out of guest root's reach.
 */

/** the prefix the probe looks for in the machine's memory */
export const HOST_ONLY = 'GMUX-HOST-ONLY';

/**
 * what only the host holds: a Worker env's secret, a secret in the host process's environment,
 * and the owner token with the hash the machine's Durable Object stores
 */
export async function hostOnly(): Promise<string[]> {
	const secret = `${HOST_ONLY}-env-${randomUUID()}`;
	const process_ = `${HOST_ONLY}-process-${randomUUID()}`;
	process.env.GMUX_HOST_SECRET = process_;
	let hash: string | null = null;
	const token = await claim({ get: () => hash, set: (h) => void (hash = h) });
	return [secret, process_, token!, hash!];
}

/** the imports a guest instance may take: the kernel's drivers and a program's syscall surface */
export const SURFACE =
	/^env\.(memory|wasm_\w+|__indirect_function_table|__stack_pointer|__memory_base|__table_base|__wasm_syscall_[0-6]|__wasm_abort|__gmux_(fuel|fork|stack_move|vfork|vfork_exec|vfork_exit|dlprep|dlopen|dlsym|dlclose|dlerror|denied|mmu_miss|mmu_fault))$|^gmux\.(table|tag|set)$/;

export interface Watch {
	memories: WebAssembly.Memory[];
	imports: Set<string>;
	stop(): void;
}

/**
 * records every memory created and every import the host supplies from now until stop(); an import
 * bound to another instance's export (a side module's `malloc` from its program) is not the host's
 */
export function watch(): Watch {
	const W = WebAssembly as unknown as Record<string, unknown>;
	const { Memory, Instance, instantiate } = WebAssembly;
	const memories: WebAssembly.Memory[] = [];
	const imports = new Set<string>();
	const exported = new WeakSet<object>();
	const note = (module: WebAssembly.Module, i?: WebAssembly.Imports) => {
		for (const d of WebAssembly.Module.imports(module)) {
			const value = (i?.[d.module] as Record<string, unknown> | undefined)?.[d.name];
			if (typeof value !== 'function' || !exported.has(value))
				imports.add(`${d.module}.${d.name}`);
		}
	};
	const keep = (instance: WebAssembly.Instance) => {
		for (const e of Object.values(instance.exports))
			if (typeof e === 'function') exported.add(e);
		return instance;
	};
	const HookedMemory = function (d: WebAssembly.MemoryDescriptor) {
		const m = new Memory(d);
		memories.push(m);
		return m;
	};
	HookedMemory.prototype = Memory.prototype;
	const HookedInstance = function (m: WebAssembly.Module, i?: WebAssembly.Imports) {
		note(m, i);
		return keep(new Instance(m, i));
	};
	HookedInstance.prototype = Instance.prototype;
	W.Memory = HookedMemory;
	W.Instance = HookedInstance;
	W.instantiate = async (source: WebAssembly.Module | BufferSource, i?: WebAssembly.Imports) => {
		const r = await (instantiate as (s: unknown, i?: WebAssembly.Imports) => Promise<unknown>)(
			source,
			i
		);
		if (source instanceof WebAssembly.Module) {
			note(source, i);
			keep(r as WebAssembly.Instance);
		} else {
			const { module, instance } = r as WebAssembly.WebAssemblyInstantiatedSource;
			note(module, i);
			keep(instance);
		}
		return r;
	};
	return {
		memories,
		imports,
		stop: () => {
			W.Memory = Memory;
			W.Instance = Instance;
			W.instantiate = instantiate;
		}
	};
}

/** each value found in any memory, as "value #i at memory m offset o" */
export function leaks(values: string[], memories: ArrayBufferLike[]): string[] {
	const found: string[] = [];
	values.forEach((v, i) =>
		memories.forEach((buffer, m) => {
			const at = Buffer.from(buffer as ArrayBuffer).indexOf(v);
			if (at >= 0) found.push(`value #${i} at memory ${m} offset ${at}`);
		})
	);
	return found;
}
