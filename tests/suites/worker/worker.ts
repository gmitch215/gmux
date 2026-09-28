import { DurableObject } from 'cloudflare:workers';
import { createHash } from 'node:crypto';
import busybox from '../../../build/kernel/busybox.wasm';
import katybug from '../../../build/kernel/katybug.wasm';
import manifest from '../../../build/kernel/manifest.json';
import vmlinux from '../../../build/kernel/vmlinux.wasm';
import { Machine } from '../../../src/worker/machine/machine';
import { placement, prime } from '../../../src/worker/placement';

/**
 * The deployed side of the upstream suite runner (tests/suites/*-gmux.ts): a Durable Object per
 * `?do=` name runs one machine booted from build/kernel and the suite's initramfs (a static asset
 * staged by tests/suites/stage.ts). `/boot?pages=` boots it, `/exec?cmd=&until=&wall=` types a line
 * and runs until the output since then holds `until` or `wall` ms pass, `/abort` drops it. Every
 * answer names the object's instance, so a client sees a machine the platform took away
 */
interface Env {
	MACHINE: DurableObjectNamespace<SuiteMachine>;
	ASSETS: Fetcher;
}

const CMDLINE = 'maxcpus=3 root=/dev/ram0 rootfstype=ramfs init=/init console=hvc console=ttyS0';
let initrd: Promise<Uint8Array> | null = null;

export class SuiteMachine extends DurableObject<Env> {
	private readonly instance = crypto.randomUUID();
	private machine: Machine | null = null;
	private output = '';

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

	private async run(mark: number, until: string | null, wallMs: number) {
		const started = Date.now();
		const outcome = await this.machine!.run(
			() =>
				(until !== null
					? this.output.slice(mark).includes(until)
					: /[#$] $/.test(this.output)) || Date.now() - started > wallMs,
			(ms) => scheduler.wait(Math.min(ms, 50))
		);
		return { outcome, wallMs: Date.now() - started, out: this.output.slice(mark) };
	}

	override async fetch(request: Request): Promise<Response> {
		const url = new URL(request.url);
		const who = { instance: this.instance };
		const q = (k: string, d: string) => url.searchParams.get(k) ?? d;
		// a new object is replaced after its first ~1 s of CPU; spend it before a machine exists
		if (placement(this.meta, this.instance) === 'prime') {
			prime();
			return Response.json({ placing: true, ...who }, { status: 503 });
		}
		switch (url.pathname) {
			case '/boot': {
				if (!this.machine) {
					initrd ??= this.env.ASSETS.fetch('https://assets/initramfs.bin')
						.then((r) => r.arrayBuffer())
						.then((b) => new Uint8Array(b));
					this.machine = new Machine({
						vmlinux,
						initrd: await initrd,
						cmdline: CMDLINE,
						registry: new Map([
							[manifest.busybox, busybox],
							[manifest.katybug!, katybug]
						]),
						maximumPages: Number(q('pages', '2400')),
						sharedKernel: true,
						sha256: (bytes) => createHash('sha256').update(bytes).digest('hex'),
						write: (text) => (this.output += text)
					});
				}
				return Response.json({
					...(await this.run(0, null, Number(q('wall', '20000')))),
					...who
				});
			}
			case '/exec': {
				if (!this.machine) return Response.json({ lost: true, ...who }, { status: 409 });
				const mark = this.output.length;
				const cmd = url.searchParams.get('cmd');
				if (cmd) this.machine.type(`${cmd}\n`);
				const r = await this.run(
					mark,
					url.searchParams.get('until'),
					Number(q('wall', '20000'))
				);
				return Response.json({ ...r, stats: this.machine.stats, ...who });
			}
			case '/abort':
				this.machine = null;
				this.output = '';
				return Response.json({ aborted: true, ...who });
		}
		return new Response('not found', { status: 404 });
	}
}

export default {
	fetch(request: Request, env: Env): Promise<Response> {
		const name = new URL(request.url).searchParams.get('do') ?? 'default';
		return env.MACHINE.get(env.MACHINE.idFromName(name)).fetch(request);
	}
} satisfies ExportedHandler<Env>;
