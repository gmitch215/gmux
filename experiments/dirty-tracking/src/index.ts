import { DurableObject } from 'cloudflare:workers';
import storesModule from './wasm/stores.wasm';

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
				case 'stores': {
					const variant = url.searchParams.get('variant') ?? 'plain';
					const inst = new WebAssembly.Instance(storesModule, {});
					if (url.searchParams.has('mask'))
						(inst.exports.mask as WebAssembly.Global).value = q('mask', 0x1fffffc);
					const x = (inst.exports[variant] as (n: number) => number)(q('n', 2e8));
					return Response.json({ ...who, variant, n: q('n', 2e8), x });
				}
				case 'scan': {
					const mb = q('mb', 64);
					const kind = url.searchParams.get('kind') ?? 'compare';
					const a = new Uint32Array((mb << 20) / 4);
					const b = new Uint32Array((mb << 20) / 4);
					for (let i = 0; i < b.length; i += 16384 * 7) b[i] = 1;
					let changed = 0;
					if (kind === 'compare') {
						const words = 16384;
						for (let p = 0; p < a.length; p += words) {
							for (let i = p; i < p + words; i++) {
								if (a[i] !== b[i]) {
									changed++;
									break;
								}
							}
						}
					} else {
						for (let p = 0; p < a.length; p += 16384) {
							await crypto.subtle.digest('SHA-256', a.subarray(p, p + 16384));
							changed++;
						}
					}
					return Response.json({ ...who, mb, kind, pagesFlagged: changed });
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
