import { DurableObject } from 'cloudflare:workers';
import { createHash } from 'node:crypto';
import busybox from '../../../build/kernel/busybox.async.wasm';
import busyboxGuard from '../../../build/kernel/busybox.guard.wasm';
import initrd from '../../../build/kernel/initramfs.bin';
import katybug from '../../../build/kernel/katybug.wasm';
import manifest from '../../../build/kernel/manifest.json';
import vmlinux from '../../../build/kernel/vmlinux.async.wasm';
import type { BootstrapIndex } from '../../../src/worker/bootstrap';
import { placement, prime } from '../../../src/worker/placement';
import { restoreAndRun } from './rig';

interface Env {
	RIG: DurableObjectNamespace<Rig>;
	ASSETS: Fetcher;
	WARM?: string;
}

let isolate = '';
let served = 0;
let memory: WebAssembly.Memory | undefined;
let warmed = false;
let warmMs = 0;
let fetches = 0;

export class Rig extends DurableObject<Env> {
	private readonly instance = crypto.randomUUID();

	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env);
		ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT)');
	}

	private readonly meta = {
		get: (k: string) => {
			const row = this.ctx.storage.sql.exec('SELECT v FROM meta WHERE k = ?', k).toArray()[0];
			return row ? String(row.v) : null;
		},
		set: (k: string, v: string) =>
			void this.ctx.storage.sql.exec('INSERT OR REPLACE INTO meta (k, v) VALUES (?, ?)', k, v)
	};

	override async fetch(request: Request): Promise<Response> {
		try {
			return await this.serve(request);
		} catch (e) {
			return Response.json({ fetches, error: e instanceof Error ? e.message : String(e) }, { status: 500 });
		}
	}

	private async serve(request: Request): Promise<Response> {
		if (placement(this.meta, this.instance) === 'prime') {
			prime();
			return Response.json({ placing: true }, { status: 503 });
		}
		isolate ||= crypto.randomUUID();
		fetches = 0;
		const path = new URL(request.url).pathname;
		const build = { vmlinux, busybox, busyboxGuard, katybug, initrd: new Uint8Array(initrd), manifest };
		const load = async (dir: string) => {
			const asset = (file: string) =>
				(fetches++, this.env.ASSETS.fetch(new URL(`/${dir}/${file}`, 'https://assets.invalid')));
			return {
				index: (await (await asset('index.json')).json()) as BootstrapIndex,
				chunk: async (c: number) => new Uint8Array(await (await asset(`c${c}.bin`)).arrayBuffer())
			};
		};
		const host = () => ({
			sha256: (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex'),
			sleep: (ms: number) => scheduler.wait(ms),
			now: () => Date.now(),
			memory
		});
		// b warms on the first request of any kind, c only on the first restore
		const warm = this.env.WARM ?? 'a';
		if (!warmed && (warm === 'b' || (warm === 'c' && path !== '/ping'))) {
			warmed = true;
			const w0 = Date.now();
			const prompt = await load('prompt');
			const w = await restoreAndRun(
				build,
				prompt.index,
				prompt.chunk,
				host(),
				'DONE2',
				'seq 1 20000 | gzip -9 | wc -c; echo DONE$((1+1))\n'
			);
			memory = w.memory;
			warmMs = Date.now() - w0;
		}
		if (path === '/ping') return Response.json({ isolate, served, warm, warmMs, fetches });
		const job = await load('image');
		const n = ++served;
		const wall0 = Date.now();
		const r = await restoreAndRun(build, job.index, job.chunk, host());
		memory = r.memory;
		return Response.json({
			isolate,
			n,
			warm,
			warmMs,
			fetches,
			restoreMs: r.restoreMs,
			runMs: r.runMs,
			wallMs: Date.now() - wall0,
			tail: r.output.slice(-30)
		});
	}
}

export default {
	fetch: (request: Request, env: Env) =>
		env.RIG.get(env.RIG.idFromName('rig')).fetch(request)
};
