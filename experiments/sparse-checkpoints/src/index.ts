import { DurableObject } from 'cloudflare:workers';
import imageBytes from './content.bin';

interface Env {
	PROBE: DurableObjectNamespace<Probe>;
	ASSETS?: Fetcher;
}

export class Probe extends DurableObject<Env> {
	private readonly instance = crypto.randomUUID();
	private image: Uint8Array | null = null;
	private imageContent = '';

	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env);
		ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS ckpt (k INTEGER PRIMARY KEY, v BLOB)');
	}

	override async fetch(request: Request): Promise<Response> {
		const url = new URL(request.url);
		const q = (n: string, f: number) => Number(url.searchParams.get(n) ?? f);
		const op = url.pathname.slice(1);
		const who = { op, instance: this.instance };
		try {
			switch (op) {
				case 'ckpt': {
					const mb = q('mb', 32);
					const blob = q('blob', 2 << 20);
					const mode = url.searchParams.get('mode') ?? 'full';
					const dirty = q('dirty', 0.05);
					const content = url.searchParams.get('content') ?? 'binary';
					if (
						!this.image ||
						this.image.byteLength !== mb << 20 ||
						this.imageContent !== content
					) {
						this.image = new Uint8Array(mb << 20);
						this.imageContent = content;
						if (content === 'random') {
							for (let i = 0; i < this.image.length; i += 65536)
								crypto.getRandomValues(this.image.subarray(i, i + 65536));
						} else if (content === 'binary') {
							// kernel and busybox bytes over the first 3/4, zero pages above (a booted image has free memory)
							const raw = new Uint8Array(imageBytes);
							for (let i = 0; i < (this.image.length * 3) / 4; i += raw.length)
								this.image.set(
									raw.subarray(
										0,
										Math.min(raw.length, (this.image.length * 3) / 4 - i)
									),
									i
								);
						}
					}
					this.ctx.storage.sql.exec('DELETE FROM ckpt');
					const pages = this.image.length >> 16;
					const pick: number[] = [];
					if (mode === 'sparse' || mode === 'sparse-deflate') {
						for (let p = 0; p < pages; p++) if (Math.random() < dirty) pick.push(p);
					} else for (let p = 0; p < pages; p++) pick.push(p);
					let current: number[] = [];
					let stored = 0;
					let rows = 0;
					const flush = async () => {
						if (!current.length) return;
						const out = new Uint8Array(4 + current.length * 4 + current.length * 65536);
						const view = new DataView(out.buffer);
						view.setUint32(0, current.length, true);
						current.forEach((p, i) => {
							view.setUint32(4 + i * 4, p, true);
							out.set(
								this.image!.subarray(p << 16, (p + 1) << 16),
								4 + current.length * 4 + i * 65536
							);
						});
						current = [];
						let data = out;
						if (mode.endsWith('deflate')) {
							const stream = new Blob([out])
								.stream()
								.pipeThrough(new CompressionStream('deflate-raw'));
							data = new Uint8Array(await new Response(stream).arrayBuffer());
						}
						this.ctx.storage.sql.exec(
							'INSERT INTO ckpt (k, v) VALUES (?, ?)',
							rows++,
							data
						);
						stored += data.byteLength;
					};
					for (const p of pick) {
						current.push(p);
						if ((current.length + 1) * 65536 + 4 * (current.length + 1) + 4 > blob)
							await flush();
					}
					await flush();
					await this.ctx.storage.sync();
					return Response.json({
						...who,
						mb,
						mode,
						content,
						blob,
						dirtyPages: pick.length,
						rows,
						rawBytes: pick.length * 65536,
						stored
					});
				}
				case 'restore': {
					const t0 = Date.now();
					let rows = 0;
					let bytes = 0;
					for (const row of this.ctx.storage.sql.exec('SELECT v FROM ckpt ORDER BY k')) {
						let data = new Uint8Array(row.v as ArrayBuffer);
						if (url.searchParams.get('mode')?.endsWith('deflate')) {
							const stream = new Blob([data])
								.stream()
								.pipeThrough(new DecompressionStream('deflate-raw'));
							data = new Uint8Array(await new Response(stream).arrayBuffer());
						}
						rows++;
						bytes += data.byteLength;
					}
					return Response.json({ ...who, rows, bytes, wallMs: Date.now() - t0 });
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
