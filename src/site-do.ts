import { DurableObject } from 'cloudflare:workers';
import { createHash } from 'node:crypto';
import busyboxGuard from '../build/kernel/busybox.guard.wasm';
import busybox from '../build/kernel/busybox.wasm';
import initrd from '../build/kernel/initramfs.bin';
import katybug from '../build/kernel/katybug.wasm';
import manifest from '../build/kernel/manifest.json';
import vmlinux from '../build/kernel/vmlinux.wasm';
import { Machine } from './worker/machine/machine';
import { claim, verify, type OwnerStore } from './worker/owner';
import { placement, prime, type PlacementStore } from './worker/placement';

export interface Env {
	MACHINE: DurableObjectNamespace<MachineDO>;
	ASSETS: Fetcher;
}

// no nohz_full: its timekeeping cpu never stops ticking, and its context tracking reads the host
// clock on every syscall
const CMDLINE = 'maxcpus=3 root=/dev/ram0 rootfstype=ramfs init=/init console=hvc console=ttyS0';
const MAXIMUM_PAGES = 800;
// a keystroke runs the machine briefly; a warm-socket tick gives a running job a full quantum
const INPUT_MS = 250;
const QUANTUM_MS = 5000;

/**
 * One Linux machine. Terminals attach two sockets: a hibernatable control socket carries console
 * bytes both ways and outlives the object; a standard warm socket keeps the object resident and
 * drives the machine with ticks while a job runs. Without a checkpoint yet, a machine evicted after
 * its last warm socket closes boots again on the next control message
 */
export class MachineDO extends DurableObject<Env> {
	private machine: Machine | null = null;
	private pumping = false;
	private pending = '';
	private readonly instance = crypto.randomUUID();

	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env);
		ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT)');
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
		for (const ws of this.ctx.getWebSockets('control')) ws.send(text);
	}

	private boot() {
		this.machine = new Machine({
			vmlinux,
			initrd: new Uint8Array(initrd),
			cmdline: CMDLINE,
			registry: new Map([
				[manifest.busybox, busybox],
				[manifest.katybug, katybug]
			]),
			// a non-root task's BusyBox checks every store against the kernel's page owner table
			guarded: new Map([[manifest.busybox, busyboxGuard]]),
			maximumPages: MAXIMUM_PAGES,
			sharedKernel: true,
			// the rootfs's own executables carry their hash (exec stubs); anything else is hashed
			sha256: (bytes) => createHash('sha256').update(bytes).digest('hex'),
			write: (text) => {
				this.pending += text;
				queueMicrotask(() => this.flush());
			}
		});
		this.send({ t: 'status', d: 'booting' });
	}

	private flush() {
		if (!this.pending) return;
		this.send({ t: 'out', d: this.pending });
		this.pending = '';
	}

	/** runs the machine for up to `budgetMs`; overlapping events join the pump already running */
	private async pump(budgetMs: number) {
		if (!this.machine) this.boot();
		if (this.pumping) return;
		this.pumping = true;
		const started = Date.now();
		try {
			const outcome = await this.machine!.run(
				() => Date.now() - started > budgetMs,
				(ms) => scheduler.wait(Math.min(ms, 50))
			);
			if (outcome === 'halted' || outcome === 'crashed') {
				this.send({ t: 'status', d: outcome });
				this.machine = null;
			}
		} finally {
			this.pumping = false;
			this.flush();
		}
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
		switch (url.pathname) {
			case '/_gmux/status':
				return Response.json({
					claimed: this.owner.get() !== null,
					running: this.machine !== null,
					stats: this.machine?.stats ?? null
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
					server.addEventListener('message', () => void this.pump(QUANTUM_MS));
				} else {
					this.ctx.acceptWebSocket(server, ['control']);
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
			if (!this.machine) this.boot();
			this.machine!.type(msg.d);
		}
		await this.pump(INPUT_MS);
	}
}
