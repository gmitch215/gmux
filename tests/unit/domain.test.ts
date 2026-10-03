import { describe, expect, it } from 'vitest';
import {
	Domain,
	EFAULT,
	EINVAL,
	EMSGSIZE,
	ENOBUFS,
	MAX_RW_COUNT,
	READ,
	Refused,
	WRITE,
	clear,
	copyIn,
	copyOut,
	getIovecs,
	getMsghdr,
	getSockaddr,
	jsCopier,
	putSockaddr,
	putStatx,
	refused
} from '../../src/worker/machine/domain.ts';

const PAGE = 0x10000;
// shared, as every memory of a machine is
const memory = () => new WebAssembly.Memory({ initial: 2, maximum: 4, shared: true });
const kernelMemory = memory();
const kernel = new Uint8Array(kernelMemory.buffer);

/** a domain of two pages and a writer for little-endian words */
function rig() {
	const domain = new Domain(memory(), READ | WRITE, kernelMemory);
	const view = new DataView(domain.memory.buffer);
	const put = (at: number, ...words: number[]) =>
		words.forEach((w, i) => view.setUint32(at + 4 * i, w >>> 0, true));
	return { domain, view, put, bytes: domain.bytes() };
}

const errno = (r: unknown) => (refused(r) ? r.errno : r);

describe('spans', () => {
	it('checks offset and length once, with no 32-bit wrap', () => {
		const { domain } = rig();
		const size = 2 * PAGE;
		expect(domain.span(0, size)?.length).toBe(size);
		expect(domain.span(size, 0)?.length).toBe(0);
		expect(domain.span(size, 1)).toBeNull();
		expect(domain.span(size - 4, 5)).toBeNull();
		// 0xfffffff0 + 0x20 wraps to 0x10 in 32 bits, which is inside the memory
		expect(domain.span(0xfffffff0, 0x20)).toBeNull();
		expect(domain.span(-16, 0x20)).toBeNull();
	});

	it('refuses a permission the domain lacks', () => {
		const read = new Domain(memory(), READ);
		expect(read.span(0, 4, READ)).not.toBeNull();
		expect(read.span(0, 4, WRITE)).toBeNull();
		expect(read.span(0, 4, READ | WRITE)).toBeNull();
	});

	it('lends bytes in place, with nothing copied', () => {
		const { domain, bytes } = rig();
		const span = domain.span(100, 8, WRITE)!;
		span.bytes().fill(7);
		expect(bytes.subarray(98, 110)).toEqual(
			new Uint8Array([0, 0, 7, 7, 7, 7, 7, 7, 7, 7, 0, 0])
		);
		expect(span.bytes().buffer).toBe(bytes.buffer);
	});

	it('follows the memory when it grows', () => {
		const { domain } = rig();
		expect(domain.span(2 * PAGE, 1)).toBeNull();
		domain.memory.grow(1);
		expect(domain.span(2 * PAGE, 1)?.length).toBe(1);
		expect(domain.size).toBe(3 * PAGE);
	});
});

describe('crossings', () => {
	it('copy in, out and zero, and report the count they could not reach', () => {
		const { domain, bytes } = rig();
		kernel.set(
			Array.from({ length: 4096 }, (_, i) => i),
			1024
		);
		for (const n of [0, 1, 8, 31, 32, 4096]) {
			bytes.fill(0);
			expect(copyOut(domain, 1024, 64, n)).toBe(0);
			expect(bytes.subarray(64, 64 + n)).toEqual(kernel.subarray(1024, 1024 + n));
			expect(bytes[64 + n]).toBe(0);
			kernel.fill(0, 8192, 8192 + 4096);
			expect(copyIn(domain, 8192, 64, n)).toBe(0);
			expect(kernel.subarray(8192, 8192 + n)).toEqual(bytes.subarray(64, 64 + n));
			expect(kernel[8192 + n]).toBe(0);
			expect(clear(domain, 64, n)).toBe(0);
			expect(bytes.subarray(64, 64 + n).every((b) => b === 0)).toBe(true);
		}
	});

	it('refuse a span past the memory without touching it', () => {
		const { domain, bytes } = rig();
		kernel.fill(9, 0, 64);
		const size = 2 * PAGE;
		expect(copyOut(domain, 0, size - 8, 16)).toBe(16);
		expect(copyIn(domain, 0, size - 8, 16)).toBe(16);
		expect(clear(domain, size - 8, 16)).toBe(16);
		expect(bytes.subarray(size - 8).every((b) => b === 0)).toBe(true);
		expect(kernel.subarray(0, 64).every((b) => b === 9)).toBe(true);
		// a length that wraps in 32 bits
		expect(copyOut(domain, 0, 0xfffffff8, 16)).toBe(16);
		expect(copyIn(domain, 0, 0xfffffff8, 16)).toBe(16);
	});

	it('fall back to views when the copy module cannot link the memories', () => {
		// the module imports shared memories; a plain one does not link
		const plain = new WebAssembly.Memory({ initial: 2, maximum: 4 });
		const domain = new Domain(plain, READ | WRITE, kernelMemory);
		kernel.fill(7, 0x300, 0x310);
		expect(copyOut(domain, 0x300, 100, 16)).toBe(0);
		expect(new Uint8Array(plain.buffer, 100, 16).every((b) => b === 7)).toBe(true);
		expect(copyIn(domain, 0x400, 100, 16)).toBe(0);
		expect(kernel.subarray(0x400, 0x410).every((b) => b === 7)).toBe(true);
		expect(clear(domain, 100, 16)).toBe(0);
		expect(new Uint8Array(plain.buffer, 100, 16).every((b) => b === 0)).toBe(true);
	});

	it('copy the same through views as through the module', () => {
		const a = rig();
		const b = new Domain(memory(), READ | WRITE);
		const js = jsCopier(kernelMemory, b.memory);
		kernel.set(
			Array.from({ length: 300 }, (_, i) => i),
			0x800
		);
		a.domain.copier!.out(0x800, 50, 300);
		js.out(0x800, 50, 300);
		expect(b.bytes().subarray(50, 350)).toEqual(a.bytes.subarray(50, 350));
		a.domain.copier!.zero(60, 10);
		js.zero(60, 10);
		expect(b.bytes().subarray(0, 400)).toEqual(a.bytes.subarray(0, 400));
		a.domain.copier!.in(0x900, 50, 300);
		const viaModule = kernel.slice(0x900, 0xa2c);
		js.in(0x900, 50, 300);
		expect(kernel.slice(0x900, 0xa2c)).toEqual(viaModule);
	});

	it('refuse a write into a read-only domain', () => {
		const domain = new Domain(memory(), READ, kernelMemory);
		expect(copyOut(domain, 0, 0, 8)).toBe(8);
		expect(clear(domain, 0, 8)).toBe(8);
		expect(copyIn(domain, 0, 0, 8)).toBe(0);
	});
});

describe('statx', () => {
	it('is put whole or refused with EFAULT', () => {
		const { domain, bytes } = rig();
		const statx = new Uint8Array(256).fill(3);
		expect(putStatx(domain, 512, statx)).toBe(0);
		expect(bytes.subarray(512, 768)).toEqual(statx);
		expect(putStatx(domain, 2 * PAGE - 255, statx)).toBe(EFAULT);
		expect(putStatx(domain, 0xffffff80, statx)).toBe(EFAULT);
		expect(bytes[2 * PAGE - 1]).toBe(0);
	});

	it('is 256 bytes', () => {
		expect(putStatx(rig().domain, 0, new Uint8Array(255))).toBe(EINVAL);
	});
});

describe('sockaddr', () => {
	it('is copied for a length up to 128, and a zero length reads nothing', () => {
		const { domain, bytes } = rig();
		bytes.set([2, 0, 0x1f, 0x90, 127, 0, 0, 1], 200);
		expect(getSockaddr(domain, 200, 8)).toEqual(
			new Uint8Array([2, 0, 0x1f, 0x90, 127, 0, 0, 1])
		);
		expect(getSockaddr(domain, 0xffffffff, 0)).toEqual(new Uint8Array(0));
		expect(errno(getSockaddr(domain, 200, 128))).not.toBe(EINVAL);
	});

	it('refuses a negative or overlong length with EINVAL and a span outside with EFAULT', () => {
		const { domain } = rig();
		expect(errno(getSockaddr(domain, 200, -1))).toBe(EINVAL);
		expect(errno(getSockaddr(domain, 200, 129))).toBe(EINVAL);
		expect(errno(getSockaddr(domain, 200, 0x80000000))).toBe(EINVAL);
		expect(errno(getSockaddr(domain, 2 * PAGE - 4, 16))).toBe(EFAULT);
		expect(errno(getSockaddr(domain, 0xfffffff8, 16))).toBe(EFAULT);
	});

	it('is put cut to the room, with the true length written back', () => {
		const { domain, bytes, view, put } = rig();
		const kaddr = new Uint8Array([2, 0, 1, 2, 3, 4, 5, 6]);
		put(300, 4);
		expect(putSockaddr(domain, 400, 300, kaddr)).toBe(0);
		expect(view.getInt32(300, true)).toBe(8);
		expect(bytes.subarray(400, 405)).toEqual(new Uint8Array([2, 0, 1, 2, 0]));
		put(300, 100);
		expect(putSockaddr(domain, 400, 300, kaddr)).toBe(0);
		expect(bytes.subarray(400, 408)).toEqual(kaddr);
	});

	it('refuses a negative room with EINVAL and a length field or buffer outside with EFAULT', () => {
		const { domain, view, put } = rig();
		const kaddr = new Uint8Array(8);
		put(300, -1);
		expect(putSockaddr(domain, 400, 300, kaddr)).toBe(EINVAL);
		// a negative room is left as it was: Linux writes the length back only when it is >= 0
		expect(view.getInt32(300, true)).toBe(-1);
		expect(putSockaddr(domain, 400, 2 * PAGE - 2, kaddr)).toBe(EFAULT);
		put(300, 8);
		expect(putSockaddr(domain, 2 * PAGE - 4, 300, kaddr)).toBe(EFAULT);
	});
});

describe('iovec', () => {
	const iov = (put: (at: number, ...w: number[]) => void, at: number, entries: number[][]) =>
		entries.forEach(([base, len], i) => put(at + 8 * i, base!, len!));

	it('gives each entry as a span and the total', () => {
		const { domain, put } = rig();
		iov(put, 1000, [
			[2000, 10],
			[3000, 0],
			[4000, 5]
		]);
		const r = getIovecs(domain, 1000, 3, READ) as Exclude<
			ReturnType<typeof getIovecs>,
			Refused
		>;
		expect(r.total).toBe(15);
		expect(r.segments.map((s) => [s.offset, s.length])).toEqual([
			[2000, 10],
			[3000, 0],
			[4000, 5]
		]);
	});

	it('takes entries that overlap, as Linux does, in order', () => {
		const { domain, bytes, put } = rig();
		iov(put, 1000, [
			[2000, 8],
			[2004, 8]
		]);
		const r = getIovecs(domain, 1000, 2, WRITE);
		expect(refused(r)).toBe(false);
		if (refused(r)) return;
		r.segments[0]!.bytes().fill(1);
		r.segments[1]!.bytes().fill(2);
		expect(bytes.subarray(2000, 2012)).toEqual(
			new Uint8Array([1, 1, 1, 1, 2, 2, 2, 2, 2, 2, 2, 2])
		);
	});

	it('is empty for a count of zero, whatever the pointer', () => {
		expect(getIovecs(rig().domain, 0xffffffff, 0, READ)).toEqual({ segments: [], total: 0 });
	});

	it('refuses a count past 1024 with EINVAL, even when the array is outside', () => {
		const { domain } = rig();
		expect(errno(getIovecs(domain, 0xfffffff0, 1025, READ))).toBe(EINVAL);
		expect(errno(getIovecs(domain, 0xfffffff0, 0xffffffff, READ))).toBe(EINVAL);
	});

	it('refuses an array outside the domain with EFAULT', () => {
		const { domain } = rig();
		expect(errno(getIovecs(domain, 2 * PAGE - 8, 2, READ))).toBe(EFAULT);
		expect(errno(getIovecs(domain, 0xfffffff8, 2, READ))).toBe(EFAULT);
	});

	it('refuses a negative length with EINVAL before it checks any buffer', () => {
		const { domain, put } = rig();
		iov(put, 1000, [
			[0xfffffff0, 16],
			[2000, -1]
		]);
		expect(errno(getIovecs(domain, 1000, 2, READ))).toBe(EINVAL);
		iov(put, 1000, [[2000, 0x80000000]]);
		expect(errno(getIovecs(domain, 1000, 1, READ))).toBe(EINVAL);
	});

	it('refuses an entry that points outside with EFAULT, and one whose length wraps', () => {
		const { domain, put } = rig();
		iov(put, 1000, [
			[2000, 4],
			[2 * PAGE - 2, 4]
		]);
		expect(errno(getIovecs(domain, 1000, 2, READ))).toBe(EFAULT);
		iov(put, 1000, [
			[2000, 4],
			[0xfffffff0, 0x20]
		]);
		expect(errno(getIovecs(domain, 1000, 2, WRITE))).toBe(EFAULT);
		iov(put, 1000, [[2 * PAGE + 1, 1]]);
		expect(errno(getIovecs(domain, 1000, 1, READ))).toBe(EFAULT);
	});

	it('refuses a write span in a read-only domain with EFAULT', () => {
		const domain = new Domain(memory(), READ);
		new DataView(domain.memory.buffer).setUint32(1004, 4, true);
		expect(errno(getIovecs(domain, 1000, 1, WRITE))).toBe(EFAULT);
		expect(refused(getIovecs(domain, 1000, 1, READ))).toBe(false);
	});

	it('cuts a total past the read and write limit, after the entry that reaches it', () => {
		// a domain that claims 4 GiB less a byte, so entries of 1.8 GB pass their own check
		class Huge extends Domain {
			override get size() {
				return 0xffffffff;
			}
		}
		const big = new Huge(new WebAssembly.Memory({ initial: 1 }));
		const view = new DataView(big.memory.buffer);
		[0, 0x70000000, 0x10000, 0x70000000, 0x20000, 100].forEach((w, i) =>
			view.setUint32(8 * Math.floor(i / 2) + 4 * (i % 2), w, true)
		);
		const r = getIovecs(big, 0, 3, READ);
		expect(refused(r)).toBe(false);
		if (refused(r)) return;
		expect(r.total).toBe(MAX_RW_COUNT);
		expect(r.segments.map((s) => s.length)).toEqual([0x70000000, MAX_RW_COUNT - 0x70000000, 0]);
		// one entry alone is cut the same way
		view.setUint32(4, 0xf0000000 >>> 0, true);
		expect(errno(getIovecs(big, 0, 1, READ))).toBe(EINVAL);
		view.setUint32(4, 0x7fffffff, true);
		const one = getIovecs(big, 0, 1, READ);
		expect(refused(one) ? 0 : one.total).toBe(MAX_RW_COUNT);
	});
});

describe('msghdr', () => {
	/** name, namelen, iov, iovlen, control, controllen, flags at 5000 and one iovec at 6000 */
	const header = (
		put: (at: number, ...w: number[]) => void,
		fields: Partial<
			Record<
				'name' | 'namelen' | 'iov' | 'iovlen' | 'control' | 'controllen' | 'flags',
				number
			>
		>
	) => {
		const f = {
			name: 0,
			namelen: 0,
			iov: 6000,
			iovlen: 1,
			control: 0,
			controllen: 0,
			flags: 0,
			...fields
		};
		put(5000, f.name, f.namelen, f.iov, f.iovlen, f.control, f.controllen, f.flags);
	};

	it('is read whole for a send: the name copied, the iovec spans, the control framed', () => {
		const { domain, bytes, put } = rig();
		bytes.set([2, 0, 0, 80], 7000);
		put(6000, 8000, 12);
		// one cmsg of length 16: header, then 4 bytes of data
		put(9000, 16, 1, 1, 0);
		header(put, { name: 7000, namelen: 4, control: 9000, controllen: 16, flags: 0x40 });
		const r = getMsghdr(domain, 5000, true);
		expect(refused(r)).toBe(false);
		if (refused(r)) return;
		expect(r.name).toEqual(new Uint8Array([2, 0, 0, 80]));
		expect(r.iov.total).toBe(12);
		expect((r.control as Uint8Array).length).toBe(16);
		expect(r.flags).toBe(0x40);
	});

	it('refuses a header outside the domain with EFAULT', () => {
		const { domain } = rig();
		expect(errno(getMsghdr(domain, 2 * PAGE - 20, true))).toBe(EFAULT);
		expect(errno(getMsghdr(domain, 0xffffffe4, false))).toBe(EFAULT);
	});

	it('refuses a negative name length with EINVAL only when there is a name, and clamps a long one', () => {
		const { domain, put } = rig();
		header(put, { name: 7000, namelen: -1 });
		expect(errno(getMsghdr(domain, 5000, true))).toBe(EINVAL);
		header(put, { name: 0, namelen: -1 });
		expect(refused(getMsghdr(domain, 5000, true))).toBe(false);
		header(put, { name: 7000, namelen: 5000 });
		const r = getMsghdr(domain, 5000, true);
		expect((r as { name: Uint8Array }).name.length).toBe(128);
	});

	it('refuses a name outside the domain with EFAULT on a send, and lets a receive carry it as room', () => {
		const { domain, put } = rig();
		header(put, { name: 2 * PAGE - 4, namelen: 16 });
		expect(errno(getMsghdr(domain, 5000, true))).toBe(EFAULT);
		const r = getMsghdr(domain, 5000, false);
		expect((r as { name: unknown }).name).toEqual({ offset: 2 * PAGE - 4, length: 16 });
	});

	it('refuses more than 1024 iovecs with EMSGSIZE, after the name', () => {
		const { domain, put } = rig();
		header(put, { iovlen: 1025 });
		expect(errno(getMsghdr(domain, 5000, true))).toBe(EMSGSIZE);
		expect(errno(getMsghdr(domain, 5000, false))).toBe(EMSGSIZE);
		header(put, { iovlen: 1025, name: 2 * PAGE - 4, namelen: 16 });
		expect(errno(getMsghdr(domain, 5000, true))).toBe(EFAULT);
	});

	it('passes the iovec errors up: EINVAL for a negative length, EFAULT for an entry outside', () => {
		const { domain, put } = rig();
		put(6000, 8000, 0xfffffff0);
		header(put, {});
		expect(errno(getMsghdr(domain, 5000, true))).toBe(EINVAL);
		put(6000, 2 * PAGE - 2, 4);
		expect(errno(getMsghdr(domain, 5000, true))).toBe(EFAULT);
		// a receive needs the buffers writable, a send readable
		const read = new Domain(memory(), READ);
		new DataView(read.memory.buffer).setUint32(5012, 1, true);
		new DataView(read.memory.buffer).setUint32(5008, 6000, true);
		expect(errno(getMsghdr(read, 5000, false))).toBe(EFAULT);
	});

	it('refuses a control length past INT_MAX with ENOBUFS, and one outside the domain with EFAULT', () => {
		const { domain, put } = rig();
		put(6000, 8000, 4);
		header(put, { control: 9000, controllen: 0x80000000 });
		expect(errno(getMsghdr(domain, 5000, true))).toBe(ENOBUFS);
		header(put, { control: 9000, controllen: 0xffffffff });
		expect(errno(getMsghdr(domain, 5000, true))).toBe(ENOBUFS);
		header(put, { control: 2 * PAGE - 8, controllen: 16 });
		expect(errno(getMsghdr(domain, 5000, true))).toBe(EFAULT);
		header(put, { control: 0xfffffff8, controllen: 16 });
		expect(errno(getMsghdr(domain, 5000, true))).toBe(EFAULT);
	});

	it('refuses a control header whose length does not fit what is left, with EINVAL', () => {
		const { domain, put } = rig();
		put(6000, 8000, 4);
		header(put, { control: 9000, controllen: 16 });
		// shorter than a cmsghdr
		put(9000, 8, 1, 1, 0);
		expect(errno(getMsghdr(domain, 5000, true))).toBe(EINVAL);
		// longer than the buffer
		put(9000, 20, 1, 1, 0);
		expect(errno(getMsghdr(domain, 5000, true))).toBe(EINVAL);
		put(9000, 16, 1, 1, 0);
		expect(refused(getMsghdr(domain, 5000, true))).toBe(false);
		// a second header that overruns: 16 then 12 at offset 16 needs 28 bytes
		header(put, { control: 9000, controllen: 24 });
		put(9000, 12, 1, 1);
		put(9012, 20, 1, 1);
		expect(errno(getMsghdr(domain, 5000, true))).toBe(EINVAL);
	});

	it('leaves a control buffer shorter than one header alone, as the first-header test does', () => {
		const { domain, put } = rig();
		put(6000, 8000, 4);
		header(put, { control: 9000, controllen: 8 });
		expect(refused(getMsghdr(domain, 5000, true))).toBe(false);
	});

	it('keeps a receive control buffer as room, outside the domain or not', () => {
		const { domain, put } = rig();
		put(6000, 8000, 4);
		header(put, { control: 0xfffffff8, controllen: 0xffffffff });
		const r = getMsghdr(domain, 5000, false);
		expect((r as { control: unknown }).control).toEqual({
			offset: 0xfffffff8,
			length: 0xffffffff
		});
		expect(domain.span(0xfffffff8, 0xffffffff, WRITE)).toBeNull();
	});
});
