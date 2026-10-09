import { describe, expect, it, vi } from 'vitest';
import type { IngressStream } from '../../src/worker/machine/ingress.ts';
import {
	Server,
	type ServeHost,
	type ServeLimits,
	type ServeMachine
} from '../../src/worker/serve.ts';

const encode = (text: string) => new TextEncoder().encode(text);
const sleep = (ms: number) => new Promise<void>((done) => setTimeout(done, ms));

/** a reply of `length` declared bytes, of which `body` has arrived */
const reply = (body: string, length = body.length) =>
	`HTTP/1.1 200 OK\r\ncontent-length: ${length}\r\n\r\n${body}`;

class FakeStream implements IngressStream {
	readonly id = 1;
	readonly readable: ReadableStream<Uint8Array>;
	readonly written: Uint8Array[] = [];
	ended = false;
	aborted = false;
	private controller!: ReadableStreamDefaultController<Uint8Array>;

	constructor() {
		this.readable = new ReadableStream({
			start: (controller) => void (this.controller = controller)
		});
	}

	async write(data: Uint8Array | string) {
		if (this.aborted) throw new Error('the stream was aborted');
		this.written.push(typeof data === 'string' ? encode(data) : data);
	}

	end() {
		this.ended = true;
	}

	abort() {
		if (this.aborted) return;
		this.aborted = true;
		this.fail(new Error('the stream was aborted'));
	}

	/** the guest sends bytes */
	send(text: string) {
		this.controller.enqueue(encode(text));
	}

	finish() {
		this.controller.close();
	}

	fail(error: Error) {
		this.controller.error(error);
	}

	get received(): string {
		return this.written.map((chunk) => new TextDecoder().decode(chunk)).join('');
	}
}

/** a machine whose guest answers each new stream the way `script` says, under a server with small limits */
function rig(
	script: (stream: FakeStream, n: number) => void = () => {},
	limits: Partial<ServeLimits> = {}
) {
	const streams: FakeStream[] = [];
	const state = {
		activity: 0,
		listening: true,
		pumping: false,
		opens: 0,
		rests: 0,
		pumps: 0,
		waits: 0
	};
	const fixed: number[] = [];
	const machine: ServeMachine = {
		listening: () => state.listening,
		ingress: () => {
			const stream = new FakeStream();
			streams.push(stream);
			script(stream, streams.length);
			return stream;
		},
		netPoll() {},
		get netActivity() {
			return state.activity;
		}
	};
	const host: ServeHost = {
		open: async () => (state.opens++, machine),
		pumping: () => state.pumping,
		pump: async (budgetMs, wake) => {
			state.pumps++;
			const until = Date.now() + Math.min(budgetMs, 5);
			while (Date.now() < until && !wake()) await sleep(1);
		},
		rest: async () => void state.rests++,
		wait: (ms) => (state.waits++, sleep(ms)),
		fixedLength: (length) => (fixed.push(length), new TransformStream())
	};
	const server = new Server(host, {
		timeoutMs: 60,
		maxStreams: 2,
		maxRequestBytes: 16,
		...limits
	});
	return { server, streams, state, fixed };
}

const get = (server: Server, path = '/') => server.serve(new Request(`http://site.test${path}`));

describe('Server.serve', () => {
	it('answers 503 with retry-after at the stream cap, before a third stream is opened', async () => {
		const { server, streams } = rig((s) => s.send(reply('hello', 10)));
		const first = await get(server);
		const second = await get(server);
		expect([first.status, second.status]).toEqual([200, 200]);
		expect(server.open).toBe(2);
		const third = await get(server);
		expect(third.status).toBe(503);
		expect(third.headers.get('retry-after')).toBe('1');
		expect(streams).toHaveLength(2);
		expect(server.open).toBe(2);
	});

	it('gives the last slot to one of two requests that ask at once', async () => {
		const { server } = rig((s) => s.send(reply('hello', 10)), { maxStreams: 1 });
		const statuses = (await Promise.all([get(server), get(server)])).map((r) => r.status);
		expect(statuses.sort()).toEqual([200, 503]);
		expect(server.open).toBe(1);
	});

	it('answers 503 when nothing listens, without opening a stream', async () => {
		const { server, streams, state } = rig();
		state.listening = false;
		const res = await get(server);
		expect(res.status).toBe(503);
		expect(res.headers.get('retry-after')).toBe('1');
		expect(streams).toHaveLength(0);
		expect(server.open).toBe(0);
	});

	const ends: Record<string, (s: FakeStream) => void> = {
		'a body read to its end': (s) => s.send(reply('hello')),
		'a reply with no body': (s) => s.send('HTTP/1.1 204 No Content\r\n\r\n'),
		'a client that cancels the body': (s) => s.send(reply('hello', 10)),
		'a guest that resets mid-body': (s) => s.send(reply('hello', 10)),
		'a bad head': (s) => s.send('nonsense\r\n\r\n'),
		'a silent machine': () => {}
	};
	const finishers: Record<string, (res: Response, s: FakeStream) => Promise<unknown>> = {
		'a body read to its end': (res) => res.text(),
		'a reply with no body': async () => {},
		'a client that cancels the body': (res) => res.body!.cancel(),
		'a guest that resets mid-body': (res, s) => {
			const read = res.text();
			s.fail(new Error('the connection was reset'));
			return read.catch(() => {});
		},
		'a bad head': async () => {},
		'a silent machine': async () => {}
	};
	for (const [name, script] of Object.entries(ends))
		it(`frees its slot after ${name}`, async () => {
			const { server, streams } = rig(script, { maxStreams: 1 });
			const res = await get(server);
			await finishers[name]!(res, streams[0]!);
			await vi.waitFor(() => expect(server.open).toBe(0));
			expect((await get(server)).status).not.toBe(503);
		});

	it('frees its slot after a client whose upload fails', async () => {
		const { server, streams } = rig(() => {}, { maxStreams: 1 });
		const upload = new ReadableStream<Uint8Array>({
			pull: (controller) => controller.error(new Error('the client went away'))
		});
		const res = await server.serve(
			new Request('http://site.test/', {
				method: 'POST',
				body: upload,
				duplex: 'half'
			} as RequestInit)
		);
		expect(res.status).toBe(502);
		expect(streams[0]!.aborted).toBe(true);
		expect(server.open).toBe(0);
	});

	it('aborts the stream when the client cancels the body', async () => {
		const { server, streams } = rig((s) => s.send(reply('hello', 10)));
		const res = await get(server);
		await res.body!.cancel();
		await vi.waitFor(() => expect(streams[0]!.aborted).toBe(true));
		expect(server.open).toBe(0);
	});

	it('answers 413 for a declared body over the bound, with no stream and no wake', async () => {
		const { server, streams, state } = rig();
		const res = await server.serve(
			new Request('http://site.test/', {
				method: 'POST',
				body: 'x'.repeat(17),
				headers: { 'content-length': '17' }
			})
		);
		expect(res.status).toBe(413);
		expect(streams).toHaveLength(0);
		expect(state.opens).toBe(0);
		expect(server.open).toBe(0);
	});

	it('aborts a chunked body that passes the bound, answers 413 and sends no byte past it', async () => {
		const { server, streams } = rig();
		const chunks = ['a'.repeat(10), 'b'.repeat(10)];
		const body = new ReadableStream<Uint8Array>({
			pull: (controller) => {
				const next = chunks.shift();
				if (next === undefined) controller.close();
				else controller.enqueue(encode(next));
			}
		});
		const res = await server.serve(
			new Request('http://site.test/', {
				method: 'POST',
				body,
				duplex: 'half'
			} as RequestInit)
		);
		expect(res.status).toBe(413);
		expect(streams[0]!.aborted).toBe(true);
		expect(streams[0]!.received).toContain('a'.repeat(10));
		expect(streams[0]!.received).not.toContain('b');
		expect(server.open).toBe(0);
	});

	it('passes a body exactly at the bound, declared or chunked', async () => {
		const exact = 'x'.repeat(16);
		const declared = rig((s) => s.send(reply('ok')));
		const a = await declared.server.serve(
			new Request('http://site.test/', {
				method: 'POST',
				body: exact,
				headers: { 'content-length': '16' }
			})
		);
		expect(a.status).toBe(200);
		expect(declared.streams[0]!.received).toContain(exact);
		const chunked = rig((s) => s.send(reply('ok')));
		const stream = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(encode(exact.slice(0, 8)));
				controller.enqueue(encode(exact.slice(8)));
				controller.close();
			}
		});
		const b = await chunked.server.serve(
			new Request('http://site.test/', {
				method: 'POST',
				body: stream,
				duplex: 'half'
			} as RequestInit)
		);
		expect(b.status).toBe(200);
		expect(chunked.streams[0]!.received).toContain(exact.slice(0, 8));
		expect(chunked.streams[0]!.received).toContain(exact.slice(8));
		expect(chunked.streams[0]!.aborted).toBe(false);
	});

	it('answers 504 for a machine that stays silent', async () => {
		const { server } = rig();
		const res = await get(server);
		expect(res.status).toBe(504);
		expect(await res.text()).toBe('gateway timeout');
	});

	it('does not time out a machine that is busy, only one that goes quiet', async () => {
		const { server, state } = rig((s) => setTimeout(() => s.send(reply('late')), 120));
		const tick = setInterval(() => state.activity++, 10);
		try {
			const res = await get(server);
			expect(res.status).toBe(200);
			expect(await res.text()).toBe('late');
		} finally {
			clearInterval(tick);
		}
	});

	it('answers 502 for a head the host cannot frame', async () => {
		const { server } = rig((s) => s.send('nonsense\r\n\r\n'));
		const res = await get(server);
		expect(res.status).toBe(502);
		expect(await res.text()).toContain('bad gateway');
	});

	it('uses a fixed-length stream when the reply has a content-length, and not otherwise', async () => {
		const sized = rig((s) => (s.send(reply('hello')), s.finish()));
		const a = await get(sized.server);
		expect(await a.text()).toBe('hello');
		expect(sized.fixed).toEqual([5]);
		const chunked = rig((s) => {
			s.send('HTTP/1.1 200 OK\r\ntransfer-encoding: chunked\r\n\r\n5\r\nhello\r\n0\r\n\r\n');
		});
		const b = await get(chunked.server);
		expect(await b.text()).toBe('hello');
		const closed = rig((s) => {
			s.send('HTTP/1.1 200 OK\r\nconnection: close\r\n\r\nhello');
			s.finish();
		});
		const c = await get(closed.server);
		expect(await c.text()).toBe('hello');
		expect(chunked.fixed).toEqual([]);
		expect(closed.fixed).toEqual([]);
	});

	it('waits out a pump another request runs, and rests only when the last stream is done', async () => {
		const { server, state } = rig((s) => s.send(reply('hello', 10)));
		state.pumping = true;
		const first = await get(server);
		expect(state.pumps).toBe(0);
		expect(state.waits).toBeGreaterThan(0);
		state.pumping = false;
		const second = await get(server);
		expect(state.rests).toBe(0);
		await first.body!.cancel();
		await vi.waitFor(() => expect(server.open).toBe(1));
		expect(state.rests).toBe(0);
		await second.body!.cancel();
		await vi.waitFor(() => expect(server.open).toBe(0));
		await vi.waitFor(() => expect(state.rests).toBeGreaterThan(0));
	});
});
