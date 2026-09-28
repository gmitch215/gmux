import { DurableObject } from 'cloudflare:workers';
import funcref from './funcref.bin';
import hint from './hint.bin';
import { jsLoop } from './js';
import mem32 from './mem32.bin';
import mem64 from './mem64.bin';
import multi from './multi.bin';
import relaxed from './relaxed.bin';
import single from './single.bin';
import tail from './tail.bin';

/**
 * Which wasm features the deployed runtime takes, and what each buys. Every module compiles at
 * startup on its own (compiling is refused at request time), so a feature the runtime lacks shows
 * as that module's error. `/features` reports them with what the platform says about itself;
 * `/run?m=<module>&f=<export>&n=<count>` runs one arm once, and its CPU comes from wrangler tail;
 * `/burn?n=` spends a new object's first placement before anything is measured.
 */
const bytes: Record<string, ArrayBuffer> = { tail, hint, mem32, mem64, multi, single, relaxed, funcref };
const modules: Record<string, WebAssembly.Module | string> = {};
for (const [name, b] of Object.entries(bytes)) {
	try {
		modules[name] = new WebAssembly.Module(b);
	} catch (e) {
		modules[name] = String(e);
	}
}

interface Env {
	PROBE: DurableObjectNamespace<ProbeDO>;
}

export class ProbeDO extends DurableObject<Env> {
	private readonly instance = crypto.randomUUID();
	private readonly instances = new Map<string, WebAssembly.Exports>();

	private exports(name: string): WebAssembly.Exports {
		let e = this.instances.get(name);
		if (!e) {
			const m = modules[name];
			if (!(m instanceof WebAssembly.Module)) throw new Error(`${name}: ${m ?? 'no such module'}`);
			e = new WebAssembly.Instance(m).exports;
			(e.init as (() => void) | undefined)?.();
			this.instances.set(name, e);
		}
		return e;
	}

	override async fetch(request: Request): Promise<Response> {
		const url = new URL(request.url);
		if (url.pathname === '/features') {
			const g = globalThis as { process?: { versions?: unknown }; navigator?: { userAgent?: string } };
			return Response.json({
				instance: this.instance,
				modules: Object.fromEntries(
					Object.entries(modules).map(([k, v]) => [k, v instanceof WebAssembly.Module ? 'ok' : v])
				),
				userAgent: g.navigator?.userAgent ?? null,
				versions: g.process?.versions ?? null,
				jspi: typeof (WebAssembly as { Suspending?: unknown }).Suspending === 'function'
			});
		}
		if (url.pathname === '/burn') {
			let x = 0;
			const n = Number(url.searchParams.get('n') ?? 3e8);
			for (let i = 0; i < n; i++) x = (x * 31 + i) | 0;
			return Response.json({ instance: this.instance, x });
		}
		if (url.pathname === '/run') {
			const m = url.searchParams.get('m')!;
			const f = m === 'js' ? jsLoop : (this.exports(m)[url.searchParams.get('f')!] as (n: number) => unknown);
			const result = f(Number(url.searchParams.get('n')));
			return Response.json({ instance: this.instance, result: String(result) });
		}
		return new Response('not found', { status: 404 });
	}
}

export default {
	fetch(request: Request, env: Env): Promise<Response> {
		return env.PROBE.get(env.PROBE.idFromName('probe')).fetch(request);
	}
} satisfies ExportedHandler<Env>;
