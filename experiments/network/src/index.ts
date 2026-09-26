import { connect } from 'cloudflare:sockets';
import { DurableObject } from 'cloudflare:workers';

interface Env {
	PROBE: DurableObjectNamespace<Probe>;
	ASSETS?: Fetcher;
}

export class Probe extends DurableObject<Env> {
	private readonly instance = crypto.randomUUID();

	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env);
	}

	override async fetch(request: Request): Promise<Response> {
		const url = new URL(request.url);
		const q = (n: string, f: number) => Number(url.searchParams.get(n) ?? f);
		const op = url.pathname.slice(1);
		const who = { op, instance: this.instance };
		try {
			switch (op) {
				case 'net': {
					const out: Record<string, unknown> = {};
					const t0 = Date.now();
					const host = url.searchParams.get('host') ?? 'www.google.com';
					const req = new TextEncoder().encode(
						`GET / HTTP/1.1\r\nHost: ${host}\r\nConnection: close\r\n\r\n`
					);
					const firstLine = async (socket: ReturnType<typeof connect>) => {
						const w = socket.writable.getWriter();
						await w.write(req);
						const r = socket.readable.getReader();
						const chunk = await r.read();
						return new TextDecoder()
							.decode(chunk.value ?? new Uint8Array())
							.split('\r\n')[0];
					};
					const s = connect({ hostname: host, port: 80 });
					out.rawHttp = { status: await firstLine(s), ms: Date.now() - t0 };
					await s.close();
					const t1 = Date.now();
					const tls = connect({ hostname: host, port: 443 }, { secureTransport: 'on' });
					out.tls = { status: await firstLine(tls), ms: Date.now() - t1 };
					await tls.close();
					const t1b = Date.now();
					try {
						const smtp = connect(
							{ hostname: 'smtp.gmail.com', port: 587 },
							{ secureTransport: 'starttls' }
						);
						const lines = async (reader: ReadableStreamDefaultReader<Uint8Array>) =>
							new TextDecoder()
								.decode((await reader.read()).value ?? new Uint8Array())
								.trim();
						let reader = smtp.readable.getReader();
						let writer = smtp.writable.getWriter();
						const banner = await lines(reader);
						await writer.write(new TextEncoder().encode('EHLO gmux.local\r\n'));
						const ehlo = await lines(reader);
						await writer.write(new TextEncoder().encode('STARTTLS\r\n'));
						const ready = await lines(reader);
						reader.releaseLock();
						writer.releaseLock();
						const secure = smtp.startTls();
						reader = secure.readable.getReader();
						writer = secure.writable.getWriter();
						await writer.write(new TextEncoder().encode('EHLO gmux.local\r\n'));
						const ehlo2 = await lines(reader);
						out.smtpStartTls = {
							banner: banner.slice(0, 40),
							ehlo: ehlo.includes('STARTTLS'),
							ready: ready.slice(0, 30),
							afterTls: ehlo2.split('\r\n')[0],
							ms: Date.now() - t1b
						};
						await secure.close();
					} catch (error) {
						out.smtpStartTls = String(error);
					}
					const t2 = Date.now();
					const doh = await fetch(
						'https://cloudflare-dns.com/dns-query?name=example.com&type=A',
						{ headers: { accept: 'application/dns-json' } }
					);
					const answer = (await doh.json()) as { Answer?: { data: string }[] };
					out.doh = {
						status: doh.status,
						answers: answer.Answer?.map((a) => a.data),
						ms: Date.now() - t2
					};
					try {
						const c = connect({ hostname: 'cloudflare.com', port: 80 });
						await c.opened;
						out.cloudflareIp = 'connected';
						await c.close();
					} catch (error) {
						out.cloudflareIp = String(error);
					}
					return Response.json({ ...who, ...out });
				}
				case 'sock-cap': {
					const n = q('n', 60);
					const hold = url.searchParams.get('hold') === '1';
					const open: ReturnType<typeof connect>[] = [];
					let ok = 0;
					let firstError: string | null = null;
					for (let i = 0; i < n; i++) {
						try {
							const socket = connect({ hostname: 'www.google.com', port: 80 });
							await socket.opened;
							ok++;
							if (hold) open.push(socket);
							else await socket.close();
						} catch (error) {
							firstError = `at ${i}: ${String(error)}`;
							break;
						}
					}
					await Promise.all(open.map((s) => s.close()));
					return Response.json({ ...who, n, hold, ok, firstError });
				}
				case 'net-cap': {
					const n = q('n', 60);
					let ok = 0;
					let firstError: string | null = null;
					for (let i = 0; i < n; i++) {
						try {
							const r = await fetch(`https://www.google.com/generate_204?i=${i}`);
							await r.arrayBuffer();
							ok++;
						} catch (error) {
							firstError = `at ${i}: ${String(error)}`;
							break;
						}
					}
					return Response.json({ ...who, n, ok, firstError });
				}

				case 'who':
					return Response.json(who);
			}
			return new Response('unknown', { status: 404 });
		} catch (error) {
			return Response.json({ ...who, error: String(error) }, { status: 500 });
		}
	}
}

export default {
	async fetch(request: Request, env: Env): Promise<Response> {
		const url = new URL(request.url);
		return env.PROBE.get(env.PROBE.idFromName(url.searchParams.get('do') ?? 'default')).fetch(
			request
		);
	}
} satisfies ExportedHandler<Env>;
