import { DurableObject } from 'cloudflare:workers';
import { createHash } from 'node:crypto';
import busybox from '../build/kernel/busybox.async.wasm';
import busyboxGuard from '../build/kernel/busybox.guard.wasm';
import initrd from '../build/kernel/initramfs.bin';
import katybug from '../build/kernel/katybug.wasm';
import manifest from '../build/kernel/manifest.json';
import vmlinux from '../build/kernel/vmlinux.async.wasm';
import router from '../build/router/router.wasm';
import statx from '../build/router/statx.wasm';
import { bootstrapOf, fits, type BootstrapIndex } from './worker/bootstrap';
import type { Sql } from './worker/durable';
import { Keeper, QUANTUM_MS, type Policy } from './worker/keeper';
import { GatewayTimeout, requestBytes, responseFrom } from './worker/machine/http';
import type { IngressStream } from './worker/machine/ingress';
import { claim, verify, type OwnerStore } from './worker/owner';
import { placement, prime, type PlacementStore } from './worker/placement';
import {
	CMDLINE,
	MAXIMUM_PAGES,
	PUBLIC_PORT,
	SERVE_LIMIT_MS,
	siteOptions
} from './worker/site-machine';

export interface Env {
	MACHINE: DurableObjectNamespace<MachineDO>;
	ASSETS: Fetcher;
}

// a keystroke runs the machine briefly; a tick or an alarm gives it a full quantum
const INPUT_MS = 250;

// a replaced object's machine memory stays charged to its isolate, so its successor restores into it
const MEMORIES = new Map<string, WeakRef<WebAssembly.Memory>>();

/** `ctx.storage.sql` as the durable store reads it: a write's rows counted once it has run */
function sqlOf(storage: SqlStorage): Sql {
	return {
		exec(query, ...bindings) {
			const cursor = storage.exec(query, ...bindings);
			const rows = cursor.toArray();
			return { toArray: () => rows, rowsWritten: cursor.rowsWritten };
		}
	};
}

/**
 * One Linux machine. Terminals attach two sockets: a hibernatable control socket carries console
 * bytes both ways and outlives the object; a standard warm socket keeps the object resident while
 * the page sends ticks on the control socket, each a quantum. A tick on the warm socket would run
 * its pump outside any awaited handler, and the runtime then charges that CPU to whichever event is
 * open: one alarm event ran 23 s that way. The machine checkpoints into the object's
 * SQLite as its interval comes due, and its fsyncs reach storage before they return; an object
 * that lost its machine restores the last checkpoint and the files synced after it. Unattended,
 * the object's alarm wakes the machine for its Linux timers
 */
export class MachineDO extends DurableObject<Env> {
	private readonly keeper: Keeper;
	private pumping = false;
	private pending = '';
	private typed = '';
	private warm = 0;
	private serving = 0;
	private readonly instance = crypto.randomUUID();

	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env);
		ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT)');
		const id = ctx.id.toString();
		this.keeper = new Keeper(
			{
				sql: sqlOf(ctx.storage.sql),
				alarms: ctx.storage,
				sync: () => ctx.storage.sync(),
				decided: (decision) =>
					console.log(JSON.stringify({ gmux: 'thermal', ...decision })),
				options: () =>
					siteOptions(
						{
							vmlinux,
							busybox,
							busyboxGuard,
							katybug,
							router: { route: router, statx },
							initrd: new Uint8Array(initrd),
							manifest
						},
						{
							memory: MEMORIES.get(id)?.deref(),
							// the rootfs's own executables carry their hash (exec stubs); anything else is hashed
							sha256: (bytes) => createHash('sha256').update(bytes).digest('hex'),
							write: (text) => {
								this.keeper.activity();
								this.pending += text;
								queueMicrotask(() => this.flush());
							}
						}
					),
				bootstrap: () => this.bootstrap()
			},
			{},
			this.policy()
		);
	}

	/** the keeper's choices; the idle-machine measurements override it (experiments/decisions) */
	protected policy(): Partial<Policy> {
		return {};
	}

	/** scripts/bootstrap.ts's image in the static assets, when it was taken from this build */
	private async bootstrap() {
		const asset = (path: string) =>
			this.env.ASSETS.fetch(new URL(`/_gmux/bootstrap/${path}`, 'https://assets.invalid'));
		const res = await asset('index.json');
		if (!res.ok) return null;
		const index = (await res.json()) as BootstrapIndex;
		if (!fits(index, (manifest as { image?: string }).image, CMDLINE, MAXIMUM_PAGES))
			return null;
		return bootstrapOf(index, async (n) => {
			const chunk = await asset(`c${n}.bin`);
			if (!chunk.ok) throw new Error(`bootstrap chunk ${n}: ${chunk.status}`);
			return new Uint8Array(await chunk.arrayBuffer());
		});
	}

	private readonly owner: OwnerStore = {
		get: () => {
			const row = this.ctx.storage.sql
				.exec('SELECT v FROM meta WHERE k = ?', 'owner')
				.toArray()[0];
			return row ? String(row.v) : null;
		},
		set: (hash) =>
			void this.ctx.storage.sql.exec('INSERT INTO meta (k, v) VALUES (?, ?)', 'owner', hash)
	};

	private readonly meta: PlacementStore = {
		get: (k) => {
			const row = this.ctx.storage.sql.exec('SELECT v FROM meta WHERE k = ?', k).toArray()[0];
			return row ? String(row.v) : null;
		},
		set: (k, v) =>
			void this.ctx.storage.sql.exec('INSERT OR REPLACE INTO meta (k, v) VALUES (?, ?)', k, v)
	};

	private send(message: object) {
		const text = JSON.stringify(message);
		for (const ws of this.ctx.getWebSockets('control'))
			try {
				ws.send(text);
			} catch {
				// a terminal that went away mid-send; the others still get it
			}
	}

	private flush() {
		if (!this.pending) return;
		this.send({ t: 'out', d: this.pending });
		this.pending = '';
	}

	/**
	 * runs the machine for up to `budgetMs`, restoring or booting it first, then lets the keeper
	 * checkpoint; overlapping events join the pump already running, and input typed meanwhile
	 * reaches the machine as it runs
	 */
	private async pump(budgetMs: number, unattended = false, wake?: () => boolean) {
		if (this.pumping) return;
		this.pumping = true;
		const started = Date.now();
		try {
			const { machine, from } = await this.keeper.open();
			if (from !== 'running') {
				this.send({
					t: 'status',
					d: { booted: 'booting', bootstrapped: 'started', restored: 'restored' }[from]
				});
				console.log(JSON.stringify({ gmux: from, ...this.keeper.counts }));
			}
			MEMORIES.set(this.ctx.id.toString(), new WeakRef(machine.memory));
			const stop = this.keeper.turn(budgetMs, unattended);
			const outcome = await machine.run(
				() => {
					if (this.typed) {
						machine.type(this.typed);
						this.typed = '';
					}
					return stop() || (wake?.() ?? false);
				},
				this.keeper.sleeper((ms) => scheduler.wait(Math.min(ms, 50)))
			);
			if (outcome === 'halted') {
				this.send({ t: 'status', d: outcome });
				await this.keeper.halted();
			} else if (outcome === 'crashed') {
				this.send({ t: 'status', d: outcome });
				this.keeper.crashed();
			} else if (!wake) {
				const written = await this.keeper.ran(Date.now() - started, this.warm > 0);
				if (written) console.log(JSON.stringify({ gmux: 'checkpoint', ...written }));
				console.log(
					JSON.stringify({
						gmux: 'turn',
						budgetMs,
						steps: this.keeper.turnSteps,
						stepCap: this.keeper.stepCap,
						stepMs: this.keeper.stepMs
					})
				);
			}
		} finally {
			this.pumping = false;
			this.flush();
		}
		// typed while the keeper checkpointed
		if (this.typed) await this.pump(INPUT_MS);
	}

	/**
	 * runs the machine until `work` settles, a turn at a time: a turn ends when a stream has something
	 * to read or `work` has settled, so the reader that waits can take it. A pump another request runs
	 * is waited out; a stream whose reader has room is woken here when its own pull has not
	 */
	private async drive<T>(work: Promise<T>): Promise<T> {
		let settled = false;
		work.then(
			() => (settled = true),
			() => (settled = true)
		);
		let quiet = Date.now();
		while (!settled) {
			const { machine } = await this.keeper.open();
			const seen = machine.netActivity;
			if (this.pumping) {
				machine.netPoll();
				await scheduler.wait(2);
			} else
				await this.pump(QUANTUM_MS, false, () => {
					machine.netPoll();
					// a read that resolved on queued bytes has nothing new to wait for
					return settled || machine.netActivity !== seen;
				});
			if (machine.netActivity !== seen) quiet = Date.now();
			else if (!settled && Date.now() - quiet > SERVE_LIMIT_MS)
				throw new GatewayTimeout('the machine did not answer in time');
		}
		return work;
	}

	/** a request outside /_gmux/ goes to whatever listens on the public port, as an ordinary connection */
	private async serve(request: Request): Promise<Response> {
		const { machine } = await this.keeper.open();
		if (!machine.listening(PUBLIC_PORT))
			return new Response('nothing listens on port 80', {
				status: 503,
				headers: { 'retry-after': '1' }
			});
		const stream: IngressStream = machine.ingress(PUBLIC_PORT);
		this.serving++;
		let over = false;
		const finish = (clean: boolean) => {
			if (over) return;
			over = true;
			this.serving--;
			if (clean) stream.end();
			else stream.abort();
		};
		const sent = (async () => {
			for await (const chunk of requestBytes(request)) await stream.write(chunk);
		})();
		sent.catch(() => finish(false));
		try {
			const response = await this.drive(
				responseFrom(stream.readable, request.method, finish)
			);
			const reader = response.body?.getReader();
			if (!reader) return response;
			// every read of the body drives the machine, so a slow reader slows the guest
			const body = new ReadableStream<Uint8Array>({
				pull: async (controller) => {
					try {
						const { done, value } = await this.drive(reader.read());
						if (done) controller.close();
						else controller.enqueue(value);
					} catch (error) {
						finish(false);
						controller.error(error);
					}
					await this.settle();
				},
				cancel: async (reason) => {
					finish(false);
					await reader.cancel(reason);
					await this.settle();
				}
			});
			// a body of known length goes out under its Content-Length, as the machine sent it
			const length = Number(response.headers.get('content-length'));
			if (!Number.isSafeInteger(length) || response.headers.get('content-length') === null)
				return new Response(body, response);
			const { readable, writable } = new FixedLengthStream(length);
			body.pipeTo(writable).catch(() => finish(false));
			return new Response(readable, response);
		} catch (error) {
			finish(false);
			return new Response(
				error instanceof GatewayTimeout
					? 'gateway timeout'
					: `bad gateway: ${(error as Error).message}`,
				{ status: error instanceof GatewayTimeout ? 504 : 502 }
			);
		} finally {
			if (over) await this.settle();
		}
	}

	/** the last stream is done: the keeper checkpoints if due and points the alarm */
	private async settle() {
		if (this.serving === 0 && !this.pumping) await this.keeper.ran(0, this.warm > 0);
	}

	override async fetch(request: Request): Promise<Response> {
		const url = new URL(request.url);
		// a new object is replaced after its first ~1 s of CPU; spend it before a machine exists
		if (placement(this.meta, this.instance) === 'prime') {
			prime();
			return Response.json(
				{ placing: true },
				{ status: 503, headers: { 'retry-after': '1' } }
			);
		}
		if (!url.pathname.startsWith('/_gmux/')) return this.serve(request);
		switch (url.pathname) {
			case '/_gmux/status':
				return Response.json({
					claimed: this.owner.get() !== null,
					running: this.keeper.machine !== null,
					stats: this.keeper.machine?.stats ?? null,
					durable: { ...this.keeper.counts, quietMs: this.keeper.quietMs },
					policy: this.keeper.policy,
					thermal: {
						...this.keeper.thermal,
						history: this.keeper.history,
						alarm: await this.ctx.storage.getAlarm()
					}
				});
			case '/_gmux/claim': {
				if (request.method !== 'POST')
					return new Response('POST to claim', { status: 405 });
				const token = await claim(this.owner);
				return token
					? Response.json({ token })
					: Response.json({ error: 'already claimed' }, { status: 409 });
			}
			case '/_gmux/term/ws': {
				if (request.headers.get('upgrade') !== 'websocket')
					return new Response('websocket only', { status: 426 });
				if (!(await verify(this.owner, url.searchParams.get('token'))))
					return new Response('owner token required', { status: 401 });
				const { 0: client, 1: server } = new WebSocketPair();
				if (url.searchParams.get('kind') === 'warm') {
					server.accept();
					this.warm++;
					server.addEventListener('close', () => void this.warm--);
				} else {
					this.ctx.acceptWebSocket(server, ['control']);
					this.keeper.arrived();
				}
				return new Response(null, { status: 101, webSocket: client });
			}
		}
		return new Response('not found', { status: 404 });
	}

	override async webSocketMessage(_ws: WebSocket, message: string | ArrayBuffer) {
		const msg = JSON.parse(
			typeof message === 'string' ? message : new TextDecoder().decode(message)
		);
		if (msg.t === 'in' && typeof msg.d === 'string') {
			this.typed += msg.d;
			this.keeper.activity();
		}
		await this.pump(msg.t === 'tick' ? QUANTUM_MS : INPUT_MS);
	}

	/** a Linux timer came due, or unsaved work: run the machine for a quantum, or checkpoint it */
	override async alarm() {
		if (await this.keeper.woke(this.pumping)) await this.pump(QUANTUM_MS, this.warm === 0);
		else await this.keeper.arm(this.warm > 0);
	}
}
