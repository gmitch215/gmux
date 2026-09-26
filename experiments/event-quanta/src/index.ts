import { DurableObject } from 'cloudflare:workers';
import shapesModule from './wasm/shapes.wasm';
import workModule from './wasm/work.wasm';
import { placement, prime } from '../../../src/worker/placement';

interface Env {
	PROBE: DurableObjectNamespace<Probe>;
	ASSETS?: Fetcher;
}

interface Deferred<T = void> {
	promise: Promise<T>;
	resolve: (value: T) => void;
}

function deferred<T = void>(): Deferred<T> {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((r) => (resolve = r));
	return { promise, resolve };
}

export class Probe extends DurableObject<Env> {
	private readonly instance = crypto.randomUUID();
	private socket: WebSocket | null = null;
	private quantum: {
		wake: (() => void) | null;
		yielded: Deferred<number>;
		done: Promise<number>;
		yields: number;
	} | null = null;
	private alarmPlan: { remaining: number; iters: number; chunk: number } | null = null;

	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env);
	}

	private who() {
		return { instance: this.instance, now: Date.now() };
	}

	override async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
		await this.onMessage(ws, String(message));
	}

	override async alarm(): Promise<void> {
		if (this.alarmPlan) {
			const plan = this.alarmPlan;
			const out = await this.burn(plan.iters, plan.chunk, this.socket);
			plan.remaining--;
			this.socket?.send(
				JSON.stringify({
					op: 'alarm-burned',
					remaining: plan.remaining,
					...out,
					...this.who()
				})
			);
			if (plan.remaining > 0) await this.ctx.storage.setAlarm(Date.now());
			else this.alarmPlan = null;
			return;
		}
	}

	private async onMessage(ws: WebSocket, raw: string): Promise<void> {
		const reply = (body: object) => ws.send(JSON.stringify({ ...body, ...this.who() }));
		try {
			const msg = JSON.parse(raw);
			switch (msg.op) {
				case 'ping':
					return reply({ op: 'pong', quantum: !!this.quantum });
				case 'burn': {
					const out = await this.burn(
						msg.iters,
						msg.chunk,
						msg.quiet ? null : ws,
						!!msg.yieldQuiet
					);
					return reply({ op: 'burned', ...out });
				}
				case 'quantum-start': {
					const { chunks, chunk, quantum } = msg;
					const yieldFn = new WebAssembly.Suspending((c: number) => {
						const state = this.quantum!;
						state.yields++;
						return new Promise<number>((resolve) => {
							state.wake = () => resolve(0);
							state.yielded.resolve(c);
						});
					});
					const work = new WebAssembly.Instance(workModule, { host: { yield: yieldFn } });
					const run = WebAssembly.promising(work.exports.work as Function);
					this.quantum = {
						wake: null,
						yielded: deferred<number>(),
						done: Promise.resolve(0),
						yields: 0
					};
					this.quantum.done = run(chunks, chunk, quantum);
					return reply(await this.quantumStep());
				}
				case 'quantum-continue': {
					const state = this.quantum;
					if (!state || !state.wake)
						return reply({ op: 'quantum', ok: false, reason: 'nothing parked' });
					const wake = state.wake;
					state.wake = null;
					state.yielded = deferred<number>();
					wake();
					return reply(await this.quantumStep());
				}
				case 'reference': {
					const work = new WebAssembly.Instance(workModule, { host: { yield: () => 0 } });
					const burn = work.exports.burn as (n: number, x: number) => number;
					let x = 1;
					for (let c = 0; c < msg.chunks; c++) x = burn(msg.chunk, x);
					return reply({ op: 'reference', x });
				}
			}
			reply({ op: 'error', reason: `unknown op ${msg.op}` });
		} catch (error) {
			reply({ op: 'error', reason: String(error) });
		}
	}

	private async quantumStep(): Promise<object> {
		const state = this.quantum!;
		const outcome = await Promise.race([
			state.yielded.promise.then((c) => ({ kind: 'yielded', c })),
			state.done.then((x) => ({ kind: 'finished', x }))
		]);
		if (outcome.kind === 'finished') this.quantum = null;
		return { op: 'quantum', ...outcome, yields: state.yields };
	}

	/** burns `iters` iterations in chunks, reporting progress between chunks when a socket is given */
	private async burn(iters: number, chunk: number, ws: WebSocket | null, yieldBetween = false) {
		const work = new WebAssembly.Instance(workModule, { host: { yield: () => 0 } });
		const burn = work.exports.burn as (n: number, x: number) => number;
		let x = 1;
		let done = 0;
		while (done < iters) {
			const n = Math.min(chunk, iters - done);
			x = burn(n, x);
			done += n;
			if (ws) {
				ws.send(JSON.stringify({ op: 'progress', done }));
				await scheduler.wait(1);
			} else if (yieldBetween) {
				await scheduler.wait(1);
			}
		}
		return { iters: done, x };
	}

	override async fetch(request: Request): Promise<Response> {
		const url = new URL(request.url);
		const q = (n: string, f: number) => Number(url.searchParams.get(n) ?? f);
		const op = url.pathname.slice(1);
		const who = { op, instance: this.instance };
		if (request.headers.get('Upgrade') === 'websocket') {
			const pair = new WebSocketPair();
			const [client, server] = Object.values(pair);
			if (url.searchParams.get('mode') === 'hib') {
				this.ctx.acceptWebSocket(server);
			} else {
				server.accept();
				this.socket = server;
				server.addEventListener('message', (event) => {
					void this.onMessage(server, String(event.data));
				});
			}
			return new Response(null, { status: 101, webSocket: client });
		}
		try {
			switch (op) {
				case 'http-burn': {
					const out = await this.burn(
						q('iters', 1e8),
						q('chunk', 1e8),
						null,
						q('yield', 0) === 1
					);
					return Response.json({ op, ...out, ...this.who() });
				}
				case 'alarm-burn': {
					this.alarmPlan = {
						remaining: q('times', 3),
						iters: q('iters', 1e8),
						chunk: q('chunk', 1e8)
					};
					await this.ctx.storage.setAlarm(Date.now());
					return Response.json({ op, plan: this.alarmPlan, ...this.who() });
				}
				case 'burn': {
					let x = 1;
					const n = q('iters', 3e8);
					for (let i = 0; i < n; i++) x = (x * 1103515245 + 12345) | 0;
					return Response.json({ ...who, x });
				}
				case 'shape': {
					const shape = url.searchParams.get('shape') ?? 'alu';
					const inst = new WebAssembly.Instance(shapesModule, {});
					const e = inst.exports as Record<string, (n: number) => number>;
					if (shape === 'chase') e.chase_init!(8 << 20);
					const x = e[shape]!(q('n', 1e8));
					return Response.json({ ...who, shape, n: q('n', 1e8), x });
				}

				// the site's first-placement step (src/worker/placement.ts) on its own
				case 'place': {
					const sql = this.ctx.storage.sql;
					sql.exec('CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT)');
					const state = placement(
						{
							get: (k) => {
								const row = sql.exec('SELECT v FROM meta WHERE k = ?', k).toArray()[0];
								return row ? String(row.v) : null;
							},
							set: (k, v) =>
								void sql.exec('INSERT OR REPLACE INTO meta (k, v) VALUES (?, ?)', k, v)
						},
						this.instance
					);
					if (state === 'prime') prime();
					return Response.json({ ...who, state });
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
