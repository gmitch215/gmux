/** the longest response head, status line and headers, the machine may send before it is a bad gateway */
export const MAX_HEAD = 65_536;

/** thrown for a response the host cannot frame; the site turns it into a 502 */
export class BadGateway extends Error {}

/** thrown when the machine says nothing for too long; the site turns it into a 504 */
export class GatewayTimeout extends Error {}

/** thrown when a request body runs past its bound; the site turns it into a 413 */
export class BodyTooLarge extends Error {}

const HOP_BY_HOP = [
	'connection',
	'keep-alive',
	'proxy-authenticate',
	'proxy-authorization',
	'proxy-connection',
	'te',
	'trailer',
	'transfer-encoding',
	'upgrade'
];

/** the guest shares the control plane's origin, so what the browser holds for it never reaches the guest */
const NOT_FORWARDED = ['cookie', 'authorization'];

/** guest pages run in an opaque origin: no read of the owner token in localStorage, no cookies */
const GUEST_CSP = 'sandbox allow-scripts allow-forms';

const encoder = new TextEncoder();

/**
 * A request as HTTP/1.1 for a program in the machine: the head, then the body as it arrives, framed
 * by its Content-Length or chunked. Hop-by-hop headers are dropped and the connection is closed
 * after the response, which is how the response is framed when it carries no length. A body that
 * runs past `maxBytes` throws BodyTooLarge before the byte that crosses the bound is sent
 */
export async function* requestBytes(
	request: Request,
	maxBytes = Infinity
): AsyncGenerator<Uint8Array> {
	const url = new URL(request.url);
	const connection = (request.headers.get('connection') ?? '')
		.split(',')
		.map((token) => token.trim().toLowerCase());
	let head = `${request.method} ${url.pathname}${url.search} HTTP/1.1\r\n`;
	let host = false;
	for (const [name, value] of request.headers) {
		const lower = name.toLowerCase();
		// the body goes out with the head, so a 100-continue wait would only stall the client
		if (HOP_BY_HOP.includes(lower) || connection.includes(lower)) continue;
		if (lower === 'content-length' || lower === 'expect') continue;
		if (NOT_FORWARDED.includes(lower)) continue;
		if (lower === 'host') host = true;
		head += `${name}: ${value}\r\n`;
	}
	if (!host) head += `host: ${url.host}\r\n`;
	const length = request.headers.get('content-length');
	const chunked = request.body !== null && length === null;
	if (request.body !== null && length !== null) head += `content-length: ${length}\r\n`;
	else if (chunked) head += 'transfer-encoding: chunked\r\n';
	else if (request.method === 'POST' || request.method === 'PUT' || request.method === 'PATCH')
		head += 'content-length: 0\r\n';
	head += 'connection: close\r\n\r\n';
	yield encoder.encode(head);
	if (request.body === null) return;
	const reader = request.body.getReader();
	let total = 0;
	try {
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			if (!value.length) continue;
			total += value.length;
			if (total > maxBytes) {
				await reader.cancel().catch(() => {});
				throw new BodyTooLarge(`the request body is over ${maxBytes} bytes`);
			}
			if (!chunked) yield value;
			else {
				yield encoder.encode(`${value.length.toString(16)}\r\n`);
				yield value;
				yield encoder.encode('\r\n');
			}
		}
	} finally {
		reader.releaseLock();
	}
	if (chunked) yield encoder.encode('0\r\n\r\n');
}

type Framing =
	{ kind: 'none' } | { kind: 'length'; left: number } | { kind: 'chunked' } | { kind: 'close' };

const TOKEN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;

/** the head of a response: status line and headers, with what the body's framing needs */
export interface ResponseHead {
	status: number;
	statusText: string;
	headers: Headers;
	framing: Framing;
}

/** the index just past the first blank line of `bytes` (a script's headers may end in a bare LF), or -1 */
function headEnd(bytes: Uint8Array): number {
	let line = 0;
	for (let i = 0; i < bytes.length; i++) {
		if (bytes[i] !== 10) continue;
		if (i === line || (i === line + 1 && bytes[line] === 13)) return i + 1;
		line = i + 1;
	}
	return -1;
}

function latin1(bytes: Uint8Array): string {
	let text = '';
	for (let i = 0; i < bytes.length; i += 8192)
		text += String.fromCharCode(...bytes.subarray(i, i + 8192));
	return text;
}

/** parses a complete head (through the blank line); throws BadGateway for anything off */
export function parseHead(bytes: Uint8Array, method: string): ResponseHead {
	const lines = latin1(bytes).split(/\r?\n/);
	while (lines.at(-1) === '') lines.pop();
	const status = /^HTTP\/1\.[01] (\d{3})(?: (.*))?$/.exec(lines[0] ?? '');
	if (!status) throw new BadGateway('bad status line');
	const code = Number(status[1]);
	const headers = new Headers();
	for (const line of lines.slice(1)) {
		const colon = line.indexOf(':');
		const name = line.slice(0, colon);
		if (colon < 1 || !TOKEN.test(name)) throw new BadGateway('bad header line');
		try {
			headers.append(name, line.slice(colon + 1).trim());
		} catch {
			throw new BadGateway(`the header ${name} is refused`);
		}
	}
	const encodings = (headers.get('transfer-encoding') ?? '')
		.split(',')
		.map((token) => token.trim().toLowerCase())
		.filter(Boolean);
	const lengths = (headers.get('content-length') ?? '').split(',').map((v) => v.trim());
	let framing: Framing;
	if (method === 'HEAD' || code === 204 || code === 304 || code < 200) framing = { kind: 'none' };
	else if (encodings.length) {
		if (encodings.at(-1) !== 'chunked') throw new BadGateway('unsupported transfer coding');
		framing = { kind: 'chunked' };
	} else if (headers.has('content-length')) {
		if (new Set(lengths).size !== 1 || !/^\d{1,15}$/.test(lengths[0]!))
			throw new BadGateway('bad content-length');
		framing = { kind: 'length', left: Number(lengths[0]) };
		headers.set('content-length', lengths[0]!);
	} else framing = { kind: 'close' };
	// the fields the next hop owns, and those the response's own Connection names
	const named = (headers.get('connection') ?? '')
		.split(',')
		.map((token) => token.trim().toLowerCase())
		.filter((token) => TOKEN.test(token));
	// clear-site-data would wipe the owner's token from this origin's storage
	for (const name of [...HOP_BY_HOP, ...named, 'set-cookie', 'clear-site-data'])
		headers.delete(name);
	headers.append('content-security-policy', GUEST_CSP);
	// a body the host decoded no longer has a chunked length
	if (framing.kind === 'chunked' || framing.kind === 'close') headers.delete('content-length');
	return { status: code, statusText: status[2] ?? '', headers, framing };
}

/** decodes a chunked body incrementally; `push` returns the bytes it held and whether the body ended */
class ChunkedDecoder {
	private state: 'size' | 'data' | 'crlf' | 'trailer' | 'end' = 'size';
	private left = 0;
	private line = '';
	private trailerLength = 0;

	get ended(): boolean {
		return this.state === 'end';
	}

	push(bytes: Uint8Array): Uint8Array[] {
		const out: Uint8Array[] = [];
		let at = 0;
		while (at < bytes.length && this.state !== 'end') {
			if (this.state === 'data') {
				const take = Math.min(this.left, bytes.length - at);
				out.push(bytes.subarray(at, at + take));
				at += take;
				this.left -= take;
				if (!this.left) this.state = 'crlf';
				continue;
			}
			const byte = bytes[at++]!;
			if (this.state === 'crlf') {
				if (byte === 13) continue;
				if (byte !== 10) throw new BadGateway('bad chunk framing');
				this.state = 'size';
			} else if (this.state === 'size') {
				if (byte === 13) continue;
				if (byte !== 10) {
					this.line += String.fromCharCode(byte);
					if (this.line.length > 1024) throw new BadGateway('chunk size line too long');
					continue;
				}
				const size = /^([0-9a-fA-F]{1,13})\s*(;.*)?$/.exec(this.line);
				this.line = '';
				if (!size) throw new BadGateway('bad chunk size');
				this.left = parseInt(size[1]!, 16);
				this.state = this.left ? 'data' : 'trailer';
				this.trailerLength = 0;
			} else {
				// trailer lines up to the blank one: dropped
				if (byte === 13) continue;
				if (byte === 10) {
					if (!this.trailerLength) this.state = 'end';
					this.trailerLength = 0;
				} else if (++this.trailerLength > MAX_HEAD)
					throw new BadGateway('trailer too long');
			}
		}
		return out;
	}
}

/** the body as the head framed it, pulled from `reader` as the consumer reads */
function framedBody(
	reader: ReadableStreamDefaultReader<Uint8Array>,
	rest: Uint8Array,
	framing: Framing,
	done: (clean: boolean) => void,
	fail: (error: Error) => Error
): ReadableStream<Uint8Array> {
	const decoder = framing.kind === 'chunked' ? new ChunkedDecoder() : null;
	let left = framing.kind === 'length' ? framing.left : 0;
	let pending: Uint8Array | undefined = rest.length ? rest : undefined;
	/** the body bytes in `bytes`, and whether the body is over */
	const feed = (bytes: Uint8Array): { out: Uint8Array[]; ended: boolean } => {
		if (decoder) return { out: decoder.push(bytes), ended: decoder.ended };
		if (framing.kind === 'length') {
			const take = bytes.subarray(0, left);
			left -= take.length;
			return { out: [take], ended: left === 0 };
		}
		return { out: [bytes], ended: false };
	};
	return new ReadableStream<Uint8Array>({
		async pull(controller) {
			try {
				for (;;) {
					let result: { out: Uint8Array[]; ended: boolean };
					if (pending) {
						result = feed(pending);
						pending = undefined;
					} else {
						const { done: eof, value } = await reader.read();
						if (!eof) result = feed(value);
						else if (framing.kind === 'close') result = { out: [], ended: true };
						else throw new Error('the machine closed mid-body');
					}
					for (const part of result.out) if (part.length) controller.enqueue(part);
					if (result.ended) {
						done(true);
						controller.close();
						return;
					}
					if (result.out.some((part) => part.length)) return;
				}
			} catch (error) {
				controller.error(fail(error as Error));
			}
		},
		cancel() {
			fail(new Error('the reader went away'));
		}
	});
}

/**
 * The machine's reply as a `Response`: reads until the head is complete, then streams the body as
 * the framing says. A head the host cannot frame throws BadGateway; a body cut short errors the
 * stream, since its head has gone out already. `done` is told once the body has ended cleanly (true)
 * or the stream is over for another reason (false: the reader left, or the reply was bad)
 */
export async function responseFrom(
	source: ReadableStream<Uint8Array>,
	method: string,
	done: (clean: boolean) => void = () => {}
): Promise<Response> {
	const reader = source.getReader();
	const fail = (error: Error) => {
		reader.cancel().catch(() => {});
		done(false);
		return error;
	};
	let buffered: Uint8Array = new Uint8Array(0);
	let head: ResponseHead | undefined;
	let rest: Uint8Array = new Uint8Array(0);
	try {
		while (!head) {
			const found = headEnd(buffered);
			if (found < 0) {
				if (buffered.length > MAX_HEAD) throw new BadGateway('response head too long');
				const { done: eof, value } = await reader.read();
				if (eof) throw new BadGateway('the machine closed before a response');
				const joined = new Uint8Array(buffered.length + value.length);
				joined.set(buffered);
				joined.set(value, buffered.length);
				buffered = joined;
				continue;
			}
			const parsed = parseHead(buffered.subarray(0, found), method);
			if (parsed.status === 101) throw new BadGateway('upgrades are not served');
			rest = buffered.subarray(found);
			// an interim response is followed by the real one
			if (parsed.status < 200) buffered = rest;
			else head = parsed;
		}
	} catch (error) {
		throw fail(error as Error);
	}
	const { framing } = head;
	const empty = framing.kind === 'none' || (framing.kind === 'length' && framing.left === 0);
	if (empty) done(true);
	try {
		return new Response(empty ? null : framedBody(reader, rest, framing, done, fail), {
			status: head.status,
			statusText: head.statusText,
			headers: head.headers
		});
	} catch {
		throw fail(new BadGateway('the response is refused'));
	}
}
