/**
 * The syscall router a program calls instead of the kernel when the host watches file syncs: one
 * function per syscall arity, `s0` to `s6`, each `(sp, tls, nr, args...) -> i32` like the kernel's
 * `wasm_syscall_N`. By the imported global `route`, a call goes to the kernel (1) or to the host hook
 * (2). At 0 the syncs (fsync, fdatasync, sync_file_range, msync, sync, syncfs, pwritev2) and an
 * openat with O_DSYNC go to the hook and everything else to the kernel; 3 adds the write family,
 * once a program has opened a file for synchronous writes. The kernel is reached by a tail call, so
 * a checkpoint's unwind and rewind never see a router frame.
 *
 * With the imported global `cache` set, a statx at 0 or 3 first asks the plain import `c.5`, which
 * answers from the host's path-query cache or returns `MISS`; a miss goes to the hook, which asks
 * the kernel and fills the cache.
 *
 * Compiled once here: a Worker may compile wasm at startup and not while it serves a request.
 */
export const ROUTE_WATCH = 0;
export const ROUTE_KERNEL = 1;
export const ROUTE_HOOK = 2;
export const ROUTE_WRITES = 3;

/** syscalls the hook takes at ROUTE_WATCH and ROUTE_WRITES */
export const SYNC_CALLS = [81, 82, 83, 84, 227, 267, 287];
/** and at ROUTE_WRITES: write, writev, pwrite64, pwritev, sendfile, splice, copy_file_range */
export const WRITE_CALLS = [64, 66, 68, 70, 71, 76, 285];
const SYS_OPENAT = 56;
const O_DSYNC = 0o10000;
export const SYS_STATX = 291;
/** what `c.5` returns when it has no answer: statx returns 0 or a negative errno */
export const MISS = 1;

function leb(n: number): number[] {
	const out: number[] = [];
	do {
		let b = n & 0x7f;
		n >>>= 7;
		if (n) b |= 0x80;
		out.push(b);
	} while (n);
	return out;
}

// i32.const takes a signed LEB: 82 is 0xd2 0x00, since a lone 0x52 reads as negative
function sleb(n: number): number[] {
	const out: number[] = [];
	for (;;) {
		const b = n & 0x7f;
		n >>= 7;
		if ((n === 0 && !(b & 0x40)) || (n === -1 && b & 0x40)) return [...out, b];
		out.push(b | 0x80);
	}
}

const text = (s: string) => [...leb(s.length), ...Array.from(s, (c) => c.charCodeAt(0))];
const vec = (items: number[][]) => [...leb(items.length), ...items.flat()];
const section = (id: number, body: number[]) => [id, ...leb(body.length), ...body];

// opcodes
const I32 = 0x7f;
const GLOBAL_GET = 0x23;
const LOCAL_GET = 0x20;
const I32_CONST = 0x41;
const I32_EQ = 0x46;
const I32_EQZ = 0x45;
const LOCAL_TEE = 0x22;
const I32_NE = 0x47;
const I32_AND = 0x71;
const I32_OR = 0x72;
const IF = 0x04;
const VOID = 0x40;
const END = 0x0b;
const CALL = 0x10;
const RETURN_CALL = 0x12;
const RETURN = 0x0f;

function routerBytes(): Uint8Array {
	const arities = [0, 1, 2, 3, 4, 5, 6];
	const types = arities.map((n) => [
		0x60,
		...vec(Array.from({ length: 3 + n }, () => [I32])),
		1,
		I32
	]);
	const imports = arities.flatMap((n) => [
		[...text('k'), ...text(String(n)), 0, n],
		[...text('h'), ...text(String(n)), 0, n]
	]);
	imports.push([...text('c'), ...text('5'), 0, 5]);
	imports.push([...text('m'), ...text('route'), 3, I32, 1]);
	imports.push([...text('m'), ...text('cache'), 3, I32, 0]);
	const kernel = (n: number) => 2 * n;
	const hook = (n: number) => 2 * n + 1;
	const cached = 14;
	const args = (n: number) => Array.from({ length: 3 + n }, (_, i) => [LOCAL_GET, i]).flat();
	const is = (value: number) => [GLOBAL_GET, 0, I32_CONST, ...sleb(value), I32_EQ];
	// nr is local 2; each test leaves 0 or 1
	const nrIs = (nr: number) => [LOCAL_GET, 2, I32_CONST, ...sleb(nr), I32_EQ];
	const anyOf = (nrs: number[]) => nrs.flatMap((nr, i) => [...nrIs(nr), ...(i ? [I32_OR] : [])]);
	const bodies = arities.map((n) => {
		const hookIf = [
			...is(ROUTE_HOOK),
			...anyOf(SYNC_CALLS),
			I32_OR,
			// openat's flags are its third argument, local 5
			...(n >= 3
				? [
						...nrIs(SYS_OPENAT),
						LOCAL_GET,
						5,
						I32_CONST,
						...sleb(O_DSYNC),
						I32_AND,
						I32_CONST,
						0,
						I32_NE,
						I32_AND,
						I32_OR
					]
				: []),
			...is(ROUTE_WRITES),
			...anyOf(WRITE_CALLS),
			I32_AND,
			I32_OR
		];
		// statx's cache: a hit returns at once, a miss fills through the hook; the result is local 8
		const statx =
			n === 5
				? [
						GLOBAL_GET,
						1,
						...nrIs(SYS_STATX),
						I32_AND,
						...is(ROUTE_HOOK),
						I32_EQZ,
						I32_AND,
						IF,
						VOID,
						...args(n),
						CALL,
						cached,
						LOCAL_TEE,
						8,
						I32_CONST,
						...sleb(MISS),
						I32_NE,
						IF,
						VOID,
						LOCAL_GET,
						8,
						RETURN,
						END,
						...args(n),
						CALL,
						hook(n),
						RETURN,
						END
					]
				: [];
		const code = [
			...is(ROUTE_KERNEL),
			IF,
			VOID,
			...args(n),
			RETURN_CALL,
			kernel(n),
			END,
			...statx,
			...hookIf,
			IF,
			VOID,
			...args(n),
			CALL,
			hook(n),
			RETURN,
			END,
			...args(n),
			RETURN_CALL,
			kernel(n),
			END
		];
		const locals = n === 5 ? [1, 1, I32] : [0];
		const body = [...locals, ...code];
		return [...leb(body.length), ...body];
	});
	const functions = arities.map((n) => leb(n));
	const exports = arities.map((n) => [...text(`s${n}`), 0, ...leb(15 + n)]);
	return new Uint8Array([
		0x00,
		0x61,
		0x73,
		0x6d,
		0x01,
		0x00,
		0x00,
		0x00,
		...section(1, vec(types)),
		...section(2, vec(imports)),
		...section(3, vec(functions)),
		...section(7, vec(exports)),
		...section(10, vec(bodies))
	]);
}

// workers-types declare Module abstract; the constructor is real at startup
const Module = WebAssembly.Module as unknown as new (bytes: BufferSource) => WebAssembly.Module;
export const ROUTER = new Module(routerBytes());
