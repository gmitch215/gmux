/**
 * dlopen for gmux programs (src/gmux/dl.c): a side module is a wasm shared library (`-shared`, a
 * dylink.0 section) whose bytes hash to a precompiled module in the exec registry. It is
 * instantiated over the process's memory and table, its data at memory the process allocated, its
 * imports resolved against the program's exports, then earlier side modules'. A Worker cannot
 * compile code at run time, so bytes with no registered module are refused.
 */

/** a side module's needs, from its dylink.0 section */
export interface DylinkInfo {
	/** bytes of data and bss the module needs */
	memorySize: number;
	/** the alignment of that memory, in bytes */
	memoryAlign: number;
	/** function table slots it needs */
	tableSize: number;
}

/** reads dylink.0's memory information from a wasm binary; null when there is none */
export function dylinkInfo(bytes: Uint8Array): DylinkInfo | null {
	if (
		bytes.length < 8 ||
		bytes[0] !== 0 ||
		bytes[1] !== 0x61 ||
		bytes[2] !== 0x73 ||
		bytes[3] !== 0x6d
	)
		return null;
	let p = 8;
	const leb = () => {
		let value = 0;
		let shift = 0;
		let byte: number;
		do {
			if (p >= bytes.length) throw new RangeError('truncated');
			byte = bytes[p++]!;
			value |= (byte & 0x7f) << shift;
			shift += 7;
		} while (byte & 0x80);
		return value >>> 0;
	};
	try {
		while (p < bytes.length) {
			const id = bytes[p++]!;
			const size = leb();
			const end = p + size;
			if (id === 0) {
				const length = leb();
				const name = new TextDecoder().decode(bytes.subarray(p, p + length));
				p += length;
				if (name === 'dylink.0') {
					while (p < end) {
						const type = bytes[p++]!;
						const length = leb();
						if (type === 1) {
							const memorySize = leb();
							const memoryAlign = 2 ** leb();
							const tableSize = leb();
							return { memorySize, memoryAlign, tableSize };
						}
						p += length;
					}
					return { memorySize: 0, memoryAlign: 1, tableSize: 0 };
				}
			}
			p = end;
		}
	} catch {
		return null;
	}
	return null;
}

/** what a process's side modules resolve against in one program instance */
export interface DlInstance {
	exports: Record<string, any>;
	table: WebAssembly.Table;
	stackPointer: WebAssembly.Global;
	/** the program's own imports, which instrumented side modules share (fuel, stack checks) */
	env: Record<string, unknown>;
}

interface Lib {
	handle: number;
	hash: string;
	module: WebAssembly.Module;
	memoryBase: number;
	tableBase: number;
	tableSize: number;
}

/** a table slot dlsym or a GOT.func import handed out: the function `name` of `owner` (0: the program) */
/** a function `dlsym` gave a table slot */
export interface Slot {
	/** the library handle that exports it, 0 for the program */
	owner: number;
	/** its export name */
	name: string;
	/** its slot in the call table */
	index: number;
}

const OWN_IMPORTS = new Set([
	'memory',
	'__indirect_function_table',
	'__stack_pointer',
	'__memory_base',
	'__table_base',
	'__table_base32'
]);

/** a process's side modules in a machine snapshot */
export interface DlSaved {
	/** the program's data start, which names the process */
	dataStart: number;
	/** the next library handle to hand out */
	next: number;
	/** each loaded library: its handle, registry hash, and where its data and table slots sit */
	libs: {
		handle: number;
		hash: string;
		memoryBase: number;
		tableBase: number;
		tableSize: number;
	}[];
	/** the table slots `dlsym` handed out */
	slots: Slot[];
}

/** wasm side modules the registry did not hold, by the hash of the executable that asked for them */
export type DlMisses = Map<string, Set<string>>;

/** how a process records a refused library */
export interface DlRecord {
	misses: DlMisses;
	/** whether an interpreted tier can take the recorded libraries on the next run */
	interpreter: boolean;
	onMiss?: (exe: string, lib: string) => void;
}

/** one process's side modules; each program instance of it (threads) gets a view */
export class DlProcess {
	readonly libs: Lib[] = [];
	readonly slots: Slot[] = [];
	/** the executable this process runs, named in a refusal and keyed in the miss record */
	exe: { hash: string; name: string } | null = null;
	private next = 1;
	private error = '';

	private readonly memory: WebAssembly.Memory;
	private readonly registry: Map<string, WebAssembly.Module>;
	private readonly sha256: (bytes: Uint8Array) => string;
	/** the program's data start: its data exports are offsets from it */
	private readonly dataStart: number;
	private readonly record: DlRecord;

	constructor(
		memory: WebAssembly.Memory,
		registry: Map<string, WebAssembly.Module>,
		sha256: (bytes: Uint8Array) => string,
		dataStart: number,
		record: DlRecord = { misses: new Map(), interpreter: false }
	) {
		this.memory = memory;
		this.registry = registry;
		this.sha256 = sha256;
		this.dataStart = dataStart;
		this.record = record;
	}

	save(): DlSaved {
		return {
			dataStart: this.dataStart,
			next: this.next,
			libs: this.libs.map(({ module: _, ...lib }) => lib),
			slots: this.slots.map((s) => ({ ...s }))
		};
	}

	/** a snapshot's state; its data is already in the restored memory */
	load(saved: DlSaved): void {
		this.next = saved.next;
		for (const lib of saved.libs) {
			const module = this.registry.get(lib.hash);
			if (!module) throw new Error(`restore: no side module for ${lib.hash}`);
			this.libs.push({ ...lib, module });
		}
		this.slots.push(...saved.slots.map((s) => ({ ...s })));
	}

	/** the imports for one program instance; `attach` it once the instance exists */
	view(): DlView {
		return new DlView(this);
	}

	fail(message: string): number {
		this.error = message;
		return -1;
	}

	lastError(): string {
		return this.error;
	}

	/** checks the bytes and reports what the library needs: memory size and alignment, table size */
	prepare(bytes: Uint8Array): (DylinkInfo & { hash: string }) | null {
		const info = dylinkInfo(bytes);
		if (!info) {
			this.fail(
				bytes[0] === 0x7f && bytes[1] === 0x45
					? 'an ELF shared object, not a wasm side module'
					: 'not a wasm side module (no dylink.0 section: build it with -shared)'
			);
			return null;
		}
		const hash = this.sha256(bytes);
		const module = this.registry.get(hash);
		if (!module) {
			const { exe } = this;
			const who = exe ? `${exe.name} (sha256 ${exe.hash})` : 'this process';
			let next = 'the miss is not recorded (no executable)';
			if (exe) {
				next =
					'the interpreted tier is not available, so the next run is refused the same way';
				const libs = this.record.misses.get(exe.hash) ?? new Set<string>();
				libs.add(hash);
				this.record.misses.set(exe.hash, libs);
				this.record.onMiss?.(exe.hash, hash);
				if (this.record.interpreter)
					next =
						'the next run starts on the interpreted tier with this library interpreted';
			}
			this.fail(
				`not in the exec registry (sha256 ${hash}); ${who} cannot load it because a Worker cannot compile code at run time, and side modules ship precompiled with the build; ${next}`
			);
			return null;
		}
		if (WebAssembly.Module.exports(module).some((e) => e.name === '_start')) {
			this.fail('an executable, not a shared library');
			return null;
		}
		return { ...info, hash };
	}

	add(hash: string, memoryBase: number, tableBase: number, tableSize: number): Lib {
		const lib = {
			handle: this.next++,
			hash,
			module: this.registry.get(hash)!,
			memoryBase,
			tableBase,
			tableSize
		};
		this.libs.push(lib);
		return lib;
	}

	remove(handle: number): void {
		const at = this.libs.findIndex((l) => l.handle === handle);
		if (at >= 0) this.libs.splice(at, 1);
	}

	/** a data export's address: side modules' offsets are from their memory base, the program's from its data start */
	address(owner: number, value: number): number {
		const lib = this.libs.find((l) => l.handle === owner);
		return (lib ? lib.memoryBase : this.dataStart) + value;
	}

	readString(at: number): string {
		const bytes = new Uint8Array(this.memory.buffer);
		let end = at;
		while (end < bytes.length && bytes[end] !== 0) end++;
		return new TextDecoder().decode(bytes.subarray(at, end));
	}

	get buffer(): ArrayBuffer {
		return this.memory.buffer as ArrayBuffer;
	}
}

/** a process's side modules as one program instance sees them */
export class DlView {
	private instance: DlInstance | null = null;
	private readonly instances = new Map<number, WebAssembly.Instance>();
	private limits: [number, number] | null = null;

	/** the program's stack segment (scripts/wasm/stack-pass.ts), which its side modules share */
	stackLimits(high: number, low: number): void {
		this.limits = [high, low];
		for (const instance of this.instances.values())
			(
				instance.exports.__gmux_set_stack_limits as
					((h: number, l: number) => void) | undefined
			)?.(high, low);
	}

	private readonly process: DlProcess;

	constructor(process: DlProcess) {
		this.process = process;
	}

	/** the host calls src/gmux/dl.c imports */
	imports(): Record<string, (...args: number[]) => number> {
		const p = this.process;
		const bytes = (at: number, length: number) => new Uint8Array(p.buffer, at, length).slice();
		return {
			__gmux_dlprep: (at, length, info) => {
				const needs = p.prepare(bytes(at, length));
				if (!needs) return -1;
				const view = new DataView(p.buffer);
				view.setUint32(info, needs.memorySize, true);
				view.setUint32(info + 4, needs.memoryAlign, true);
				view.setUint32(info + 8, needs.tableSize, true);
				return 0;
			},
			__gmux_dlopen: (at, length, memoryBase) => this.open(bytes(at, length), memoryBase),
			__gmux_dlsym: (handle, name) => this.symbol(handle, p.readString(name)),
			__gmux_dlclose: (handle) => {
				p.remove(handle);
				this.instances.delete(handle);
				return 0;
			},
			__gmux_dlerror: (at, size) => {
				const text = new TextEncoder()
					.encode(p.lastError())
					.subarray(0, Math.max(0, size - 1));
				new Uint8Array(p.buffer, at, text.length + 1).set([...text, 0]);
				return text.length;
			}
		};
	}

	/** binds the view to its program instance; a thread's instance gets the process's libraries again */
	attach(instance: DlInstance): void {
		this.instance = instance;
		const p = this.process;
		if (!p.libs.length && !p.slots.length) return;
		let need = 0;
		for (const lib of p.libs) need = Math.max(need, lib.tableBase + lib.tableSize);
		for (const slot of p.slots) need = Math.max(need, slot.index + 1);
		if (instance.table.length < need) instance.table.grow(need - instance.table.length);
		this.syncResume();
		// the data is already live and relocated: instantiating again only fills this table
		for (const lib of p.libs) this.instantiate(lib);
		for (const slot of p.slots) this.setSlot(slot.index, slot.owner, slot.name);
	}

	/**
	 * an evacuable program's resume table (experiments/evacuation/scripts/evacuate.ts): slot i holds
	 * the resume variant of the function in slot i of the call table, side modules' slots included
	 */
	private get resume(): WebAssembly.Table | undefined {
		return this.instance!.exports.gmux_resume as WebAssembly.Table | undefined;
	}

	private syncResume(): void {
		const resume = this.resume;
		const length = this.instance!.table.length;
		if (resume && resume.length < length) resume.grow(length - resume.length);
	}

	private setSlot(index: number, owner: number, name: string): void {
		this.instance!.table.set(index, this.function(owner, name));
		const variant = this.function(owner, `${name}$resume`);
		this.resume?.set(index, typeof variant === 'function' ? variant : null);
	}

	private open(bytes: Uint8Array, memoryBase: number): number {
		const p = this.process;
		const table = this.instance!.table;
		const info = p.prepare(bytes);
		if (!info) return -1;
		const lib = p.add(info.hash, memoryBase, table.grow(info.tableSize), info.tableSize);
		this.syncResume();
		try {
			const made = this.instantiate(lib);
			(made.exports.__wasm_apply_data_relocs as (() => void) | undefined)?.();
		} catch (error) {
			p.remove(lib.handle);
			return p.fail(String((error as Error).message ?? error));
		}
		return lib.handle;
	}

	private instantiate(lib: Lib): WebAssembly.Instance {
		const { table, stackPointer, env } = this.instance!;
		const imports: Record<string, Record<string, unknown>> = {
			env: {
				memory: (env as { memory: WebAssembly.Memory }).memory,
				__indirect_function_table: table,
				__stack_pointer: stackPointer,
				__memory_base: new WebAssembly.Global(
					{ value: 'i32', mutable: false },
					lib.memoryBase
				),
				__table_base: new WebAssembly.Global(
					{ value: 'i32', mutable: false },
					lib.tableBase
				),
				__table_base32: new WebAssembly.Global(
					{ value: 'i32', mutable: false },
					lib.tableBase
				)
			},
			'GOT.mem': {},
			'GOT.func': {}
		};
		const late: [WebAssembly.Global, string, 'mem' | 'func'][] = [];
		for (const i of WebAssembly.Module.imports(lib.module)) {
			if (i.module === 'env') {
				if (OWN_IMPORTS.has(i.name)) continue;
				// the host's own calls (syscalls, fuel, stack checks), as the program has them
				if (/^__(gmux|wasm)_/.test(i.name) && i.name in env) {
					imports.env![i.name] = env[i.name];
					continue;
				}
				const found = this.find(i.name, lib.handle);
				// a resume variant of a function that has none: it cannot be on a checkpointed stack
				if (!found && i.kind === 'function' && i.name.endsWith('$resume')) {
					imports.env![i.name] = () => {
						throw new Error(`no resume variant: ${i.name}`);
					};
					continue;
				}
				if (i.kind !== 'function' || !found || typeof found.value !== 'function')
					throw new Error(`undefined symbol: ${i.name}`);
				imports.env![i.name] = found.value;
			} else if (i.module === 'gmux') {
				// an evacuable side module unwinds and resumes with the program's state
				const shared = {
					ckpt: 'gmux_ckpt',
					fp: 'gmux_fp',
					unwinding: 'gmux_unwinding',
					resume: 'gmux_resume',
					resuming: 'gmux_resuming'
				}[i.name];
				const value = shared && this.instance!.exports[shared];
				if (!value)
					throw new Error(
						`unsupported import gmux.${i.name}: the program is not evacuable`
					);
				(imports.gmux ??= {})[i.name] = value;
			} else if (i.module === 'GOT.mem' || i.module === 'GOT.func') {
				const global = new WebAssembly.Global({ value: 'i32', mutable: true }, 0);
				imports[i.module]![i.name] = global;
				late.push([global, i.name, i.module === 'GOT.mem' ? 'mem' : 'func']);
			} else {
				throw new Error(`unsupported import ${i.module}.${i.name}`);
			}
		}
		const instance = new WebAssembly.Instance(lib.module, imports as WebAssembly.Imports);
		this.instances.set(lib.handle, instance);
		if (this.limits)
			(
				instance.exports.__gmux_set_stack_limits as
					((h: number, l: number) => void) | undefined
			)?.(...this.limits);
		// GOT entries: the program's definition first, as ELF interposition would, then the library's own
		for (const [global, name, kind] of late) {
			const data = kind === 'mem';
			const value = this.symbol(0, name, data) || this.symbol(lib.handle, name, data);
			if (!value) throw new Error(`undefined symbol: ${name}`);
			global.value = value;
		}
		return instance;
	}

	/** an export of the program (owner 0) or of the libraries loaded before `before` */
	private find(name: string, before: number): { owner: number; value: unknown } | null {
		if (name in this.instance!.exports)
			return { owner: 0, value: this.instance!.exports[name] };
		for (const lib of this.process.libs) {
			if (lib.handle >= before) break;
			const exports = this.instances.get(lib.handle)?.exports;
			if (exports && name in exports) return { owner: lib.handle, value: exports[name] };
		}
		return null;
	}

	private function(owner: number, name: string): unknown {
		return owner ? this.instances.get(owner)?.exports[name] : this.instance!.exports[name];
	}

	/**
	 * dlsym: a function's table index (a slot added once per symbol) or a data symbol's address;
	 * 0 when `owner` has no such export. `dataOnly` skips functions (GOT.mem)
	 */
	symbol(owner: number, name: string, dataOnly = false): number {
		const p = this.process;
		const value = this.function(owner, name);
		if (value instanceof WebAssembly.Global) return p.address(owner, Number(value.value));
		if (typeof value !== 'function' || dataOnly) return 0;
		const known = p.slots.find((s) => s.owner === owner && s.name === name);
		if (known) return known.index;
		const index = this.instance!.table.grow(1);
		this.syncResume();
		this.setSlot(index, owner, name);
		p.slots.push({ owner, name, index });
		return index;
	}
}
