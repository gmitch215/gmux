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
	closed = false;
	/** called with the request's number each time a head arrives, so a guest can answer a kept stream */
	onRequest: (n: number) => void = () => {};
	heads = 0;
	private controller!: ReadableStreamDefaultController<Uint8Array>;

	constructor() {
		this.readable = new ReadableStream({
			start: (controller) => void (this.controller = controller)
		});
	}

	async write(data: Uint8Array | string) {
		if (this.aborted) throw new Error('the stream was aborted');
		const bytes = typeof data === 'string' ? encode(data) : data;
		this.written.push(bytes);
		// the guest answers after it has taken the head
		if (new TextDecoder().decode(bytes).includes('\r\n\r\n')) {
			const n = ++this.heads;
			setTimeout(() => this.onRequest(n), 0);
		}
	}

	end() {
		this.ended = true;
	}

	recycles = 0;
	releases = 0;

	recycle() {
		this.recycles++;
	}

	releaseAll() {
		this.releases++;
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
		this.closed = true;
		this.controller.close();
	}

	fail(error: Error) {
		this.closed = true;
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
		waits: 0,
		stall: false
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
		wait: (ms) => (state.waits++, state.stall ? new Promise<void>(() => {}) : sleep(ms)),
		fixedLength: (length) => (fixed.push(length), new TransformStream())
	};
	const server = new Server(host, {
		timeoutMs: 60,
		maxStreams: 2,
		maxRequestBytes: 16,
		idleMs: 0,
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

	it('hands a 206 over with its Content-Range and a fixed length of its own', async () => {
		const { server, fixed } = rig((s) =>
			s.send(
				'HTTP/1.1 206 Partial Content\r\ncontent-length: 5\r\ncontent-range: bytes 100-104/1024\r\n\r\nhello'
			)
		);
		const res = await get(server);
		expect(res.status).toBe(206);
		expect(res.headers.get('content-range')).toBe('bytes 100-104/1024');
		expect(res.headers.get('content-length')).toBe('5');
		expect(fixed).toEqual([5]);
		expect(await res.text()).toBe('hello');
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

describe('Server.serve with borrowed buffers', () => {
	it('asks for a borrowing stream and gives its buffers back once the body has been read', async () => {
		const asked: (boolean | undefined)[] = [];
		const { server, streams } = rig((s) => s.send(reply('hello')));
		const open = (server as unknown as { host: ServeHost }).host.open;
		(server as unknown as { host: ServeHost }).host.open = async () => {
			const machine = await open();
			const ingress = machine.ingress.bind(machine);
			machine.ingress = (port, borrows) => (asked.push(borrows), ingress(port, borrows));
			return machine;
		};
		const res = await get(server);
		expect(streams[0]!.releases).toBe(0);
		expect(await res.text()).toBe('hello');
		expect(asked).toEqual([true]);
		expect(streams[0]!.releases).toBe(1);
		expect(streams[0]!.recycles).toBeGreaterThan(0);
	});

	it('keeps the slot until the last part has gone out, not until the guest has sent it', async () => {
		const { server } = rig((s) => s.send(reply('hello')));
		const res = await get(server);
		expect(server.open).toBe(1);
		await res.text();
		expect(server.open).toBe(0);
	});

	it('frees the slot at the end of the body when the buffers are not borrowed', async () => {
		const { server, streams } = rig((s) => s.send(reply('hello')), { borrow: false });
		const res = await get(server);
		await res.text();
		expect(server.open).toBe(0);
		expect(streams[0]!.releases).toBe(1);
	});

	it('gives the buffers back when the client cancels the body', async () => {
		const { server, streams } = rig((s) => s.send(reply('hello', 10)));
		const res = await get(server);
		await res.body!.cancel();
		await vi.waitFor(() => expect(streams[0]!.releases).toBeGreaterThan(0));
		expect(streams[0]!.aborted).toBe(true);
	});

	it('gives the buffers back when the machine resets in the middle of the body', async () => {
		const { server, streams } = rig((s) => {
			s.send(reply('hel', 10));
			setTimeout(() => s.fail(new Error('the connection was reset')), 5);
		});
		const res = await get(server);
		await expect(res.text()).rejects.toThrow();
		await vi.waitFor(() => expect(streams[0]!.releases).toBe(1));
		expect(server.open).toBe(0);
	});

	it('gives the buffers back when the head cannot be framed', async () => {
		const { server, streams } = rig((s) => s.send('garbage\r\n\r\n'));
		expect((await get(server)).status).toBe(502);
		expect(streams[0]!.releases).toBeGreaterThan(0);
	});

	it('parks a kept stream only once its body has been read', async () => {
		const { server } = rig((s) => void (s.onRequest = () => s.send(reply('hello'))), {
			idleMs: 1000
		});
		const res = await get(server);
		expect(server.idle).toBe(0);
		await res.text();
		expect(server.idle).toBe(1);
	});
});

describe('Server.serve with idle streams', () => {
	/** the guest answers every request on a stream with 's<stream>r<request>' */
	const answers = (s: FakeStream, n: number) =>
		void (s.onRequest = (k) => s.send(reply(`s${n}r${k}`)));
	const text = async (res: Response | Promise<Response>) => (await res).text();

	it('sends the next request down the stream the last one finished on', async () => {
		const { server, streams } = rig(answers, { idleMs: 1000 });
		expect(await text(get(server))).toBe('s1r1');
		expect(server.open).toBe(0);
		expect(server.idle).toBe(1);
		expect(await text(get(server, '/b'))).toBe('s1r2');
		expect(streams).toHaveLength(1);
		expect(streams[0]!.received).toContain('GET /b HTTP/1.1');
		expect(streams[0]!.received).toContain('connection: keep-alive');
		expect(streams[0]!.ended).toBe(false);
	});

	it('serves HEAD on a kept stream and sends no body down it', async () => {
		const { server, streams } = rig(
			(s) =>
				void (s.onRequest = (k) =>
					s.send(
						k === 1 ? reply('hello') : 'HTTP/1.1 200 OK\r\ncontent-length: 5\r\n\r\n'
					)),
			{ idleMs: 1000 }
		);
		expect(await text(get(server))).toBe('hello');
		const head = await server.serve(new Request('http://site.test/', { method: 'HEAD' }));
		expect(head.body).toBeNull();
		expect(head.headers.get('content-length')).toBe('5');
		expect(streams).toHaveLength(1);
		expect(server.idle).toBe(1);
	});

	it('ends an idle stream after its timeout, with the machine resting as after any request', async () => {
		const { server, streams, state } = rig(answers, { idleMs: 40 });
		await text(get(server));
		await vi.waitFor(() => expect(state.rests).toBeGreaterThan(0));
		expect(server.idle).toBe(1);
		expect(streams[0]!.ended).toBe(false);
		await vi.waitFor(() => expect(streams[0]!.ended).toBe(true));
		expect(server.idle).toBe(0);
		expect(await text(get(server))).toBe('s2r1');
		expect(streams).toHaveLength(2);
	});

	it('does not hand out a stream that outwaited its timeout, whatever the clock did to the sweep', async () => {
		const { server, streams, state } = rig(answers, { idleMs: 30 });
		state.stall = true;
		await text(get(server));
		await sleep(50);
		expect(streams[0]!.ended).toBe(false);
		expect(await text(get(server))).toBe('s2r1');
		expect(streams[0]!.ended).toBe(true);
		expect(streams).toHaveLength(2);
	});

	const ending: Record<string, (s: FakeStream) => void> = {
		'a reply that says Connection: close': (s) =>
			s.send('HTTP/1.1 200 OK\r\ncontent-length: 2\r\nconnection: close\r\n\r\nok'),
		'a body that runs to the close': (s) => {
			s.send('HTTP/1.1 200 OK\r\n\r\nok');
			s.finish();
		},
		'a reply with bytes after its body': (s) =>
			s.send('HTTP/1.1 200 OK\r\ncontent-length: 2\r\n\r\nokNEXT'),
		'an HTTP/1.0 reply': (s) => s.send('HTTP/1.0 200 OK\r\ncontent-length: 2\r\n\r\nok')
	};
	for (const [name, answer] of Object.entries(ending))
		it(`ends the stream after ${name}`, async () => {
			const { server, streams } = rig((s) => void (s.onRequest = () => answer(s)), {
				idleMs: 1000
			});
			expect(await text(get(server))).toBe('ok');
			expect(streams[0]!.ended).toBe(true);
			expect(server.idle).toBe(0);
			expect(server.open).toBe(0);
		});

	it('does not reuse a stream the guest closed while it was idle', async () => {
		const { server, streams } = rig(answers, { idleMs: 1000 });
		await text(get(server));
		streams[0]!.finish();
		expect(await text(get(server))).toBe('s2r1');
		expect(streams).toHaveLength(2);
		expect(streams[0]!.ended).toBe(true);
	});

	it('retries on a new stream when a kept stream fails before it answers', async () => {
		const { server, streams } = rig(
			(s, n) =>
				void (s.onRequest = (k) =>
					n === 1 && k === 2 ? s.fail(new Error('reset')) : s.send(reply(`s${n}r${k}`))),
			{ idleMs: 1000 }
		);
		expect(await text(get(server))).toBe('s1r1');
		const res = await get(server);
		expect(res.status).toBe(200);
		expect(await res.text()).toBe('s2r1');
		expect(streams).toHaveLength(2);
		expect(server.open).toBe(0);
		expect(server.idle).toBe(1);
	});

	it('answers 504 and does not retry when a kept stream goes quiet', async () => {
		const { server, streams } = rig(
			(s, n) =>
				void (s.onRequest = (k) => (n === 1 && k === 2 ? undefined : s.send(reply('ok')))),
			{ idleMs: 1000 }
		);
		await text(get(server));
		expect((await get(server)).status).toBe(504);
		expect(streams).toHaveLength(1);
		expect(streams[0]!.aborted).toBe(true);
	});

	it('does not retry a failure on a new stream', async () => {
		const { server, streams } = rig(
			(s) => void (s.onRequest = () => s.send('nonsense\r\n\r\n')),
			{ idleMs: 1000 }
		);
		expect((await get(server)).status).toBe(502);
		expect(streams).toHaveLength(1);
		expect(server.idle).toBe(0);
	});

	it('gives a request with a body a stream of its own that closes after the reply', async () => {
		const { server, streams } = rig(answers, { idleMs: 1000 });
		await text(get(server));
		const post = await server.serve(
			new Request('http://site.test/', { method: 'POST', body: 'abc' })
		);
		expect(await post.text()).toBe('s2r1');
		expect(streams).toHaveLength(2);
		expect(streams[1]!.received).toContain('connection: close');
		expect(streams[1]!.ended).toBe(true);
		expect(server.idle).toBe(1);
	});

	it('counts idle streams against the cap and ends the oldest to open another', async () => {
		const { server, streams } = rig(
			(s, n) => void (s.onRequest = () => s.send(n <= 2 ? reply('hello', 10) : reply('ok'))),
			{ idleMs: 1000, maxStreams: 2 }
		);
		const [a, b] = [await get(server), await get(server)];
		expect(streams).toHaveLength(2);
		for (const s of streams) s.send('world');
		await a.text();
		await b.text();
		expect(server.idle).toBe(2);
		const post = await server.serve(new Request('http://site.test/', { method: 'POST' }));
		await post.text();
		expect(streams).toHaveLength(3);
		expect(streams[0]!.ended).toBe(true);
		expect(streams[1]!.ended).toBe(false);
		expect(server.idle).toBe(1);
		expect(server.open).toBe(0);
	});

	it('still answers 503 at the cap when every stream is busy', async () => {
		const { server } = rig((s) => s.send(reply('hello', 10)), { idleMs: 1000 });
		await get(server);
		await get(server);
		expect((await get(server)).status).toBe(503);
		expect(server.idle).toBe(0);
	});
});

describe('Server.serve with stalled readers', () => {
	const head = 'HTTP/1.1 200 OK\r\ntransfer-encoding: chunked\r\n\r\n';
	const chunk = (text: string) => `${text.length.toString(16)}\r\n${text}\r\n`;

	/** advances fake time in small steps until `work` settles, as the machine's own timers would */
	async function run<T>(work: Promise<T>): Promise<T> {
		let settled = false;
		work.then(
			() => (settled = true),
			() => (settled = true)
		);
		while (!settled) await vi.advanceTimersByTimeAsync(10);
		return work;
	}

	async function started(limits: Partial<ServeLimits> = {}) {
		vi.useFakeTimers();
		const made = rig((s) => s.send(head + chunk('one')), { maxStreams: 1, ...limits });
		const res = await run(get(made.server));
		const reader = res.body!.getReader();
		expect(new TextDecoder().decode((await run(reader.read())).value)).toBe('one');
		return { ...made, reader };
	}

	it('closes a stream whose client has not read for 30 s and gives its slot to a new request', async () => {
		try {
			const { server, streams, reader } = await started({ stalledMs: 30_000 });
			expect(server.open).toBe(1);
			expect((await run(get(server))).status).toBe(503);
			await vi.advanceTimersByTimeAsync(29_000);
			expect(server.open).toBe(1);
			await vi.advanceTimersByTimeAsync(1_000);
			expect(server.open).toBe(0);
			expect(streams[0]!.aborted).toBe(true);
			await expect(reader.read()).rejects.toThrow('stopped reading');
			expect((await run(get(server))).status).not.toBe(503);
			expect(streams).toHaveLength(2);
		} finally {
			vi.useRealTimers();
		}
	});

	it('keeps a stream whose client pauses 29 s and reads again', async () => {
		try {
			const { server, streams, reader } = await started({ stalledMs: 30_000 });
			await vi.advanceTimersByTimeAsync(29_000);
			streams[0]!.send(chunk('two'));
			expect(new TextDecoder().decode((await run(reader.read())).value)).toBe('two');
			await vi.advanceTimersByTimeAsync(29_000);
			expect(server.open).toBe(1);
			expect(streams[0]!.aborted).toBe(false);
		} finally {
			vi.useRealTimers();
		}
	});

	it('does not cut a slow reader that keeps reading past 30 s in total', async () => {
		try {
			const { server, streams, reader } = await started({ stalledMs: 30_000 });
			for (let i = 0; i < 5; i++) {
				await vi.advanceTimersByTimeAsync(10_000);
				streams[0]!.send(chunk('x'));
				await run(reader.read());
			}
			expect(server.open).toBe(1);
			expect(streams[0]!.aborted).toBe(false);
		} finally {
			vi.useRealTimers();
		}
	});

	it('stops the timer once the body is read to its end', async () => {
		try {
			const { server, streams, reader } = await started({ stalledMs: 30_000 });
			streams[0]!.send('0\r\n\r\n');
			expect((await run(reader.read())).done).toBe(true);
			expect(server.open).toBe(0);
			await vi.advanceTimersByTimeAsync(60_000);
			expect(streams[0]!.aborted).toBe(false);
		} finally {
			vi.useRealTimers();
		}
	});
});
