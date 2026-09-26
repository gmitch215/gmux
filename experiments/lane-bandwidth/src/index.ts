import { DurableObject } from 'cloudflare:workers';
import stream from './stream.wasm';

interface Env {
	LANE: DurableObjectNamespace<Lane>;
}

type Kernel = {
	memory: WebAssembly.Memory;
	fill(bytes: number): void;
	simd(bytes: number, passes: number): number;
	scalar(bytes: number, passes: number): bigint;
};

// the deployed clock stands still while code runs and catches up at the next await
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

export class Lane extends DurableObject<Env> {
	private readonly instance = crypto.randomUUID();
	private kernel: Kernel | null = null;
	private filled = 0;

	override async fetch(request: Request): Promise<Response> {
		const url = new URL(request.url);
		const mb = Number(url.searchParams.get('mb') ?? 16);
		const passes = Number(url.searchParams.get('passes') ?? 1);
		const kind = url.searchParams.get('kind') ?? 'simd';
		const bytes = mb * 2 ** 20;
		if (!this.kernel) {
			this.kernel = new WebAssembly.Instance(stream).exports as unknown as Kernel;
			// wasm has no on-stack replacement: small calls first, so the measured one runs optimized code
			this.kernel.fill(1 << 20);
			for (let i = 0; i < 200; i++) this.kernel.simd(1 << 16, 1), this.kernel.scalar(1 << 16, 1);
		}
		const k = this.kernel;
		let cold = false;
		if (this.filled < bytes) {
			k.fill(bytes);
			this.filled = bytes;
			cold = true;
		}
		await settle();
		const t0 = Date.now();
		const sum =
			kind === 'scalar' ? String(k.scalar(bytes, passes)) : kind === 'fill' ? (k.fill(bytes), '0') : String(k.simd(bytes, passes));
		await settle();
		const ms = Date.now() - t0;
		const moved = kind === 'fill' ? bytes : bytes * passes;
		return Response.json({
			instance: this.instance,
			kind,
			mb,
			passes,
			cold,
			ms,
			gbps: ms > 0 ? moved / ms / 1e6 : null,
			sum
		});
	}
}

export default {
	async fetch(request: Request, env: Env): Promise<Response> {
		const name = new URL(request.url).searchParams.get('do') ?? 'lane';
		return env.LANE.get(env.LANE.idFromName(name)).fetch(request);
	}
};
