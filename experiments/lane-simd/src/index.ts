import { DurableObject } from 'cloudflare:workers';
import kernels from './kernels.wasm';
import { prepare, type Kernels } from './work';

interface Env {
	LANE: DurableObjectNamespace<Lane>;
}

export class Lane extends DurableObject<Env> {
	private readonly instance = crypto.randomUUID();
	private k: Kernels | null = null;

	override async fetch(request: Request): Promise<Response> {
		const url = new URL(request.url);
		const kernel = (url.searchParams.get('k') ?? 'sgemm') as 'sgemm' | 'dot8' | 'conv3';
		const reps = Number(url.searchParams.get('reps') ?? 1);
		this.k ??= prepare(kernels);
		const result = reps ? this.k[kernel](reps) : 0;
		return Response.json({ instance: this.instance, kernel, reps, result });
	}
}

export default {
	async fetch(request: Request, env: Env): Promise<Response> {
		const name = new URL(request.url).searchParams.get('do') ?? 'lane';
		return env.LANE.get(env.LANE.idFromName(name)).fetch(request);
	}
};
