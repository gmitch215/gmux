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
				case 'assets': {
					const name = url.searchParams.get('name') ?? 'a1m';
					const n = q('n', 5);
					const walls: number[] = [];
					let bytes = 0;
					for (let i = 0; i < n; i++) {
						const t0 = Date.now();
						const r = await this.env.ASSETS!.fetch(`https://assets.local/${name}.bin`);
						bytes += (await r.arrayBuffer()).byteLength;
						walls.push(Date.now() - t0);
					}
					return Response.json({ ...who, name, n, bytes, walls });
				}
				case 'assets-count': {
					const n = q('n', 1200);
					let ok = 0;
					let firstError: string | null = null;
					for (let i = 0; i < n; i++) {
						try {
							const r = await this.env.ASSETS!.fetch('https://assets.local/tiny.bin');
							await r.arrayBuffer();
							if (r.ok) ok++;
						} catch (error) {
							firstError ??= `at ${i}: ${String(error)}`;
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
