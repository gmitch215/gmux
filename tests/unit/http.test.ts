import { describe, expect, it } from 'vitest';
import {
	BadGateway,
	MAX_HEAD,
	parseHead,
	requestBytes,
	responseFrom
} from '../../src/worker/machine/http.ts';

const encode = (text: string) => new TextEncoder().encode(text);

function source(...parts: (string | Uint8Array)[]): ReadableStream<Uint8Array> {
	let at = 0;
	return new ReadableStream({
		pull(controller) {
			if (at === parts.length) return controller.close();
			const part = parts[at++]!;
			controller.enqueue(typeof part === 'string' ? encode(part) : part);
		}
	});
}

/** the bytes of `text` one at a time, the worst split a parser can get */
const bytewise = (text: string) => [...text].map((c) => c);

async function collect(request: Request): Promise<string> {
	let text = '';
	for await (const chunk of requestBytes(request)) text += new TextDecoder().decode(chunk);
	return text;
}

describe('requestBytes', () => {
	it('writes a GET as an origin-form request that closes after its response', async () => {
		const text = await collect(
			new Request('http://site.test/a/b?x=1', { headers: { 'x-extra': 'yes' } })
		);
		expect(text.startsWith('GET /a/b?x=1 HTTP/1.1\r\n')).toBe(true);
		expect(text).toContain('x-extra: yes\r\n');
		expect(text).toContain('host: site.test\r\n');
		expect(text.endsWith('connection: close\r\n\r\n')).toBe(true);
	});

	it('drops hop-by-hop headers, the ones the connection names, and expect', async () => {
		const text = await collect(
			new Request('http://site.test/', {
				headers: {
					connection: 'keep-alive, x-private',
					'keep-alive': 'timeout=5',
					'x-private': 'secret',
					te: 'trailers',
					upgrade: 'websocket',
					expect: '100-continue',
					'x-kept': 'ok'
				}
			})
		);
		for (const dropped of ['keep-alive', 'x-private', 'te:', 'upgrade', 'expect'])
			expect(text.toLowerCase()).not.toContain(dropped === 'te:' ? 'te:' : `${dropped}:`);
		expect(text).toContain('x-kept: ok');
	});

	it('keeps the browser cookie and authorization away from the guest', async () => {
		const text = await collect(
			new Request('http://site.test/', {
				headers: { cookie: 'a=1', authorization: 'Bearer t', 'x-kept': 'ok' }
			})
		);
		expect(text.toLowerCase()).not.toContain('cookie');
		expect(text.toLowerCase()).not.toContain('authorization');
		expect(text).toContain('x-kept: ok');
	});

	it('sends a body under its Content-Length as it came', async () => {
		const text = await collect(
			new Request('http://site.test/up', {
				method: 'POST',
				body: 'abcdef',
				headers: { 'content-length': '6' }
			})
		);
		expect(text).toContain('content-length: 6\r\n');
		expect(text).not.toContain('transfer-encoding');
		expect(text.endsWith('\r\n\r\nabcdef')).toBe(true);
	});

	it('frames a body of unknown length as chunks', async () => {
		const body = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(encode('hello'));
				controller.enqueue(encode('0123456789abcdef'));
				controller.close();
			}
		});
		const text = await collect(
			new Request('http://site.test/up', {
				method: 'POST',
				body,
				// @ts-expect-error duplex is a Node and workerd request option
				duplex: 'half'
			})
		);
		expect(text).toContain('transfer-encoding: chunked\r\n');
		expect(text.endsWith('\r\n\r\n5\r\nhello\r\n10\r\n0123456789abcdef\r\n0\r\n\r\n')).toBe(
			true
		);
	});

	it('gives a POST with no body a zero length', async () => {
		const text = await collect(new Request('http://site.test/', { method: 'POST' }));
		expect(text).toContain('content-length: 0\r\n');
	});
});

describe('parseHead', () => {
	const head = (text: string, method = 'GET') => parseHead(encode(text), method);

	it('reads the status, the reason and the headers, repeated ones kept', () => {
		const parsed = head(
			'HTTP/1.1 404 Not Found\r\nX-Dup: a\r\nX-Dup: b\r\nX-Gap:   spaced  \r\n\r\n'
		);
		expect(parsed).toMatchObject({ status: 404, statusText: 'Not Found' });
		expect(parsed.headers.get('x-dup')).toBe('a, b');
		expect(parsed.headers.get('x-gap')).toBe('spaced');
	});

	it('accepts a head whose lines end in a bare LF, as a script writes its own headers', () => {
		const parsed = head('HTTP/1.1 200 OK\r\nServer: httpd\nContent-Type: text/plain\n\n');
		expect(parsed.headers.get('content-type')).toBe('text/plain');
	});

	it('strips the hop-by-hop fields and those the response names', () => {
		const parsed = head(
			'HTTP/1.1 200 OK\r\nConnection: close, x-private\r\nKeep-Alive: 1\r\nX-Private: a\r\nX-Kept: b\r\n\r\n'
		);
		expect([...parsed.headers.keys()]).toEqual(['content-security-policy', 'x-kept']);
	});

	it('sandboxes a guest page and drops its cookies and storage wipes, whatever else it sends', () => {
		const parsed = head(
			'HTTP/1.1 200 OK\r\nSet-Cookie: a=1\r\nSet-Cookie: b=2\r\nClear-Site-Data: "storage"\r\nContent-Security-Policy: default-src none\r\n\r\n'
		);
		expect(parsed.headers.getSetCookie()).toEqual([]);
		expect(parsed.headers.has('clear-site-data')).toBe(false);
		const policies = parsed.headers.get('content-security-policy')!.split(', ');
		expect(policies).toContain('sandbox allow-scripts allow-forms');
		expect(policies).toContain('default-src none');
		expect(policies.join(' ')).not.toContain('allow-same-origin');
		expect(head('HTTP/1.1 200 OK\r\n\r\n').headers.get('content-security-policy')).toBe(
			'sandbox allow-scripts allow-forms'
		);
	});

	it('frames by Content-Length, chunked, or the close, and a body-less status by nothing', () => {
		expect(head('HTTP/1.1 200 OK\r\nContent-Length: 12\r\n\r\n').framing).toEqual({
			kind: 'length',
			left: 12
		});
		const chunked = head(
			'HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\nContent-Length: 5\r\n\r\n'
		);
		expect(chunked.framing).toEqual({ kind: 'chunked' });
		expect(chunked.headers.has('content-length')).toBe(false);
		expect(head('HTTP/1.1 200 OK\r\n\r\n').framing).toEqual({ kind: 'close' });
		expect(head('HTTP/1.1 204 No Content\r\nContent-Length: 4\r\n\r\n').framing.kind).toBe(
			'none'
		);
		expect(head('HTTP/1.1 304 Not Modified\r\n\r\n').framing.kind).toBe('none');
		const headResponse = head('HTTP/1.1 200 OK\r\nContent-Length: 4\r\n\r\n', 'HEAD');
		expect(headResponse.framing.kind).toBe('none');
		expect(headResponse.headers.get('content-length')).toBe('4');
	});

	it.each([
		['a status line that is not HTTP', 'FTP/1.1 200 OK\r\n\r\n'],
		['a status without three digits', 'HTTP/1.1 20 OK\r\n\r\n'],
		['a header with no name', 'HTTP/1.1 200 OK\r\n: x\r\n\r\n'],
		['a header name with a space', 'HTTP/1.1 200 OK\r\nBad Name: x\r\n\r\n'],
		['a header line with no colon', 'HTTP/1.1 200 OK\r\nnocolon\r\n\r\n'],
		['two different lengths', 'HTTP/1.1 200 OK\r\nContent-Length: 1, 2\r\n\r\n'],
		['a length that is not digits', 'HTTP/1.1 200 OK\r\nContent-Length: 1e3\r\n\r\n'],
		[
			'a transfer coding that does not end in chunked',
			'HTTP/1.1 200 OK\r\nTransfer-Encoding: gzip\r\n\r\n'
		]
	])('refuses %s', (_, text) => {
		expect(() => head(text)).toThrow(BadGateway);
	});

	it('refuses a header value Response would not accept', () => {
		expect(() => head('HTTP/1.1 200 OK\r\nX-Bad: a\u0000b\r\n\r\n')).toThrow(BadGateway);
	});
});

describe('responseFrom', () => {
	async function read(response: Response) {
		return await response.text();
	}

	it('streams a Content-Length body and tells the caller it ended cleanly', async () => {
		const done: boolean[] = [];
		const response = await responseFrom(
			source('HTTP/1.1 200 OK\r\nContent-Length: 11\r\n\r\nhello', ' world', 'EXTRA'),
			'GET',
			(clean) => done.push(clean)
		);
		expect(response.status).toBe(200);
		expect(response.headers.get('content-length')).toBe('11');
		expect(await read(response)).toBe('hello world');
		expect(done).toEqual([true]);
	});

	it('de-chunks a body however the bytes are split', async () => {
		const wire =
			'HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n5;ext=1\r\nhello\r\n6\r\n world\r\n0\r\nTrailer: x\r\n\r\n';
		for (const parts of [[wire], bytewise(wire)]) {
			const response = await responseFrom(source(...parts), 'GET');
			expect(response.headers.has('transfer-encoding')).toBe(false);
			expect(await read(response)).toBe('hello world');
		}
	});

	it('reads a body that runs to the close, and a head split across reads', async () => {
		const response = await responseFrom(
			source('HTTP/1.1 200 OK\r\nX-A: 1\r', '\n\r\nuntil ', 'the close'),
			'GET'
		);
		expect(response.headers.get('x-a')).toBe('1');
		expect(await read(response)).toBe('until the close');
	});

	it('reads a script reply whose headers end in a bare LF', async () => {
		const response = await responseFrom(
			source('HTTP/1.1 200 OK\r\nConnection: close\r\nContent-Type: text/plain\n\n1\n2\n'),
			'GET'
		);
		expect(await read(response)).toBe('1\n2\n');
	});

	it('gives HEAD, 204 and 304 no body and closes the source at once', async () => {
		for (const [method, wire] of [
			['HEAD', 'HTTP/1.1 200 OK\r\nContent-Length: 9\r\n\r\n'],
			['GET', 'HTTP/1.1 204 No Content\r\n\r\n'],
			['GET', 'HTTP/1.1 304 Not Modified\r\nETag: "x"\r\n\r\n']
		] as const) {
			const done: boolean[] = [];
			const response = await responseFrom(source(wire + 'ignored'), method, (c) =>
				done.push(c)
			);
			expect(response.body).toBeNull();
			expect(done).toEqual([true]);
		}
	});

	it('gives a zero-length body none either', async () => {
		const response = await responseFrom(
			source('HTTP/1.1 200 OK\r\nContent-Length: 0\r\n\r\n'),
			'GET'
		);
		expect(response.body).toBeNull();
	});

	it('skips an interim 100 and answers the response after it', async () => {
		const response = await responseFrom(
			source(
				'HTTP/1.1 100 Continue\r\n\r\nHTTP/1.1 201 Created\r\nContent-Length: 2\r\n\r\nok'
			),
			'POST'
		);
		expect(response.status).toBe(201);
		expect(await read(response)).toBe('ok');
	});

	it('errors the body that the machine cut short, after its head has gone out', async () => {
		const done: boolean[] = [];
		const response = await responseFrom(
			source('HTTP/1.1 200 OK\r\nContent-Length: 20\r\n\r\nonly ten b'),
			'GET',
			(clean) => done.push(clean)
		);
		await expect(read(response)).rejects.toThrow('closed mid-body');
		expect(done).toEqual([false]);
		const chunked = await responseFrom(
			source('HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n5\r\nhel'),
			'GET'
		);
		await expect(read(chunked)).rejects.toThrow('closed mid-body');
	});

	it('errors a chunked body with bad framing', async () => {
		const response = await responseFrom(
			source('HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\nzz\r\nhello\r\n'),
			'GET'
		);
		await expect(read(response)).rejects.toThrow(BadGateway);
	});

	it('is a bad gateway for a head over 64 KiB, a close before any reply, and a refused response', async () => {
		const done: boolean[] = [];
		await expect(
			responseFrom(
				source('HTTP/1.1 200 OK\r\nX-Big: ' + 'a'.repeat(MAX_HEAD)),
				'GET',
				(clean) => done.push(clean)
			)
		).rejects.toThrow('head too long');
		expect(done).toEqual([false]);
		await expect(responseFrom(source(), 'GET')).rejects.toThrow('closed before a response');
		await expect(responseFrom(source('HTTP/1.1 600 Odd\r\n\r\n'), 'GET')).rejects.toThrow(
			BadGateway
		);
		await expect(
			responseFrom(source('HTTP/1.1 101 Switching\r\nUpgrade: websocket\r\n\r\n'), 'GET')
		).rejects.toThrow('upgrades');
	});

	it('tells the caller when the reader leaves mid-body', async () => {
		const done: boolean[] = [];
		const response = await responseFrom(
			source('HTTP/1.1 200 OK\r\nContent-Length: 100\r\n\r\nabc', 'def'),
			'GET',
			(clean) => done.push(clean)
		);
		await response.body!.cancel();
		expect(done).toEqual([false]);
	});
});
