import { DurableObject } from 'cloudflare:workers';
import { Machine, parkTasks } from '../../jspi-parks/src/machine';

interface Env {
	PROBE: DurableObjectNamespace<Probe>;
}

/**
 * How long parked JSPI stacks survive between events. Two socket protocols: `mode=std|hib` carries
 * JSON park/resume ops over a standard or a hibernatable socket; `kind=control|warm` is the
 * two-socket design (a hibernatable control socket beside a standard warm lease)
 */
export class Probe extends DurableObject<Env> {
	private readonly instance = crypto.randomUUID();
	private machine: Machine | null = null;
	private machineShape = { tasks: 0, iters: 0, depth: 0 };
	private parked: { parked: number; drain: () => Promise<void> } | null = null;

	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env);
		ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS result (k TEXT PRIMARY KEY, v TEXT)');
	}

	private who() {
		return { instance: this.instance, now: Date.now() };
	}

	private status(channel: string) {
		return {
			channel,
			instance: this.instance,
			parked: this.parked?.parked ?? 0,
			sockets: this.ctx.getWebSockets().length,
			marker: this.ctx.storage.kv.get('marker') ?? null
		};
	}

	override async fetch(request: Request): Promise<Response> {
		const url = new URL(request.url);
		const q = (n: string, f: number) => Number(url.searchParams.get(n) ?? f);
		const op = url.pathname.slice(1);
		if (request.headers.get('upgrade') === 'websocket') {
			const [client, server] = Object.values(new WebSocketPair());
			const kind = url.searchParams.get('kind');
			if (kind === 'control') this.ctx.acceptWebSocket(server, ['control']);
			else if (kind === 'warm') {
				server.accept();
				server.addEventListener('message', async (event) => {
					if (event.data === 'park') this.parked ??= await parkTasks(1000, 64);
					server.send(JSON.stringify(this.status('warm')));
				});
			} else if (url.searchParams.get('mode') === 'hib') this.ctx.acceptWebSocket(server);
			else {
				server.accept();
				server.addEventListener(
					'message',
					(event) => void this.onMessage(server, String(event.data))
				);
			}
			return new Response(null, { status: 101, webSocket: client });
		}
		try {
			switch (op) {
				case 'alarm-park': {
					const delay = q('delay', 5000);
					const tasks = q('tasks', 4);
					this.machine = new Machine();
					this.machineShape = { tasks, iters: 3, depth: 8 };
					await this.machine.start(tasks, 3, 8);
					await this.ctx.storage.setAlarm(Date.now() + delay);
					return Response.json({
						op,
						delay,
						parked: this.machine.wake.size,
						...this.who()
					});
				}
				case 'alarm-result': {
					const row = this.ctx.storage.sql
						.exec('SELECT v FROM result WHERE k = ?', 'alarm')
						.toArray()[0];
					return Response.json({
						op,
						result: row ? JSON.parse(String(row.v)) : null,
						...this.who()
					});
				}
				case 'who':
					return Response.json({ op, machine: !!this.machine, ...this.who() });
			}
			return new Response('unknown op', { status: 404 });
		} catch (error) {
			return Response.json({ op, error: String(error), ...this.who() }, { status: 500 });
		}
	}

	override async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
		if (this.ctx.getTags(ws).includes('control')) {
			if (message === 'mark') this.ctx.storage.kv.put('marker', this.instance);
			ws.send(JSON.stringify(this.status('control')));
			return;
		}
		await this.onMessage(ws, String(message));
	}

	override async alarm(): Promise<void> {
		let result: unknown;
		if (!this.machine) {
			result = { ok: false, reason: 'nothing parked', ...this.who() };
		} else {
			await this.machine.drain();
			const { tasks, iters, depth } = this.machineShape;
			result = {
				...this.machine.verify(tasks, iters, depth),
				resumes: this.machine.resumes,
				...this.who()
			};
			this.machine = null;
		}
		this.ctx.storage.sql.exec(
			'INSERT OR REPLACE INTO result (k, v) VALUES (?, ?)',
			'alarm',
			JSON.stringify(result)
		);
	}

	private async onMessage(ws: WebSocket, raw: string): Promise<void> {
		const reply = (body: object) => ws.send(JSON.stringify({ ...body, ...this.who() }));
		try {
			const msg = JSON.parse(raw);
			switch (msg.op) {
				case 'ping':
					return reply({ op: 'pong', machine: !!this.machine });
				case 'park': {
					const { tasks = 4, iters = 3, depth = 8 } = msg;
					this.machine = new Machine();
					this.machineShape = { tasks, iters, depth };
					await this.machine.start(tasks, iters, depth);
					return reply({ op: 'parked', parked: this.machine.wake.size });
				}
				case 'resume': {
					if (!this.machine)
						return reply({ op: 'resumed', ok: false, reason: 'nothing parked' });
					await this.machine.drain();
					const { tasks, iters, depth } = this.machineShape;
					const verdict = this.machine.verify(tasks, iters, depth);
					const resumes = this.machine.resumes;
					this.machine = null;
					return reply({ op: 'resumed', ...verdict, resumes });
				}
			}
			reply({ op: 'error', reason: `unknown op ${msg.op}` });
		} catch (error) {
			reply({ op: 'error', reason: String(error) });
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
