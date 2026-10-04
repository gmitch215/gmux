/**
 * `gmux-core.wasm` (scripts/build-core.sh, src/gmux/core): the host runtime's hot decisions in C.
 * Like vmlinux it is a bundled static module, compiled when the Worker starts. It imports the
 * machine's own memory and keeps its state in a region the machine reserves for it before the
 * kernel boots, so a pointer the host hands it (an idle word) is an address in that memory.
 */

/** the ABI version this file speaks; `core_version()` must return it */
export const CORE_ABI = 1;

/** the stack a module may use, above its data in the region */
const CORE_STACK = 16384;
const PAGE = 0x10000;

/** the exports of gmux-core.wasm; slots name host runners and are the host's to hand out */
export interface Core {
	core_version(): number;
	/** empties the idle table and the ready queue */
	core_reset(): void;
	/** arms a cpu's wait on its interrupt word (an address) and an optional deadline (negative: none) */
	core_idle(slot: number, order: number, word: number, deadline: bigint): number;
	/** disarms a cpu's wait; 1 when it had one */
	core_cancel(slot: number): number;
	/** the first armed cpu, by order, whose word is raised or whose deadline is due; -1 when none */
	core_pick(now: bigint): number;
	/** the earliest armed deadline, or -1n */
	core_deadline(): bigint;
	core_idle_count(): number;
	core_ready_push(slot: number): number;
	core_ready_unshift(slot: number): number;
	core_ready_shift(): number;
	core_ready_count(): number;
	core_ready_at(index: number): number;
}

/** the bytes of memory a module needs, from its dylink.0 section, with its stack, in whole pages */
export function coreRegionPages(module: WebAssembly.Module): number {
	return Math.ceil(layout(module).top / PAGE);
}

function layout(module: WebAssembly.Module): { data: number; top: number } {
	const section = WebAssembly.Module.customSections(module, 'dylink.0')[0];
	if (!section) throw new Error('core: the module has no dylink.0 section');
	const bytes = new Uint8Array(section);
	let p = 0;
	const leb = () => {
		let value = 0;
		for (let shift = 0; ; shift += 7) {
			const byte = bytes[p++];
			if (byte === undefined) throw new RangeError('core: truncated dylink.0');
			value |= (byte & 0x7f) << shift;
			if (!(byte & 0x80)) return value >>> 0;
		}
	};
	while (p < bytes.length) {
		const type = bytes[p++]!;
		const size = leb();
		if (type === 1) {
			const data = leb();
			const align = 2 ** leb();
			const aligned = Math.ceil(data / Math.max(align, 16)) * Math.max(align, 16);
			return { data: aligned, top: aligned + CORE_STACK };
		}
		p += size;
	}
	throw new Error('core: dylink.0 has no memory information');
}

/**
 * Instantiates the module over `memory` with its data and stack in the pages starting at byte
 * `base` (a multiple of 16, `coreRegionPages(module)` pages the caller reserved and zeroed).
 */
export function loadCore(
	module: WebAssembly.Module,
	memory: WebAssembly.Memory,
	base: number
): Core {
	if (base % 16) throw new RangeError(`core: base ${base} is not 16-byte aligned`);
	const { top } = layout(module);
	const env: Record<string, unknown> = {
		memory,
		__indirect_function_table: new WebAssembly.Table({ initial: 0, element: 'anyfunc' }),
		__memory_base: new WebAssembly.Global({ value: 'i32', mutable: false }, base),
		__table_base: new WebAssembly.Global({ value: 'i32', mutable: false }, 0)
	};
	for (const { module: from, name } of WebAssembly.Module.imports(module))
		if (from === 'env' && name === '__stack_pointer')
			env.__stack_pointer = new WebAssembly.Global(
				{ value: 'i32', mutable: true },
				base + top
			);
	const core = new WebAssembly.Instance(module, { env: env as WebAssembly.ModuleImports })
		.exports as unknown as Core;
	if (core.core_version() !== CORE_ABI)
		throw new Error(`core: module speaks ABI ${core.core_version()}, this host ${CORE_ABI}`);
	// the module's start function skips its zeroing when its data was initialised before (a restore)
	core.core_reset();
	return core;
}
