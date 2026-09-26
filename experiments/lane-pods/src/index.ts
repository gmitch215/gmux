import { DurableObject } from 'cloudflare:workers';
import stream from './stream.wasm';

interface Env {
	LANE: DurableObjectNamespace<Lane>;
	POD: DurableObjectNamespace<Pod>;
}

type Kernel = { fill(bytes: number): void; simd(bytes: number, passes: number): number };

// one per isolate, set on first use (random values are refused at module scope): lanes that report
// the same value share an isolate and its single thread
let ISOLATE = '';
type LaneResult = { lane: string; colo?: string; sum?: number; error?: string };

/** a lane: the sequential SIMD read over its own 16 MiB, and a ping and an echo for lane-to-lane tests */
export class Lane extends DurableObject<Env> {
	private kernel: Kernel | null = null;
	private colo = '';

	override async fetch(request: Request): Promise<Response> {
		const url = new URL(request.url);
		if (url.pathname === '/ping') return new Response('pong');
		if (url.pathname === '/bw') {
			if (!this.kernel) {
				this.kernel = new WebAssembly.Instance(stream).exports as unknown as Kernel;
				this.kernel.fill(16 << 20);
				for (let i = 0; i < 100; i++) this.kernel.simd(1 << 16, 1);
			}
			const passes = Number(url.searchParams.get('passes') ?? 16);
			ISOLATE ||= crypto.randomUUID();
			return Response.json({ isolate: ISOLATE, sum: this.kernel.simd(16 << 20, passes) });
		}
		if (url.pathname === '/echo') return new Response(String((await request.arrayBuffer()).byteLength));
		if (url.pathname === '/peer') {
			// latency and a 1 MiB transfer to another lane, timed across the awaited subrequests
			const peer = this.env.LANE.get(this.env.LANE.idFromName(url.searchParams.get('peer')!));
			const pings: number[] = [];
			for (let i = 0; i < 10; i++) {
				const t0 = Date.now();
				await (await peer.fetch('https://lane/ping')).text();
				pings.push(Date.now() - t0);
			}
			const body = new Uint8Array(1 << 20);
			const t0 = Date.now();
			await (await peer.fetch('https://lane/echo', { method: 'POST', body })).text();
			const ms = Date.now() - t0;
			return Response.json({ pingMs: pings.sort((a, b) => a - b)[5], megabytePerSecond: ms ? +(1000 / ms).toFixed(1) : null });
		}
		if (!this.kernel) {
			this.kernel = new WebAssembly.Instance(stream).exports as unknown as Kernel;
			this.kernel.fill(16 << 20);
			const trace = await (await fetch('https://www.cloudflare.com/cdn-cgi/trace')).text();
			this.colo = trace.match(/colo=(\w+)/)?.[1] ?? '?';
		}
		return Response.json({ lane: url.searchParams.get('name'), colo: this.colo, sum: this.kernel.simd(16 << 20, 4) });
	}
}

async function fan(env: Env, lanes: string[]): Promise<LaneResult[]> {
	return Promise.all(
		lanes.map(async (name) => {
			try {
				const r = await env.LANE.get(env.LANE.idFromName(name)).fetch(`https://lane/work?name=${name}`);
				return (await r.json()) as LaneResult;
			} catch (error) {
				return { lane: name, error: String(error).slice(0, 120) };
			}
		})
	);
}

/** a pod: fans one request out to its lanes and answers with their results */
export class Pod extends DurableObject<Env> {
	override async fetch(request: Request): Promise<Response> {
		const url = new URL(request.url);
		const lanes = url.searchParams.get('lanes')!.split(',');
		if (url.pathname === '/bw') return Response.json(await readLanes(this.env, lanes, Number(url.searchParams.get('passes'))));
		return Response.json(await fan(this.env, lanes));
	}
}

/** the sequential read on the named lanes at once; each lane reports its isolate's nonce */
async function readLanes(env: Env, lanes: string[], passes: number) {
	const t0 = Date.now();
	return Promise.all(
		lanes.map(async (name) => {
			try {
				const r = await env.LANE.get(env.LANE.idFromName(name)).fetch(`https://lane/bw?passes=${passes}`);
				return { isolate: ((await r.json()) as { isolate: string }).isolate, ms: Date.now() - t0 };
			} catch (error) {
				return { error: String(error).slice(0, 100), ms: Date.now() - t0 };
			}
		})
	);
}

/**
 * the sequential read on n lanes at once, dispatched by this Worker (pod = 0) or by pods of that
 * many lanes; timed across the awaited subrequests, since the deployed clock moves on I/O
 */
async function bandwidth(env: Env, n: number, passes: number, run: string, pod: number) {
	const t0 = Date.now();
	const names = Array.from({ length: n }, (_, i) => `${run}-bw-${i}`);
	let lanes: { isolate?: string; error?: string; ms: number }[];
	if (!pod) lanes = await readLanes(env, names, passes);
	else {
		const groups: string[][] = [];
		for (let i = 0; i < n; i += pod) groups.push(names.slice(i, i + pod));
		lanes = (
			await Promise.all(
				groups.map(async (group, i) => {
					try {
						const r = await env.POD.get(env.POD.idFromName(`${run}-bwpod-${i}`)).fetch(`https://pod/bw?passes=${passes}&lanes=${group.join(',')}`);
						return (await r.json()) as { isolate?: string; error?: string; ms: number }[];
					} catch (error) {
						return group.map(() => ({ error: String(error).slice(0, 100), ms: 0 }));
					}
				})
			)
		).flat();
	}
	return { n, pod, passes, wallMs: Date.now() - t0, lanes };
}

export default {
	async fetch(request: Request, env: Env): Promise<Response> {
		const url = new URL(request.url);
		if (url.pathname === '/bw')
			return Response.json(
				await bandwidth(env, Number(url.searchParams.get('n')), Number(url.searchParams.get('passes') ?? 16), url.searchParams.get('run') ?? 'r', Number(url.searchParams.get('pod') ?? 0))
			);
		if (url.pathname === '/peer') return env.LANE.get(env.LANE.idFromName(url.searchParams.get('lane')!)).fetch(request);
		const n = Number(url.searchParams.get('n') ?? 32);
		const size = Number(url.searchParams.get('pod') ?? 0);
		const run = url.searchParams.get('run') ?? 'r';
		const lanes = Array.from({ length: n }, (_, i) => `${run}-lane-${i}`);
		const t0 = Date.now();
		let results: LaneResult[];
		if (!size) results = await fan(env, lanes);
		else {
			const pods: string[][] = [];
			for (let i = 0; i < n; i += size) pods.push(lanes.slice(i, i + size));
			results = (
				await Promise.all(
					pods.map(async (group, i) => {
						try {
							const r = await env.POD.get(env.POD.idFromName(`${run}-pod-${i}`)).fetch(`https://pod/fan?lanes=${group.join(',')}`);
							return (await r.json()) as LaneResult[];
						} catch (error) {
							return group.map((lane) => ({ lane, error: String(error).slice(0, 120) }));
						}
					})
				)
			).flat();
		}
		const ms = Date.now() - t0;
		const errors = results.filter((r) => r.error);
		const colos = [...new Set(results.map((r) => r.colo).filter(Boolean))];
		return Response.json({ n, pod: size, ms, ok: results.length - errors.length, errors: errors.length, firstError: errors[0]?.error, colos });
	}
};
