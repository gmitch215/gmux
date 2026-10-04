/**
 * The syscall router a program calls instead of the kernel when the host watches file syncs: one
 * function per syscall arity, `s0` to `s6`, each `(sp, tls, nr, args...) -> i32` like the kernel's
 * `wasm_syscall_N`. By the imported global `route`, a call goes to the kernel (1) or to the host hook
 * (2). At 0 the syncs (fsync, fdatasync, sync_file_range, msync, sync, syncfs, pwritev2) and an
 * openat with O_DSYNC go to the hook and everything else to the kernel; 3 adds the write family,
 * once a program has opened a file for synchronous writes. The kernel is reached by a tail call, so
 * a checkpoint's unwind and rewind never see a router frame.
 *
 * With the imported global `cache` set, a statx at 0 or 3 first asks the import `c.5`, which answers
 * from the path-query table or returns `MISS`; a miss goes to the hook, which asks the kernel and
 * fills the table.
 *
 * The router is `src/gmux/core/router/router.c`; the statx hit, which needs three memories, is
 * `statx.wat` beside it. `scripts/build-router.sh` builds both, and a Worker may compile wasm at
 * startup and not while it serves a request, so the host compiles them once and hands them to the
 * machine as `MachineOptions.router`.
 */
export const ROUTE_WATCH = 0;
export const ROUTE_KERNEL = 1;
export const ROUTE_HOOK = 2;
export const ROUTE_WRITES = 3;

/** syscalls the hook takes at ROUTE_WATCH and ROUTE_WRITES */
export const SYNC_CALLS = [81, 82, 83, 84, 227, 267, 287];
/** and at ROUTE_WRITES: write, writev, pwrite64, pwritev, sendfile, splice, copy_file_range */
export const WRITE_CALLS = [64, 66, 68, 70, 71, 76, 285];
export const SYS_STATX = 291;
/** what `c.5` returns when it has no answer: statx returns 0 or a negative errno */
export const MISS = 1;

/** the compiled router and statx-hit modules (build/router) */
export interface RouterModules {
	route: WebAssembly.Module;
	statx: WebAssembly.Module;
}

// workers-types declare Module abstract; the constructor is real at startup
const Module = WebAssembly.Module as unknown as new (bytes: BufferSource) => WebAssembly.Module;

export function compileRouter(route: BufferSource, statx: BufferSource): RouterModules {
	return { route: new Module(route), statx: new Module(statx) };
}

/**
 * a statx the kernel answered, and what it holds for. With no `guards` it holds while the kernel's
 * generation is `gen`; else while the count of mount and chroot changes is `gen` and each counter
 * `[index, value]` is still at its value (kernel patch 0029: one counter per inode-number bucket)
 */
export interface StatxAnswer {
	view: number;
	flags: number;
	mask: number;
	path: Uint8Array;
	gen: number;
	guards?: [number, number][];
	ret: number;
	bytes: Uint8Array | null;
}

const SLOT = 512;
/** statx.wat's table: a header slot, then this many sets of two slots, a hash picking the set */
export const STATX_SETS = 2048;
/** the kernel counters an answer can be guarded by (patch 0029's WASM_FS_BUCKETS) */
export const STATX_BUCKETS = 4096;
/** the most counters one answer holds on */
export const STATX_GUARDS = 8;
/** the longest path a slot holds */
export const STATX_PATH_MAX = 170;
const GUARD_AT = 288;
const PATH_AT = 340;
const BYTES_AT = 32;

/** the counter of an inode number, as the kernel's wasm_fs_bucket picks it */
export function statxBucket(ino: number): number {
	return Math.imul(ino, 0x9e3779b1) >>> 20;
}
const PAGES = Math.ceil(((2 * STATX_SETS + 1) * SLOT) / 0x10000);

/**
 * the memory statx.wat answers from, one slot per cache key; a key lands in the set its hash picks
 * and replaces its own older answer, else an empty slot, else the slot of the older generation. The
 * host fills it; the hit path reads it and counts hits and misses in its header
 */
export class StatxTable {
	readonly memory = new WebAssembly.Memory({ initial: PAGES });
	private view = new DataView(this.memory.buffer);

	constructor(verify: boolean) {
		this.view.setUint32(8, verify ? 1 : 0, true);
	}

	get hits(): number {
		return this.view.getUint32(0, true);
	}

	set hits(count: number) {
		this.view.setUint32(0, count, true);
	}

	get misses(): number {
		return this.view.getUint32(4, true);
	}

	set misses(count: number) {
		this.view.setUint32(4, count, true);
	}

	/** the offsets of a hash's two slots */
	private slots(hash: number): [number, number] {
		const first = ((hash & (STATX_SETS - 1)) * 2 + 1) * SLOT;
		return [first, first + SLOT];
	}

	/** the slot holding this hash, or -1 */
	private find(hash: number): number {
		for (const at of this.slots(hash))
			if (this.view.getUint32(at + 24, true) && this.view.getUint32(at, true) === hash >>> 0)
				return at;
		return -1;
	}

	get(hash: number): StatxAnswer | undefined {
		const at = this.find(hash);
		if (at < 0) return undefined;
		const length = this.view.getUint32(at + 24, true);
		const bytes = new Uint8Array(this.memory.buffer);
		const guards: [number, number][] = [];
		for (let i = 0; i < this.view.getUint32(at + GUARD_AT, true); i++)
			guards.push([
				this.view.getUint16(at + GUARD_AT + 4 + i * 2, true),
				this.view.getUint32(at + GUARD_AT + 20 + i * 4, true)
			]);
		return {
			view: this.view.getUint32(at + 4, true),
			flags: this.view.getInt32(at + 8, true),
			mask: this.view.getInt32(at + 12, true),
			gen: this.view.getUint32(at + 16, true),
			guards,
			ret: this.view.getInt32(at + 20, true),
			path: bytes.slice(at + PATH_AT, at + PATH_AT + length),
			bytes: this.view.getUint32(at + 28, true)
				? bytes.slice(at + BYTES_AT, at + BYTES_AT + 256)
				: null
		};
	}

	/** false when the path is too long for a slot: the kernel keeps answering it */
	set(hash: number, answer: StatxAnswer): boolean {
		const guards = answer.guards ?? [];
		if (answer.path.length > STATX_PATH_MAX || guards.length > STATX_GUARDS) return false;
		const [a, b] = this.slots(hash);
		const empty = [a, b].find((slot) => !this.view.getUint32(slot + 24, true));
		const older =
			this.view.getUint32(a + 16, true) <= this.view.getUint32(b + 16, true) ? a : b;
		const found = this.find(hash);
		const at = found >= 0 ? found : (empty ?? older);
		const bytes = new Uint8Array(this.memory.buffer);
		this.view.setUint32(at + 24, 0, true);
		this.view.setUint32(at, hash, true);
		this.view.setUint32(at + 4, answer.view, true);
		this.view.setInt32(at + 8, answer.flags, true);
		this.view.setInt32(at + 12, answer.mask, true);
		this.view.setUint32(at + 16, answer.gen, true);
		this.view.setInt32(at + 20, answer.ret, true);
		this.view.setUint32(at + 28, answer.bytes ? 1 : 0, true);
		this.view.setUint32(at + GUARD_AT, guards.length, true);
		guards.forEach(([index, value], i) => {
			this.view.setUint16(at + GUARD_AT + 4 + i * 2, index, true);
			this.view.setUint32(at + GUARD_AT + 20 + i * 4, value, true);
		});
		if (answer.bytes) bytes.set(answer.bytes.subarray(0, 256), at + BYTES_AT);
		bytes.set(answer.path, at + PATH_AT);
		bytes[at + PATH_AT + answer.path.length] = 0;
		this.view.setUint32(at + 24, answer.path.length, true);
		return true;
	}
}
