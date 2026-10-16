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
	/** the guest memory build's shared Memory (the guest's bytes at base 0, and the native module's memory 0); absent in the other builds */
	guest?: WebAssembly.Memory;
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
	/** burrow's maxMemoryBytes (0 or absent: none) */
	memoryLimit?: number;
	/** the guest memory build's shared Memory: the guest's limits in pages (see `memoryLimits`); it is created here, capped to 65,535 pages and to memoryLimit */
	guest?: { initial: number; maximum?: number };
}

const leb = (b: Uint8Array, at: { i: number }) => {
	let v = 0;
	for (let shift = 0; ; shift += 7) {
		const x = b[at.i++]!;
		v += (x & 0x7f) * 2 ** shift;
		if (!(x & 0x80)) return v;
	}
};

/** the limits, in pages, of a module's memory 0 (a defined memory or an imported one), read from the binary */
export function memoryLimits(bytes: Uint8Array): { initial: number; maximum?: number } {
	const at = { i: 8 };
	const limits = () => {
		const flags = leb(bytes, at);
		const initial = leb(bytes, at);
		return flags & 1 ? { initial, maximum: leb(bytes, at) } : { initial };
	};
	while (at.i < bytes.length) {
		const id = bytes[at.i++]!;
		const size = leb(bytes, at);
		const end = at.i + size;
		if (id === 5) {
			leb(bytes, at);
			return limits();
		}
		if (id === 2) {
			for (let n = leb(bytes, at); n > 0; n--) {
				for (let k = 0; k < 2; k++) {
					const length = leb(bytes, at);
					at.i += length;
				}
				const kind = bytes[at.i++]!;
				if (kind === 2) return limits();
				if (kind === 0) leb(bytes, at);
				else if (kind === 1) {
					at.i++;
					limits();
				} else if (kind === 3) at.i += 2;
				else throw new Error(`import kind ${kind}`);
			}
		}
		at.i = end;
	}
	throw new Error('the module has no memory');
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
	const wanted = WebAssembly.Module.imports(module);
	const env: Record<string, WebAssembly.ImportValue> = { emscripten_notify_memory_growth: () => {} };
	// the guest memory build imports both its own memory and the guest's (see tools/interp/guest-memory.mjs)
	const own = wanted.some((i) => i.module === 'env' && i.name === 'memory') ? new WebAssembly.Memory({ initial: 256, maximum: 32768 }) : undefined;
	let guest: WebAssembly.Memory | undefined;
	if (wanted.some((i) => i.module === 'env' && i.name === 'guest_memory')) {
		if (!options.guest) throw new Error('the guest memory build needs options.guest (the guest\'s limits in pages)');
		const cap = Math.min(options.guest.maximum ?? 65535, 65535, options.memoryLimit ? Math.floor(options.memoryLimit / 65536) : 65535);
		guest = new WebAssembly.Memory({ initial: options.guest.initial, maximum: Math.max(cap, options.guest.initial) });
		env.guest_memory = guest;
	}
	if (own) env.memory = own;
	const instance = await WebAssembly.instantiate(module, { env, burrow });
	shim = (own ? Object.assign({}, instance.exports, { memory: own }) : instance.exports) as unknown as Vm['shim'];
	(shim as unknown as { _initialize: () => void })._initialize();
	if (shim.burrow_init!(options.stackBytes ?? 8 << 20, options.memoryLimit ?? 0) !== 0) throw new Error('burrow_init failed');

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

	return { shim, guest, load, callAt, error, recover, stackState: (index, which) => (shim.burrow_stack_state as (...x: number[]) => number)(index, which) };
}
