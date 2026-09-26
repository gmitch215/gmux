import { DurableObject } from 'cloudflare:workers';
import { connect } from 'cloudflare:sockets';

interface Env {
	SOCKET: DurableObjectNamespace<SocketDO>;
	CLIENT: DurableObjectNamespace<ClientDO>;
}

// not a Cloudflare address: Workers sockets refuse Cloudflare's own ranges
const HOST = 'dns.google';

/**
 * holds one TLS connection and sends DNS-over-HTTPS queries over it with HTTP/1.1 keep-alive. A socket
 * belongs to the request that opened it, so that request stays alive (ctx.waitUntil on a pump) and is
 * the only one that touches the socket; later requests queue their queries and wait for the answers
 */
export class SocketDO extends DurableObject<Env> {
	private readonly instance = crypto.randomUUID();
	private connection: { id: string; opened: number; queries: number } | null = null;
	private queue: { name: string; done: (r: object) => void }[] = [];
	private wake: (() => void) | null = null;
	private keepalive = 0;
	private keepalives = 0;

	private async pump(reader: ReadableStreamDefaultReader<Uint8Array>, writer: WritableStreamDefaultWriter) {
		const decoder = new TextDecoder();
		let buffered = new Uint8Array(0);
		const response = async (): Promise<string> => {
			for (;;) {
				const text = decoder.decode(buffered);
				const end = text.indexOf('\r\n\r\n');
				if (end >= 0) {
					const headers = text.slice(0, end);
					const head = new TextEncoder().encode(text.slice(0, end + 4)).length;
					const length = Number(headers.match(/content-length:\s*(\d+)/i)?.[1] ?? -1);
					if (length >= 0 && buffered.length >= head + length) {
						const body = decoder.decode(buffered.slice(head, head + length));
						buffered = buffered.slice(head + length);
						return body;
					}
					if (/transfer-encoding:\s*chunked/i.test(headers)) {
						// chunks: a hex size line, the data, CRLF; a zero-size chunk ends the body
						let at = head;
						let body = '';
						const bytes = buffered;
						for (;;) {
							const line = decoder.decode(bytes.slice(at, at + 16));
							const eol = line.indexOf('\r\n');
							if (eol < 0) break;
							const size = parseInt(line.slice(0, eol), 16);
							const start = at + eol + 2;
							if (bytes.length < start + size + 2) break;
							if (size === 0) {
								buffered = bytes.slice(start + 2);
								return body;
							}
							body += decoder.decode(bytes.slice(start, start + size));
							at = start + size + 2;
						}
					}
				}
				const { value, done } = await reader.read();
				if (done) throw new Error('connection closed');
				const joined = new Uint8Array(buffered.length + value.length);
				joined.set(buffered);
				joined.set(value, buffered.length);
				buffered = joined;
			}
		};
		for (;;) {
			while (!this.queue.length) {
				// a keepalive query when idle that long, as a long-lived protocol would send
				const idle = new Promise<void>((r) => (this.wake = r));
				if (!this.keepalive) await idle;
				else if ((await Promise.race([idle.then(() => 'woken'), new Promise((r) => setTimeout(() => r('idle'), this.keepalive))])) === 'idle')
					this.queue.push({ name: 'example.com', done: () => this.keepalives++ });
			}
			const job = this.queue.shift()!;
			const c = this.connection!;
			try {
				await writer.write(
					new TextEncoder().encode(
						`GET /resolve?name=${job.name}&type=A HTTP/1.1\r\nHost: ${HOST}\r\nAccept: application/dns-json\r\nConnection: keep-alive\r\n\r\n`
					)
				);
				const body = await response();
				c.queries++;
				job.done({ instance: this.instance, connection: c.id, queries: c.queries, keepalives: this.keepalives, ageSeconds: (Date.now() - c.opened) / 1000, answer: JSON.parse(body).Answer?.map((a: { data: string }) => a.data).sort() ?? [] });
			} catch (error) {
				job.done({ instance: this.instance, connection: c.id, error: String(error) });
				this.connection = null;
				return;
			}
		}
	}

	override async fetch(request: Request): Promise<Response> {
		const url = new URL(request.url);
		if (url.pathname === '/open') {
			const socket = connect({ hostname: HOST, port: 443 }, { secureTransport: 'on', allowHalfOpen: false });
			this.connection = { id: crypto.randomUUID(), opened: Date.now(), queries: 0 };
			this.keepalive = Number(url.searchParams.get('keepalive') ?? 0) * 1000;
			this.ctx.waitUntil(this.pump(socket.readable.getReader(), socket.writable.getWriter()));
			return Response.json({ instance: this.instance, connection: this.connection.id });
		}
		if (!this.connection) return Response.json({ instance: this.instance, error: 'no connection' });
		const name = url.searchParams.get('name') ?? 'example.com';
		const answer = await new Promise<object>((done) => {
			this.queue.push({ name, done });
			this.wake?.();
		});
		return Response.json(answer);
	}
}

/** the machine's stand-in: it keeps what it learned in storage and can be evicted at any point */
export class ClientDO extends DurableObject<Env> {
	private readonly instance = crypto.randomUUID();

	override async fetch(request: Request): Promise<Response> {
		const url = new URL(request.url);
		if (url.pathname === '/evict') {
			this.ctx.abort('the machine loses residency');
			return new Response('unreachable');
		}
		const socket = this.env.SOCKET.get(this.env.SOCKET.idFromName(url.searchParams.get('socket')!));
		const r = (await (await socket.fetch(`https://s/query?name=${url.searchParams.get('name')}`)).json()) as object;
		const log = ((await this.ctx.storage.get<object[]>('log')) ?? []).concat([{ client: this.instance, ...r }]);
		await this.ctx.storage.put('log', log);
		return Response.json({ client: this.instance, ...r });
	}
}

export default {
	async fetch(request: Request, env: Env): Promise<Response> {
		const url = new URL(request.url);
		if (url.pathname === '/open') return env.SOCKET.get(env.SOCKET.idFromName(url.searchParams.get('socket')!)).fetch(request);
		return env.CLIENT.get(env.CLIENT.idFromName(url.searchParams.get('client')!)).fetch(request);
	}
};
