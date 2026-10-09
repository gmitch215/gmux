import { readFileSync } from 'node:fs';

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export interface HostImport {
	signature: string;
	fn: (...args: number[]) => number;
}

export interface Loaded {
	index: number;
	/** an export's handle for `callAt`; throws when the module has no such export */
	handle: (name: string) => number;
	/** an outermost call by name (four i32 arguments at most); a trap anywhere under it comes back as a thrown error with the interpreter's text */
	call: (name: string, ...args: number[]) => number;
	/** the guest's memory 0 as an offset into the interpreter's own memory, and its size */
	memory: () => { base: number; size: number };
}

export interface Vm {
	shim: Record<string, (...args: number[]) => number | bigint | void> & { memory: WebAssembly.Memory };
	/** parses and instantiates a guest; `glued` imports go through JavaScript (host_call), `direct` ones to host_direct (needs the re-entry build) */
	load: (bytes: Uint8Array, imports?: { glued?: Record<string, Record<string, HostImport>>; direct?: { module: string; field: string; signature: string }[] }) => Loaded;
	/** enters the interpreter at the live frame's top (the re-entry build only); up to eight i32 arguments */
	callAt: (handle: number, ...args: number[]) => number;
	/** the interpreter's last error text */
	error: () => string;
	/** puts the runtime back after a trap unwound through it; `call` does this by itself */
	recover: () => void;
	/** burrow_stack_state (the re-entry build only) */
	stackState: (index: number, which: number) => number;
}

export interface VmOptions {
	/** answers the interpreter's host_direct import; defaults to one that returns 0 */
	hostDirect?: (...args: number[]) => number;
	stackBytes?: number;
}

/**
 * The interpreter without burrow's JavaScript class, so the re-entry build's extra import and exports can be
 * driven. `host_call` copies burrow's own (the slots are read the same way) but lets an exception through:
 * a trap under a nested call has already skipped the interpreter's cleanup, and the outermost `call` is the
 * one place that puts the runtime back.
 */
export async function createVm(wasm3: WebAssembly.Module | string, options: VmOptions = {}): Promise<Vm> {
	const module = typeof wasm3 === 'string' ? new WebAssembly.Module(readFileSync(wasm3)) : wasm3;
	const handlers: { fn: (...a: number[]) => number; arity: number; returns: boolean }[] = [];
	let shim!: Vm['shim'];
	const burrow: Record<string, unknown> = {
		host_call: (id: number, sp: number, _mem: number): number => {
			const linked = handlers[id];
			if (!linked) return 1;
			const base = linked.returns ? 1 : 0;
			const slots = new BigUint64Array(shim.memory.buffer, sp);
			const args: number[] = [];
			for (let i = 0; i < linked.arity; i++) args.push(Number(BigInt.asIntN(32, slots[base + i] ?? 0n)));
			const result = linked.fn(...args);
			if (linked.returns && typeof result === 'number') new BigUint64Array(shim.memory.buffer, sp)[0] = BigInt(result) & 0xffffffffn;
			return 0;
		}
	};
	if (WebAssembly.Module.imports(module).some((i) => i.module === 'burrow' && i.name === 'host_direct')) burrow.host_direct = options.hostDirect ?? (() => 0);
	const instance = await WebAssembly.instantiate(module, { env: { emscripten_notify_memory_growth: () => {} }, burrow });
	shim = instance.exports as unknown as Vm['shim'];
	(shim as unknown as { _initialize: () => void })._initialize();
	if (shim.burrow_init!(options.stackBytes ?? 8 << 20, 0) !== 0) throw new Error('burrow_init failed');

	const names = new Map<string, number>();
	const cstr = (s: string) => {
		let p = names.get(s);
		if (p === undefined) {
			const bytes = encoder.encode(`${s}\0`);
			p = shim.burrow_alloc!(bytes.length) as number;
			new Uint8Array(shim.memory.buffer).set(bytes, p);
			names.set(s, p);
		}
		return p;
	};
	const error = () => {
		const ptr = shim.burrow_error!() as number;
		const bytes = new Uint8Array(shim.memory.buffer);
		let end = ptr;
		while (bytes[end]) end++;
		return decoder.decode(bytes.subarray(ptr, end));
	};
	const recover = () => (shim.burrow_recover as () => void)();
	const parseSig = (signature: string) => {
		const open = signature.indexOf('(');
		return { arity: signature.slice(open + 1, signature.lastIndexOf(')')).length, returns: signature[0] !== 'v' };
	};
	const callAt = (handle: number, ...args: number[]) => {
		const a = [handle, ...args];
		while (a.length < 9) a.push(0);
		return (shim.burrow_call_at as (...x: number[]) => number)(...a);
	};

	const load: Vm['load'] = (bytes, imports = {}) => {
		const ptr = shim.burrow_alloc!(bytes.length) as number;
		new Uint8Array(shim.memory.buffer).set(bytes, ptr);
		const index = shim.burrow_parse!(ptr, bytes.length) as number;
		if (index < 0) throw new Error(`parse: ${error()}`);
		if (shim.burrow_instantiate!(index) !== 0) throw new Error(`instantiate: ${error()}`);
		for (const [moduleName, fields] of Object.entries(imports.glued ?? {}))
			for (const [field, spec] of Object.entries(fields)) {
				const id = shim.burrow_link!(index, cstr(moduleName), cstr(field), cstr(spec.signature)) as number;
				if (id < 0) throw new Error(`link ${moduleName}.${field}: ${error()}`);
				handlers[id] = { fn: spec.fn, ...parseSig(spec.signature) };
			}
		(imports.direct ?? []).forEach((d, k) => {
			const id = (shim.burrow_link_direct as (...x: number[]) => number)(index, cstr(d.module), cstr(d.field), cstr(d.signature));
			if (id < 0) throw new Error(`link direct ${d.module}.${d.field}: ${error()}`);
			if (id !== k) throw new Error(`direct import ${d.field} got id ${id}, expected ${k}: link the direct imports first and in dispatch order`);
		});
		return {
			index,
			handle: (name) => {
				const h = (shim.burrow_handle as (...x: number[]) => number)(index, cstr(name));
				if (!h) throw new Error(`no export ${name}: ${error()}`);
				return h;
			},
			call: (name, ...args) => {
				const [a0 = 0, a1 = 0, a2 = 0, a3 = 0] = args;
				let out: number;
				try {
					out = Number(shim.burrow_call_in!(index, cstr(name), a0, a1, a2, a3));
				} catch (e) {
					const text = error();
					recover();
					throw new Error(`${name}: ${text || String(e)}`, { cause: e });
				}
				const text = error();
				if (text) throw new Error(`${name}: ${text}`);
				return out;
			},
			memory: () => ({ base: shim.burrow_mem_ptr!(index) as number, size: shim.burrow_mem_size!(index) as number })
		};
	};

	return { shim, load, callAt, error, recover, stackState: (index, which) => (shim.burrow_stack_state as (...x: number[]) => number)(index, which) };
}
