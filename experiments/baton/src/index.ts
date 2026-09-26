import { DurableObject } from 'cloudflare:workers';
import park from './park.wasm';

interface Env {
	JOB: DurableObjectNamespace<Job>;
}

type Mode = 'baton' | 'socket' | 'alarm';

/**
 * a headless job of `quanta` events of CPU each, holding a JSPI-parked stack throughout, as a parked
 * machine does. Its next quantum comes from its partner object (a request each way, no storage; the
 * chain is causal, so the platform's subrequest depth caps it), from a message over a WebSocket the two
 * hold open (no subrequests, no storage), or from an alarm (a storage row each)
 */
export class Job extends DurableObject<Env> {
	private readonly instance = crypto.randomUUID();
	private done = 0;
	private quanta = 0;
	private mode: Mode = 'baton';
	private partner = '';
	private instances = new Set<string>();
	private release: ((v: number) => void) | null = null;
	private parked: Promise<number> | null = null;
	private finished: object | null = null;
	private started = 0;

	private burn() {
		let x = 0;
		const end = Date.now();
		for (let i = 0; i < 4e7; i++) x = (x * 31 + i) | 0;
		return x + end;
	}

	private quantum() {
		this.instances.add(this.instance);
		this.burn();
		this.done++;
		if (this.done < this.quanta) return this.next();
		const result = this.release ? (this.release(41), this.parked) : Promise.resolve(-1);
		return result!.then((value) => {
			this.finished = {
				mode: this.mode,
				quanta: this.done,
				instances: this.instances.size,
				parkedStack: value === 42 ? 'alive' : `lost (${value})`,
				seconds: (Date.now() - this.started) / 1000
			};
		});
	}

	private socket: WebSocket | null = null;

	private next() {
		if (this.mode === 'alarm') return this.ctx.storage.setAlarm(Date.now());
		if (this.mode === 'socket') return this.socket!.send('go');
		const partner = this.env.JOB.get(this.env.JOB.idFromName(this.partner));
		this.ctx.waitUntil(partner.fetch(`https://job/pass?to=${encodeURIComponent(this.me)}`));
	}

	private me = '';

	override async alarm() {
		await this.quantum();
	}

	override async fetch(request: Request): Promise<Response> {
		const url = new URL(request.url);
		switch (url.pathname) {
			case '/start': {
				this.me = url.searchParams.get('me')!;
				this.partner = url.searchParams.get('partner')!;
				this.mode = url.searchParams.get('mode') as Mode;
				this.quanta = Number(url.searchParams.get('quanta') ?? 30);
				this.started = Date.now();
				const run = (WebAssembly as any).promising(
					new WebAssembly.Instance(park, {
						host: {
							wait: new (WebAssembly as any).Suspending(() => new Promise<number>((r) => (this.release = r)))
						}
					}).exports.run
				);
				this.parked = run();
				if (this.mode === 'socket') {
					const partner = this.env.JOB.get(this.env.JOB.idFromName(this.partner));
					const response = await partner.fetch('https://job/accept', { headers: { Upgrade: 'websocket' } });
					this.socket = response.webSocket!;
					this.socket.accept();
					this.socket.addEventListener('message', () => void this.quantum());
				}
				await this.quantum();
				return Response.json({ started: this.instance });
			}
			case '/pass': {
				// the partner's side: hand the next quantum straight back
				const to = this.env.JOB.get(this.env.JOB.idFromName(url.searchParams.get('to')!));
				this.ctx.waitUntil(to.fetch('https://job/quantum'));
				return new Response('passed');
			}
			case '/accept': {
				// the partner's side of the socket baton: every message is handed straight back
				const [client, server] = Object.values(new WebSocketPair());
				server!.accept();
				server!.addEventListener('message', () => server!.send('go'));
				return new Response(null, { status: 101, webSocket: client });
			}
			case '/quantum':
				await this.quantum();
				return new Response('ok');
			case '/burn': {
				// a new object is replaced once after about its first second of CPU: spend it before the job
				for (let i = 0; i < 30; i++) this.burn();
				return Response.json({ instance: this.instance });
			}
			case '/status':
				return Response.json({ instance: this.instance, done: this.done, finished: this.finished });
		}
		return new Response('not found', { status: 404 });
	}
}

export default {
	async fetch(request: Request, env: Env): Promise<Response> {
		const url = new URL(request.url);
		const name = url.searchParams.get('do') ?? 'job';
		return env.JOB.get(env.JOB.idFromName(name)).fetch(request);
	}
};
