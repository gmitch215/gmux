export const EFAULT = -14;
export const EINVAL = -22;
export const EMSGSIZE = -90;
export const ENOBUFS = -105;

export const READ = 1;
export const WRITE = 2;

export const SOCKADDR_STORAGE = 128;
export const STATX_BYTES = 256;
export const UIO_MAXIOV = 1024;
/** INT_MAX & PAGE_MASK, at the kernel's 4 KiB pages */
export const MAX_RW_COUNT = 0x7ffff000;
export const IOVEC_BYTES = 8;
export const MSGHDR_BYTES = 28;
export const CMSGHDR_BYTES = 12;

/** a refusal: the negative errno the syscall returns */
export class Refused {
	readonly errno: number;

	constructor(errno: number) {
		this.errno = errno;
	}
}

export const refused = (value: unknown): value is Refused => value instanceof Refused;

export class Span {
	readonly domain: Domain;
	readonly offset: number;
	readonly length: number;
	readonly perm: number;

	constructor(domain: Domain, offset: number, length: number, perm: number) {
		this.domain = domain;
		this.offset = offset;
		this.length = length;
		this.perm = perm;
	}

	/** the domain's bytes here, borrowed: nothing is copied, so the view is good until the memory grows */
	bytes(): Uint8Array {
		return this.domain.bytes().subarray(this.offset, this.offset + this.length);
	}

	view(): DataView {
		return new DataView(this.domain.memory.buffer, this.offset, this.length);
	}
}

/**
 * The WebAssembly memory a process's bytes live in. The host reaches it through a `Span` (offset,
 * length and permission, checked once against the domain's size with no 32-bit wrap) or a marshaler
 * below, which fail as Linux fails the same call: `EFAULT` for a buffer outside the domain,
 * `EINVAL` for a length Linux refuses. Layouts are wasm32's. `perm` is what the host may do in the
 * domain at all; a read-only domain refuses WRITE spans.
 */
export class Domain {
	private held: Uint8Array | null = null;

	readonly memory: WebAssembly.Memory;
	readonly perm: number;
	/** copies between the kernel's memory and this one, when the domain was made with the kernel's */
	readonly copier: Copier | null;

	constructor(memory: WebAssembly.Memory, perm = READ | WRITE, kernel?: WebAssembly.Memory) {
		this.memory = memory;
		this.perm = perm;
		this.copier = kernel ? makeCopier(kernel, memory) : null;
	}

	/** whether the span is inside the domain and allowed, with no 32-bit wrap */
	holds(offset: number, length: number, perm = READ): boolean {
		return (perm & ~this.perm) === 0 && (offset >>> 0) + (length >>> 0) <= this.size;
	}

	/** the whole memory as bytes, the view kept until the memory grows */
	bytes(): Uint8Array {
		const buffer = this.memory.buffer;
		const held = this.held;
		if (held && held.buffer === buffer) return held;
		return (this.held = new Uint8Array(buffer));
	}

	get size(): number {
		return this.bytes().length;
	}

	/** the span, or null when it leaves the domain or asks for a permission the domain lacks */
	span(offset: number, length: number, perm = READ): Span | null {
		if (!this.holds(offset, length, perm)) return null;
		return new Span(this, offset >>> 0, length >>> 0, perm);
	}
}

/** the exports of the copy module: bulk copies between the kernel's memory (0) and a domain's (1) */
export interface Copier {
	in(kernel: number, user: number, n: number): void;
	out(kernel: number, user: number, n: number): void;
	zero(user: number, n: number): void;
}

// the two memories are imported shared with the widest limits, which any machine memory fits
function copierBytes(): Uint8Array {
	const leb = (n: number) => (n < 128 ? [n] : [(n & 0x7f) | 0x80, n >> 7]);
	const text = (s: string) => [s.length, ...Array.from(s, (c) => c.charCodeAt(0))];
	const section = (id: number, body: number[]) => [id, ...leb(body.length), ...body];
	const memory = (name: string) => [...text('env'), ...text(name), 2, 3, 0, 0x80, 0x80, 4];
	const get = (...locals: number[]) => locals.flatMap((i) => [0x20, i]);
	const func = (body: number[]) => [...leb(body.length + 2), 0, ...body, 0x0b];
	const types = [
		[0x60, 3, 0x7f, 0x7f, 0x7f, 0],
		[0x60, 2, 0x7f, 0x7f, 0]
	];
	return new Uint8Array([
		...[0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00],
		...section(1, [types.length, ...types.flat()]),
		...section(2, [2, ...memory('kernel'), ...memory('user')]),
		...section(3, [3, 0, 0, 1]),
		...section(7, [3, ...text('in'), 0, 0, ...text('out'), 0, 1, ...text('zero'), 0, 2]),
		...section(10, [
			3,
			// memory.copy dst src, then memory.fill
			...func([...get(0, 1, 2), 0xfc, 0x0a, 0, 1]),
			...func([...get(1, 0, 2), 0xfc, 0x0a, 1, 0]),
			...func([...get(0), 0x41, 0, ...get(1), 0xfc, 0x0b, 1])
		])
	]);
}

// workers-types declare Module abstract; the constructor is real at startup
const Module = WebAssembly.Module as unknown as new (bytes: BufferSource) => WebAssembly.Module;
// a host that cannot compile it (or link two shared memories) copies through views instead
const COPIER = (() => {
	try {
		return new Module(copierBytes());
	} catch {
		return null;
	}
})();

/** the same copies through typed arrays, slower than the module's */
export function jsCopier(kernel: WebAssembly.Memory, user: WebAssembly.Memory): Copier {
	const bytes = (m: WebAssembly.Memory) => new Uint8Array(m.buffer);
	return {
		in: (k, u, n) => bytes(kernel).set(bytes(user).subarray(u, u + n), k),
		out: (k, u, n) => bytes(user).set(bytes(kernel).subarray(k, k + n), u),
		zero: (u, n) => bytes(user).fill(0, u, u + n)
	};
}

function makeCopier(kernel: WebAssembly.Memory, user: WebAssembly.Memory): Copier {
	if (COPIER) {
		try {
			const env = { kernel, user };
			return new WebAssembly.Instance(COPIER, { env }).exports as unknown as Copier;
		} catch {}
	}
	return jsCopier(kernel, user);
}

const word = (view: DataView, at: number) => view.getUint32(at, true);

// #region crossings

/** a kernel buffer's bytes from a domain, as raw_copy_from_user: the count not copied */
export function copyIn(user: Domain, k: number, u: number, n: number): number {
	if (!user.holds(u, n, READ)) return n >>> 0;
	user.copier!.in(k, u, n);
	return 0;
}

/** a kernel buffer's bytes into a domain, as raw_copy_to_user */
export function copyOut(user: Domain, k: number, u: number, n: number): number {
	if (!user.holds(u, n, WRITE)) return n >>> 0;
	user.copier!.out(k, u, n);
	return 0;
}

/** zeroes a span of a domain, as __clear_user */
export function clear(user: Domain, u: number, n: number): number {
	if (!user.holds(u, n, WRITE)) return n >>> 0;
	user.copier!.zero(u, n);
	return 0;
}

/**
 * what `strncpy_from_user` and `strnlen_user` find in a domain: the index of the first NUL within
 * `count` bytes, `count` when there is none, or -1 when the domain ends before either
 */
export function stringLength(domain: Domain, u: number, count: number): number {
	if (!(domain.perm & READ)) return -1;
	const bytes = domain.bytes();
	const at = u >>> 0;
	const limit = count >>> 0;
	const end = at + Math.min(limit, Math.max(0, bytes.length - at));
	// a path is short, and subarray() allocates: the first 64 bytes by hand
	const head = Math.min(end, at + 64);
	for (let i = at; i < head; i++) if (bytes[i] === 0) return i - at;
	if (head < end) {
		const nul = bytes.subarray(head, end).indexOf(0);
		if (nul >= 0) return head - at + nul;
	}
	return end - at === limit ? limit : -1;
}

// #endregion

// #region marshalers

/** `put_statx`: the 256 bytes the kernel built, into the domain */
export function putStatx(domain: Domain, ptr: number, statx: Uint8Array): number {
	if (statx.length !== STATX_BYTES) return EINVAL;
	const span = domain.span(ptr, STATX_BYTES, WRITE);
	if (!span) return EFAULT;
	span.bytes().set(statx);
	return 0;
}

/** `move_addr_to_kernel`: a socket address of `len` bytes, copied */
export function getSockaddr(domain: Domain, ptr: number, len: number): Uint8Array | Refused {
	const n = len | 0;
	if (n < 0 || n > SOCKADDR_STORAGE) return new Refused(EINVAL);
	if (n === 0) return new Uint8Array(0);
	const span = domain.span(ptr, n, READ);
	return span ? span.bytes().slice() : new Refused(EFAULT);
}

/**
 * `move_addr_to_user`: the length at `lenPtr` is the room the caller has; it is overwritten with the
 * address's true length, and the address is cut to the room
 */
export function putSockaddr(
	domain: Domain,
	ptr: number,
	lenPtr: number,
	kaddr: Uint8Array
): number {
	const field = domain.span(lenPtr, 4, READ | WRITE);
	if (!field) return EFAULT;
	const view = field.view();
	let len = view.getInt32(0, true);
	if (len > kaddr.length) len = kaddr.length;
	if (len >= 0) view.setInt32(0, kaddr.length, true);
	if (len === 0) return 0;
	if (len < 0) return EINVAL;
	const span = domain.span(ptr, len, WRITE);
	if (!span) return EFAULT;
	span.bytes().set(kaddr.subarray(0, len));
	return 0;
}

export interface Iovecs {
	segments: Span[];
	total: number;
}

/**
 * `import_iovec`: the array's entries as spans, each checked against the domain for `perm` (READ for
 * writev and sendmsg, WRITE for readv and recvmsg). Entries may overlap, as they may on Linux; a
 * total past MAX_RW_COUNT is cut there
 */
export function getIovecs(
	domain: Domain,
	ptr: number,
	count: number,
	perm: number
): Iovecs | Refused {
	const n = count >>> 0;
	if (n === 0) return { segments: [], total: 0 };
	if (n > UIO_MAXIOV) return new Refused(EINVAL);
	const array = domain.span(ptr, n * IOVEC_BYTES, READ);
	if (!array) return new Refused(EFAULT);
	const view = array.view();
	const entries: [number, number][] = [];
	for (let i = 0; i < n; i++) {
		const len = view.getInt32(i * IOVEC_BYTES + 4, true);
		if (len < 0) return new Refused(EINVAL);
		entries.push([word(view, i * IOVEC_BYTES), len]);
	}
	if (n === 1) {
		const [base, len] = entries[0]!;
		const cut = Math.min(len, MAX_RW_COUNT);
		const span = domain.span(base, cut, perm);
		return span ? { segments: [span], total: cut } : new Refused(EFAULT);
	}
	const segments: Span[] = [];
	let total = 0;
	for (const [base, len] of entries) {
		if (!domain.span(base, len, perm)) return new Refused(EFAULT);
		const cut = Math.min(len, MAX_RW_COUNT - total);
		segments.push(domain.span(base, cut, perm)!);
		total += cut;
	}
	return { segments, total };
}

export interface Msghdr {
	/** the destination address, copied (sendmsg), or where the source address goes (recvmsg) */
	name: Uint8Array | { offset: number; length: number } | null;
	iov: Iovecs;
	/** the control data, copied and framed (sendmsg), or the room for it (recvmsg), not yet checked */
	control: Uint8Array | { offset: number; length: number } | null;
	flags: number;
}

/**
 * the checks `copy_msghdr_from_user` and `____sys_sendmsg` make on a `msghdr` at `ptr`. `send`
 * copies the name and control data in; a receive keeps both as room, which Linux touches only when
 * a message brings an address or control data, so the caller takes a span then
 */
export function getMsghdr(domain: Domain, ptr: number, send: boolean): Msghdr | Refused {
	const head = domain.span(ptr, MSGHDR_BYTES, READ);
	if (!head) return new Refused(EFAULT);
	const view = head.view();
	const [name, namelen, iov, iovlen, control, controllen, flags] = [0, 4, 8, 12, 16, 20, 24].map(
		(at) => word(view, at)
	) as [number, number, number, number, number, number, number];
	let nameLen = name ? namelen | 0 : 0;
	if (nameLen < 0) return new Refused(EINVAL);
	if (nameLen > SOCKADDR_STORAGE) nameLen = SOCKADDR_STORAGE;
	let kname: Msghdr['name'] = null;
	if (name && nameLen) {
		if (send) {
			const copy = getSockaddr(domain, name, nameLen);
			if (refused(copy)) return copy;
			kname = copy;
		} else kname = { offset: name, length: nameLen };
	}
	if (iovlen > UIO_MAXIOV) return new Refused(EMSGSIZE);
	const iovecs = getIovecs(domain, iov, iovlen, send ? READ : WRITE);
	if (refused(iovecs)) return iovecs;
	let kcontrol: Msghdr['control'] = null;
	if (send) {
		if (controllen > 0x7fffffff) return new Refused(ENOBUFS);
		if (controllen) {
			const span = domain.span(control, controllen, READ);
			if (!span) return new Refused(EFAULT);
			kcontrol = span.bytes().slice();
			const bad = cmsgFraming(kcontrol);
			if (bad) return bad;
		}
	} else if (controllen) kcontrol = { offset: control, length: controllen };
	return { name: kname, iov: iovecs, control: kcontrol, flags: flags | 0 };
}

/** `for_each_cmsghdr` with `CMSG_OK`: every header's length must fit what is left of the buffer */
function cmsgFraming(control: Uint8Array): Refused | null {
	const view = new DataView(control.buffer, control.byteOffset, control.length);
	let at = 0;
	if (control.length < CMSGHDR_BYTES) return null;
	for (;;) {
		const len = view.getUint32(at, true);
		if (len < CMSGHDR_BYTES || len > control.length - at) return new Refused(EINVAL);
		const next = at + ((len + 3) & ~3);
		if (next + CMSGHDR_BYTES > control.length) return null;
		at = next;
	}
}

// #endregion
