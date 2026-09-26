import { DurableObject } from 'cloudflare:workers';
import { createHash } from 'node:crypto';
import busyboxAsync from '../vendor/busybox.async.wasm';
import busyboxFuel from '../vendor/busybox.fuel.wasm';
import busyboxGuard from '../vendor/busybox.guard.wasm';
import initrd from '../vendor/initramfs.bin';
import vmlinuxAsync from '../vendor/vmlinux.async.wasm';
import vmlinux from '../vendor/vmlinux.shared.wasm';
import { Machine, type MachineOptions, type Snapshot } from './machine';
import { BUSYBOX_SHA256, GUARDED, PROGRAMS } from './programs';

const ROW = 2_000_000;
// machines of one class share isolates: a nonce per isolate and its live machines show who packed with whom
let ISOLATE = '';
const LIVE = new Map<string, number>();
// an evicted machine's memory stays charged to its isolate, so the same object's next instance
// here boots or restores into it; one live instance per object id makes the old owner dead
const POOL = new Map<string, WeakRef<WebAssembly.Memory>>();
// the checkpoint rig's attribution arms (nothing to unwind, indirect calls ignored) are measured and left out
const ASYNC_KERNELS: Record<string, WebAssembly.Module> = { full: vmlinuxAsync };
const CMDLINE =
	'maxcpus=3 root=/dev/ram0 rootfstype=ramfs init=/init console=hvc console=ttyS0';

interface Env {
	MACHINE: DurableObjectNamespace<MachineDO>;
}

export class MachineDO extends DurableObject<Env> {
	private readonly instance = crypto.randomUUID();
	private machine: Machine | null = null;
	private output = '';
	private log: string[] = [];

	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env);
		ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS image (k INTEGER PRIMARY KEY, v BLOB)');
		ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT)');
	}

	private options(maximumPages: number, cpus: number, asyncify: boolean, kernel = 'full', shared = true): MachineOptions {
		return {
			vmlinux: asyncify ? ASYNC_KERNELS[kernel]! : vmlinux,
			initrd: new Uint8Array(initrd),
			cmdline: CMDLINE.replace('maxcpus=3', `maxcpus=${cpus}`),
			registry: new Map([[BUSYBOX_SHA256, asyncify ? busyboxAsync : busyboxFuel], ...PROGRAMS]),
			guarded: new Map([[BUSYBOX_SHA256, busyboxGuard], ...GUARDED]),
			maximumPages,
			sharedKernel: shared,
			asyncify: asyncify && shared,
			sha256: (bytes) => createHash('sha256').update(bytes).digest('hex'),
			log: (line) => {
				this.log.push(line);
				console.log(line);
			},
			write: (text) => (this.output += text),
			memory: this.reuse ? POOL.get(this.ctx.id.toString())?.deref() : undefined
		};
	}

	private reuse = true;

	private pool(machine: Machine) {
		POOL.set(this.ctx.id.toString(), new WeakRef(machine.memory));
		return machine;
	}

	private boot(maximumPages: number, cpus = 3, asyncify = false, kernel = 'full', shared = true) {
		this.machine = this.pool(new Machine(this.options(maximumPages, cpus, asyncify, kernel, shared)));
		LIVE.set(this.instance, maximumPages);
		this.ctx.storage.sql.exec(
			'INSERT OR REPLACE INTO meta (k, v) VALUES (?, ?)',
			'shape',
			JSON.stringify({ maximumPages, cpus, asyncify })
		);
	}

	/** writes the machine into SQLite: memory in 2 MB rows, everything else as one JSON row */
	private async persist(snapshot: Snapshot) {
		const sql = this.ctx.storage.sql;
		sql.exec('DELETE FROM image');
		let rows = 0;
		for (let at = 0; at < snapshot.memory.byteLength; at += ROW) {
			sql.exec('INSERT INTO image (k, v) VALUES (?, ?)', rows++, snapshot.memory.slice(at, at + ROW));
		}
		const b64 = (bytes: Uint8Array | null) => (bytes ? Buffer.from(bytes).toString('base64') : null);
		const meta = {
			...snapshot,
			memory: snapshot.memory.byteLength,
			runners: snapshot.runners.map((r) => ({ ...r, kernelStack: b64(r.kernelStack), userStack: b64(r.userStack) }))
		};
		const json = JSON.stringify(meta);
		sql.exec('INSERT OR REPLACE INTO meta (k, v) VALUES (?, ?)', 'snapshot', json);
		await this.ctx.storage.sync();
		return { rows, metaBytes: json.length };
	}

	/** the snapshot's metadata and a writer that streams its memory rows into the machine */
	private load(): { snapshot: Snapshot; image: { byteLength: number; write(into: Uint8Array): void } } | null {
		const sql = this.ctx.storage.sql;
		const row = sql.exec('SELECT v FROM meta WHERE k = ?', 'snapshot').toArray()[0];
		if (!row) return null;
		const meta = JSON.parse(String(row.v));
		const image = {
			byteLength: meta.memory as number,
			write: (into: Uint8Array) => {
				let at = 0;
				for (const r of sql.exec('SELECT v FROM image ORDER BY k')) {
					const chunk = new Uint8Array(r.v as ArrayBuffer);
					into.set(chunk, at);
					at += chunk.byteLength;
				}
			}
		};
		const bytes = (b64: string | null) => (b64 === null ? null : new Uint8Array(Buffer.from(b64, 'base64')));
		const snapshot = {
			...meta,
			memory: new Uint8Array(0),
			runners: meta.runners.map((r: any) => ({ ...r, kernelStack: bytes(r.kernelStack), userStack: bytes(r.userStack) }))
		};
		return { snapshot, image };
	}

	/** runs until the output since `mark` ends at a shell prompt, or the wall budget passes */
	private async settle(mark: number, wallMs: number) {
		const started = Date.now();
		const outcome = await this.machine!.run(
			() =>
				(this.output.length > mark && /[#$] $/.test(this.output)) ||
				Date.now() - started > wallMs,
			(ms) => scheduler.wait(Math.min(ms, 50))
		);
		return { outcome, wallMs: Date.now() - started };
	}

	private async onMessage(ws: WebSocket, raw: string) {
		const msg = JSON.parse(raw);
		const reply = (body: object) =>
			ws.send(
				JSON.stringify({ ...body, instance: this.instance, stats: this.machine?.stats })
			);
		try {
			if (msg.op === 'boot' && !this.machine) this.boot(msg.pages ?? 800);
			if (!this.machine) return reply({ op: msg.op, ok: false, reason: 'not booted' });
			if (msg.type) this.machine.type(msg.type);
			const mark = this.output.length;
			const started = Date.now();
			const outcome = await this.machine.run(
				() =>
					(msg.until && this.output.slice(mark).includes(msg.until)) ||
					Date.now() - started > (msg.wall ?? 20000),
				(ms) => scheduler.wait(Math.min(ms, 50))
			);
			reply({
				op: msg.op,
				outcome,
				wallMs: Date.now() - started,
				out: this.output.slice(mark)
			});
		} catch (error) {
			reply({ op: msg.op, error: String(error) });
		}
	}

	override async fetch(request: Request): Promise<Response> {
		const url = new URL(request.url);
		ISOLATE ||= crypto.randomUUID();
		const who = { instance: this.instance, isolate: ISOLATE, live: [...LIVE.values()] };
		if (request.headers.get('Upgrade') === 'websocket') {
			const [client, server] = Object.values(new WebSocketPair());
			server.accept();
			server.addEventListener(
				'message',
				(event) => void this.onMessage(server, String(event.data))
			);
			return new Response(null, { status: 101, webSocket: client });
		}
		try {
			switch (url.pathname) {
				case '/burn': {
					let x = 1;
					const end = Number(url.searchParams.get('iters') ?? 6e8);
					for (let i = 0; i < end; i++) x = (x * 1103515245 + 12345) | 0;
					return Response.json({ op: 'burn', x, ...who });
				}
				case '/boot': {
					this.reuse = url.searchParams.get('reuse') !== '0';
					if (!this.machine)
						this.boot(
							Number(url.searchParams.get('pages') ?? 2048),
							Number(url.searchParams.get('cpus') ?? 3),
							url.searchParams.get('async') === '1',
							url.searchParams.get('kernel') ?? 'full',
							url.searchParams.get('shared') !== '0'
						);
					const result = await this.settle(
						0,
						Number(url.searchParams.get('wall') ?? 20000)
					);
					const cmd = url.searchParams.get('cmd');
					let exec = null;
					if (cmd) {
						const mark = this.output.length;
						this.machine!.type(cmd + '\n');
						exec = {
							...(await this.settle(
								mark + 1,
								Number(url.searchParams.get('cmdwall') ?? 10000)
							)),
							out: this.output.slice(mark)
						};
					}
					return Response.json({
						op: 'boot',
						...result,
						exec,
						memoryBytes: this.machine!.memory.buffer.byteLength,
						outputBytes: this.output.length,
						stats: this.machine!.stats,
						tail: this.output.slice(-400),
						log: this.log.slice(-10),
						...who
					});
				}
				case '/exec': {
					if (!this.machine)
						return Response.json({
							op: 'exec',
							ok: false,
							reason: 'not booted',
							...who
						});
					const mark = this.output.length;
					this.machine.type((url.searchParams.get('cmd') ?? '') + '\n');
					const result = await this.settle(
						mark + 1,
						Number(url.searchParams.get('wall') ?? 15000)
					);
					return Response.json({
						op: 'exec',
						...result,
						out: this.output.slice(mark),
						stats: this.machine.stats,
						log: this.log.slice(-10),
						...who
					});
				}
				case '/run': {
					if (!this.machine)
						return Response.json({
							op: 'run',
							ok: false,
							reason: 'not booted',
							...who
						});
					const mark = this.output.length;
					const until = url.searchParams.get('until');
					const wall = Number(url.searchParams.get('wall') ?? 20000);
					const started = Date.now();
					const outcome = await this.machine.run(
						() =>
							(until !== null && this.output.slice(mark).includes(until)) ||
							Date.now() - started > wall,
						(ms) => scheduler.wait(Math.min(ms, 50))
					);
					return Response.json({
						op: 'run',
						outcome,
						wallMs: Date.now() - started,
						out: this.output.slice(mark),
						stats: this.machine.stats,
						...who
					});
				}
				case '/checkpoint': {
					if (!this.machine) return Response.json({ op: 'checkpoint', ok: false, reason: 'not booted', ...who });
					const snapshot = await this.machine.checkpoint();
					const stored = await this.persist(snapshot);
					this.machine = null;
					return Response.json({
						op: 'checkpoint',
						...stored,
						memoryBytes: snapshot.memory.byteLength,
						runners: snapshot.runners.length,
						stacks: snapshot.runners.filter((r) => r.kernelStack || r.userStack).length,
						...who
					});
				}
				case '/abort':
					LIVE.delete(this.instance);
					// drop the machine first, so only what the platform keeps can hold its memory
					if (url.searchParams.get('release') === '1') this.machine = null;
					this.ctx.abort('forced eviction');
					return new Response('unreachable');
				case '/restore': {
					this.reuse = url.searchParams.get('reuse') !== '0';
					const saved = this.load();
					const shapeRow = this.ctx.storage.sql.exec('SELECT v FROM meta WHERE k = ?', 'shape').toArray()[0];
					if (!saved || !shapeRow) return Response.json({ op: 'restore', ok: false, reason: 'no snapshot', ...who });
					const shape = JSON.parse(String(shapeRow.v));
					this.machine = this.pool(await Machine.restore(this.options(shape.maximumPages, shape.cpus, true), saved.snapshot, saved.image));
					return Response.json({ op: 'restore', ok: true, runners: saved.snapshot.runners.length, ...who });
				}
				case '/who':
					return Response.json({ op: 'who', booted: !!this.machine, ...who });
			}
			return new Response('unknown', { status: 404 });
		} catch (error) {
			return Response.json(
				{
					error: String(error),
					stack: (error as Error).stack,
					log: this.log.slice(-10),
					...who
				},
				{ status: 500 }
			);
		}
	}
}

export default {
	async fetch(request: Request, env: Env): Promise<Response> {
		const url = new URL(request.url);
		return env.MACHINE.get(
			env.MACHINE.idFromName(url.searchParams.get('do') ?? 'default')
		).fetch(request);
	}
} satisfies ExportedHandler<Env>;
