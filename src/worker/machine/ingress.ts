import type { MachineStats } from './machine.ts';

/** what wasm_net_next hands the kernel's relay thread (kernel patch 0031) */
const OPEN = 1;
const DATA = 2;
const SHUT = 3;
const ABORT = 4;
/** kept buffers the kernel may free again: the count as the argument, their addresses as u32s in the data (kernel patch 0041) */
const RECLAIM = 5;
/** wasm_net_lend answers the count with this bit set when it copied the bytes, so the buffer is the kernel's again */
const COPIED = 0x4000_0000;
/** a smaller chunk is copied: a kept buffer pins 16 KiB of the machine whatever it holds */
const KEEP_MIN = 4096;
/** buffers one stream keeps at once */
const KEEP_MAX = 8;
/** what wasm_net_end tells the host: the guest finished sending, or the stream is gone; hold and release pause the host's events for a stream */
const FIN = 0;
const RESET = 1;
const HOLD = 2;
const RELEASE = 3;

/** what the guest may have queued toward a reader before it is told to wait */
export const READ_BUFFER = 65_536;

export type NetStats = Pick<
	MachineStats,
	| 'netOpens'
	| 'netEvents'
	| 'netSends'
	| 'netBytesIn'
	| 'netBytesOut'
	| 'netBackpressure'
	| 'netBorrowed'
>;

/** one connection to a program that listens in the machine */
export interface IngressStream {
	readonly id: number;
	/** what the guest sends; ends at the guest's close, errors at its reset */
	readonly readable: ReadableStream<Uint8Array>;
	/** the guest ended or reset its side, whether or not anyone has read to it */
	readonly closed: boolean;
	/** resolves once the guest took the bytes, rejects when the stream is gone */
	write(data: Uint8Array | string): Promise<void>;
	/** no more bytes from the host: the guest reads the end of its input */
	end(): void;
	/** drops the connection from the host's side */
	abort(): void;
	/**
	 * a borrowing stream's chunks are the machine's own memory: the reader promises, with each call,
	 * that nothing it read before this call is used again except what it copied. A stream that does not
	 * borrow ignores both calls
	 */
	recycle(): void;
	/** the reader is done with the stream's chunks, including any it never read */
	releaseAll(): void;
}

interface Chunk {
	bytes: Uint8Array;
	at: number;
	done: () => void;
	fail: (error: Error) => void;
}

class Stream implements IngressStream {
	readonly readable: ReadableStream<Uint8Array>;
	readonly chunks: Chunk[] = [];
	controller!: ReadableStreamDefaultController<Uint8Array>;
	opened = false;
	ended = false;
	shut = false;
	aborted = false;
	held = false;
	/** the guest sent its end, or the stream was reset */
	readClosed = false;
	/** a send found no room: the host raises the interrupt once a read makes some */
	starved = false;
	dead = false;
	/** buffers the kernel lent that are queued or taken and not given back */
	kept = 0;

	readonly id: number;
	readonly port: number;
	readonly borrows: boolean;
	private readonly table: Ingress;
	// a borrowing stream's chunks wait here and leave one per read, so the host knows what a reader has taken
	private readonly queue: { view: Uint8Array; token?: number }[] = [];
	private queued = 0;
	private wanting = false;
	private closeAfter = false;
	private taken: number[] = [];

	constructor(id: number, port: number, table: Ingress, borrows: boolean) {
		this.id = id;
		this.port = port;
		this.table = table;
		this.borrows = borrows;
		this.readable = new ReadableStream<Uint8Array>(
			{
				start: (controller) => void (this.controller = controller),
				pull: () => (this.borrows ? this.hand() : this.unstarve()),
				cancel: () => this.abort()
			},
			borrows
				? { highWaterMark: 0 }
				: new ByteLengthQueuingStrategy({ highWaterMark: READ_BUFFER })
		);
	}

	get closed(): boolean {
		return this.readClosed;
	}

	/** bytes the reader may still be sent before it is told to wait */
	room(): number {
		return this.borrows
			? READ_BUFFER - this.queued
			: Math.max(this.controller.desiredSize ?? 0, 0);
	}

	unstarve() {
		if (!this.starved || this.room() <= 0) return;
		this.starved = false;
		this.table.wake();
	}

	/** a chunk for the reader; `token` names the kernel's buffer it is a view of */
	give(view: Uint8Array, token?: number) {
		if (!this.borrows) return this.controller.enqueue(view);
		if (token !== undefined) this.kept++;
		if (this.wanting) {
			this.wanting = false;
			this.hand(view, token);
		} else {
			this.queue.push({ view, token });
			this.queued += view.length;
		}
	}

	private hand(view?: Uint8Array, token?: number) {
		if (!view) {
			const next = this.queue.shift();
			if (!next) {
				this.wanting = true;
				return;
			}
			({ view, token } = next);
			this.queued -= view.length;
		}
		if (token !== undefined) this.taken.push(token);
		this.controller.enqueue(view);
		this.unstarve();
		if (this.closeAfter && !this.queue.length) this.endReadable();
	}

	/** the chunks queued and never read, given up */
	private dropQueued(): number[] {
		const tokens = this.queue
			.splice(0)
			.flatMap((c) => (c.token === undefined ? [] : [c.token]));
		this.queued = 0;
		this.kept -= tokens.length;
		return tokens;
	}

	recycle() {
		if (!this.taken.length) return;
		this.kept -= this.taken.length;
		this.table.reclaim(this.taken.splice(0), false);
	}

	releaseAll() {
		const taken = this.taken.splice(0);
		this.kept -= taken.length;
		const tokens = [...taken, ...this.dropQueued()];
		if (tokens.length) this.table.reclaim(tokens, true);
		if (this.closeAfter) this.endReadable();
	}

	private endReadable(error?: Error) {
		this.closeAfter = false;
		try {
			if (error) this.controller.error(error);
			else this.controller.close();
		} catch {
			// a reader that cancelled has closed it already
		}
	}

	/** the next thing the kernel is owed, if the stream may deliver it now */
	ready(): boolean {
		if (this.aborted) return true;
		if (this.held) return false;
		return !this.opened || this.chunks.length > 0 || (this.ended && !this.shut);
	}

	write(data: Uint8Array | string): Promise<void> {
		if (this.dead || this.aborted) return Promise.reject(new Error('the stream is closed'));
		if (this.ended) return Promise.reject(new Error('the stream was ended'));
		const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : data;
		if (!bytes.length) return Promise.resolve();
		return new Promise((done, fail) => {
			this.chunks.push({ bytes, at: 0, done: () => done(), fail });
			if (!this.held) this.table.wake();
		});
	}

	end() {
		if (this.ended || this.dead) return;
		this.ended = true;
		this.table.wake();
	}

	abort() {
		if (this.aborted || this.dead) return;
		this.aborted = true;
		this.failWrites(new Error('the stream was aborted'));
		// the kernel never saw it: nothing to close there
		if (!this.opened) this.table.drop(this);
		else this.table.wake();
		this.close(new Error('the stream was aborted'));
	}

	failWrites(error: Error) {
		for (const chunk of this.chunks.splice(0)) chunk.fail(error);
	}

	/** the readable side ends: cleanly at the guest's end, with an error at a reset or abort */
	close(error?: Error) {
		if (this.readClosed) return;
		this.readClosed = true;
		if (error) {
			// nothing will read the queue now, so its buffers go back
			const tokens = this.dropQueued();
			if (tokens.length) this.table.reclaim(tokens, true);
		} else if (this.borrows && this.queue.length) {
			this.closeAfter = true;
			return;
		}
		this.endReadable(error);
	}
}

/**
 * The host's end of the kernel's stream relay (kernel patch 0031): which ports the machine listens
 * on, the streams the host opened to them, and the four imports the relay thread calls. The host
 * holds no TCP: a stream is a queue of bytes each way, and the kernel connects a socket to the
 * program's listener for it
 */
export class Ingress {
	private readonly ports = new Map<number, number>();
	private readonly streams = new Map<number, Stream>();
	private nextId = 1;
	/** counts what a waiting request cares about: bytes from the guest, its end, a reset, the kernel taking bytes */
	activity = 0;

	private readonly stats: NetStats;
	private readonly raise: () => void;

	/** `raise` raises the relay's interrupt on the interrupt cpu */
	constructor(stats: NetStats, raise: () => void) {
		this.stats = stats;
		this.raise = raise;
	}

	/** buffers the reader is done with that the kernel has not been told to free yet */
	private readonly freed: number[] = [];

	/** streams the kernel or the host has not finished with, and buffers the kernel has yet to free */
	get open(): number {
		return this.streams.size + (this.freed.length ? 1 : 0);
	}

	/** every listening port, once per listener, which a snapshot keeps */
	get listeners(): number[] {
		return [...this.ports].flatMap(([port, n]) => Array<number>(n).fill(port));
	}

	restore(listeners: number[] = []) {
		this.ports.clear();
		for (const port of listeners) this.ports.set(port, (this.ports.get(port) ?? 0) + 1);
	}

	listening(port: number): boolean {
		return (this.ports.get(port) ?? 0) > 0;
	}

	listen(port: number, on: boolean) {
		const n = (this.ports.get(port) ?? 0) + (on ? 1 : -1);
		if (n > 0) this.ports.set(port, n);
		else this.ports.delete(port);
	}

	/** `borrows`: the reader follows the contract of `IngressStream.recycle`, so chunks may be the machine's own memory */
	connect(port: number, borrows = false): IngressStream {
		if (!this.listening(port)) throw new Error(`nothing listens on port ${port}`);
		const stream = new Stream(this.nextId++, port, this, borrows);
		this.streams.set(stream.id, stream);
		this.stats.netOpens++;
		this.raise();
		return stream;
	}

	wake() {
		this.raise();
	}

	/** wakes the kernel for a stream whose reader has room though no pull said so (workerd left one starved) */
	poll() {
		for (const stream of this.streams.values()) {
			if (!stream.starved || stream.room() <= 0) continue;
			stream.starved = false;
			this.raise();
		}
	}

	/** buffers a reader is done with: the kernel hears of them on its next call, at once when `now` */
	reclaim(tokens: number[], now: boolean) {
		this.freed.push(...tokens);
		if (now) this.raise();
	}

	drop(stream: Stream) {
		stream.dead = true;
		this.streams.delete(stream.id);
	}

	/**
	 * wasm_net_next: the next event for the kernel, written at `event` (op, id, argument: u32 each)
	 * with a data event's bytes at `buf` (at most `cap`); 0 when there is none. Streams take turns
	 */
	next(memory: WebAssembly.Memory, event: number, buf: number, cap: number): number {
		if (this.freed.length) {
			const view = new DataView(memory.buffer);
			const n = Math.min(this.freed.length, cap >>> 2);
			for (const [i, token] of this.freed.splice(0, n).entries())
				view.setUint32(buf + i * 4, token, true);
			view.setUint32(event, RECLAIM, true);
			view.setUint32(event + 4, 0, true);
			view.setUint32(event + 8, n, true);
			this.stats.netEvents++;
			return 1;
		}
		for (const stream of this.streams.values()) {
			if (!stream.ready()) continue;
			const view = new DataView(memory.buffer);
			let op: number;
			let arg = 0;
			if (stream.aborted) {
				op = ABORT;
				stream.failWrites(new Error('the stream was aborted'));
				this.drop(stream);
			} else if (!stream.opened) {
				op = OPEN;
				arg = stream.port;
				stream.opened = true;
			} else if (stream.chunks.length) {
				op = DATA;
				const chunk = stream.chunks[0]!;
				arg = Math.min(cap, chunk.bytes.length - chunk.at);
				new Uint8Array(memory.buffer, buf, arg).set(
					chunk.bytes.subarray(chunk.at, chunk.at + arg)
				);
				chunk.at += arg;
				if (chunk.at === chunk.bytes.length) {
					stream.chunks.shift();
					chunk.done();
				}
				this.stats.netBytesIn += arg;
			} else {
				op = SHUT;
				stream.shut = true;
				this.finish(stream);
			}
			view.setUint32(event, op, true);
			view.setUint32(event + 4, stream.id, true);
			view.setUint32(event + 8, arg, true);
			this.stats.netEvents++;
			this.activity++;
			// the next call starts with the others
			if (this.streams.delete(stream.id)) this.streams.set(stream.id, stream);
			return 1;
		}
		return 0;
	}

	/**
	 * wasm_net_send: bytes the guest sent on a stream. Answers the count taken, 0 when the reader
	 * is behind (the interrupt comes when it catches up) and -1 when the stream is gone
	 */
	send(id: number, bytes: Uint8Array): number {
		const stream = this.streams.get(id);
		if (!stream || stream.readClosed) return -1;
		this.stats.netSends++;
		const n = Math.min(stream.room(), bytes.length);
		if (n < bytes.length) {
			stream.starved = true;
			this.stats.netBackpressure++;
		}
		if (!n) return 0;
		stream.give(bytes.slice(0, n));
		this.stats.netBytesOut += n;
		this.activity++;
		return n;
	}

	/**
	 * wasm_net_lend (kernel patch 0041): a buffer of bytes the guest read for a stream. A borrowing
	 * stream keeps a large one as it is until `recycle` or `releaseAll`, so the reader sees the
	 * machine's memory itself; any other bytes are copied. Answers the count taken (with `COPIED` set
	 * when the buffer is the kernel's again), 0 when the reader is behind (the kernel offers the buffer
	 * again after the interrupt) and -1 when the stream is gone. A buffer is taken whole
	 */
	lend(memory: WebAssembly.Memory, id: number, buf: number, n: number): number {
		const stream = this.streams.get(id);
		if (!stream || stream.readClosed) return -1;
		this.stats.netSends++;
		if (stream.room() <= 0) {
			stream.starved = true;
			this.stats.netBackpressure++;
			return 0;
		}
		const view = new Uint8Array(memory.buffer, buf, n);
		this.stats.netBytesOut += n;
		this.activity++;
		if (stream.borrows && n >= KEEP_MIN && stream.kept < KEEP_MAX) {
			this.stats.netBorrowed += n;
			stream.give(view, buf);
			return n;
		}
		stream.give(view.slice());
		return n | COPIED;
	}

	/** wasm_net_end */
	end(id: number, how: number) {
		const stream = this.streams.get(id);
		if (!stream) return;
		if (how === FIN || how === RESET) this.activity++;
		if (how === FIN) {
			stream.close();
			this.finish(stream);
		} else if (how === RESET) {
			const error = new Error('the connection was reset');
			stream.failWrites(error);
			stream.close(error);
			this.drop(stream);
		} else if (how === HOLD) stream.held = true;
		else if (how === RELEASE) {
			stream.held = false;
			if (stream.ready()) this.raise();
		}
	}

	/** a stream whose two ends are both done leaves the table */
	private finish(stream: Stream) {
		if (stream.readClosed && stream.shut) this.drop(stream);
	}
}
