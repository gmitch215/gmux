import { DurableObject } from 'cloudflare:workers';
import { createHash } from 'node:crypto';
import busyboxAsync from '../../boot/vendor/busybox.async.wasm';
import initrd from '../../boot/vendor/initramfs.bin';
import vmlinuxAsync from '../../boot/vendor/vmlinux.async.wasm';
import manifest from '../../../build/kernel/manifest.json';
import {
	decodeSnapshot,
	DurableStore,
	encodeSnapshot,
	type Sql
} from '../../../src/worker/durable';
import { Machine, type MachineOptions } from '../../../src/worker/machine/machine';
import { Cadence } from '../../../src/worker/schedule';

/**
 * Rows and CPU of checkpointing a running job, two ways. `quantum` checkpoints at the end of every
 * quantum as the rigs have: every row deleted and the whole memory written again in 2 MB rows,
 * then restored from them. `writeback` checkpoints when the adaptive interval comes due, writing
 * only changed pages, and hands every fsync's changed blocks to storage before the fsync returns.
 * Both restore from storage after a checkpoint, since a checkpointed machine continues only from a
 * restore. Each quantum answers the rows it wrote; CPU comes from wrangler tail.
 */
const ROW = 2_000_000;
const CMDLINE = 'maxcpus=3 root=/dev/ram0 rootfstype=ramfs init=/init console=hvc console=ttyS0';
const JOBS: Record<string, string> = {
	// 16 files of ~40 KB rewritten in turn by the shell itself, every 256th write fsynced; a
	// process per write fragments an 800-page machine's RAM until new processes cannot start
	write:
		'mkdir -p /data; x=$(seq 1 8000); i=0; while :; do f=/data/f$((i % 16)); echo "$i $x" > $f; ' +
		'[ $((i % 256)) = 0 ] && fsync $f; i=$((i + 1)); [ $((i % 64)) = 0 ] && echo W$i; done &',
	// arithmetic in the shell, one process and no files: CPU with little memory changing
	cpu: 'i=0; while :; do i=$((i + 1)); [ $((i % 5000)) = 0 ] && echo C$i; done &'
};

// an evicted machine's memory stays charged to its isolate, so a successor here restores into it
const POOL = new Map<string, WeakRef<WebAssembly.Memory>>();

interface Env {
	MACHINE: DurableObjectNamespace<MachineDO>;
}

/** counts rows written through the object's SQL */
function counting(sql: SqlStorage): Sql & { written: number } {
	const s = {
		written: 0,
		exec(query: string, ...bindings: (string | number | ArrayBuffer | Uint8Array | null)[]) {
			const cursor = sql.exec(query, ...bindings);
			const rows = cursor.toArray();
			s.written += cursor.rowsWritten;
			return { toArray: () => rows, rowsWritten: cursor.rowsWritten };
		}
	};
	return s;
}

export class MachineDO extends DurableObject<Env> {
	private readonly instance = crypto.randomUUID();
	private machine: Machine | null = null;
	private output = '';
	private arm = '';
	private sql = counting(this.ctx.storage.sql);
	private store: DurableStore | null = null;
	private cadence = new Cadence();
	private checkpoints = 0;
	private fsyncs = 0;
	private pages = 800;
	private restores = 0;
	private restoredFiles = 0;

	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env);
		ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS image (k INTEGER PRIMARY KEY, v BLOB)');
		ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT)');
	}

	private pooled() {
		return POOL.get(this.ctx.id.toString())?.deref();
	}

	private keep(machine: Machine) {
		POOL.set(this.ctx.id.toString(), new WeakRef(machine.memory));
		return machine;
	}

	private options(): MachineOptions {
		return {
			vmlinux: vmlinuxAsync,
			initrd: new Uint8Array(initrd),
			cmdline: CMDLINE,
			registry: new Map([[manifest.busybox, busyboxAsync]]),
			maximumPages: this.pages,
			sharedKernel: true,
			asyncify: true,
			sha256: (bytes) => createHash('sha256').update(bytes).digest('hex'),
			write: (text) => (this.output = (this.output + text).slice(-4000)),
			fileSync:
				this.arm === 'writeback'
					? async (file) => {
							this.store!.writeFile(file);
							this.fsyncs++;
							await this.ctx.storage.sync();
						}
					: undefined
		};
	}

	private progress(): number {
		const all = [...this.output.matchAll(/[WC](\d+)/g)];
		return all.length ? Number(all.at(-1)![1]) : 0;
	}

	private async run(wall: number, until: () => boolean = () => false) {
		const started = Date.now();
		return this.machine!.run(
			() => until() || Date.now() - started > wall,
			(ms) => scheduler.wait(Math.min(ms, 50))
		);
	}

	private meta(k: string): string | null {
		const row = this.ctx.storage.sql.exec('SELECT v FROM meta WHERE k = ?', k).toArray()[0];
		return row ? String(row.v) : null;
	}

	/** the baseline's image, read back from its rows */
	private quantumImage() {
		const sql = this.sql;
		const n = Number(sql.exec('SELECT count(*) AS n FROM image').toArray()[0]!.n);
		return {
			byteLength: this.pages * 0x10000,
			write: (into: Uint8Array) => {
				let at = 0;
				for (let k = 0; k < n; k++) {
					const r = sql.exec('SELECT v FROM image WHERE k = ?', k).toArray()[0]!;
					const chunk = new Uint8Array(r.v as ArrayBuffer);
					into.set(chunk, at);
					at += chunk.byteLength;
				}
			}
		};
	}

	/** the per-quantum baseline: every row replaced, the whole memory written, then read back */
	private async quantumCheckpoint() {
		const snapshot = await this.machine!.checkpoint();
		const sql = this.sql;
		sql.exec('DELETE FROM image');
		let rows = 0;
		for (let at = 0; at < snapshot.memory.byteLength; at += ROW)
			sql.exec('INSERT INTO image (k, v) VALUES (?, ?)', rows++, snapshot.memory.slice(at, at + ROW));
		sql.exec('INSERT OR REPLACE INTO meta (k, v) VALUES (?, ?)', 'snapshot', encodeSnapshot(snapshot));
		await this.ctx.storage.sync();
		const memory = this.machine!.memory;
		// let the old instances go before the new ones are made
		this.machine = null;
		// into the same memory: the isolate has no room for a second copy of the machine
		this.machine = await Machine.restore(
			{ ...this.options(), memory: memory },
			decodeSnapshot(this.meta('snapshot')!),
			this.quantumImage()
		);
	}

	/** a new instance of an object whose machine was lost: continue from what storage holds */
	private async recoverLost(): Promise<boolean> {
		const arm = this.meta('arm');
		if (!arm) return false;
		this.arm = arm;
		this.pages = Number(this.meta('pages'));
		if (arm === 'quantum') {
			const text = this.meta('snapshot');
			if (!text) return false;
			this.machine = this.keep(
				await Machine.restore(
					{ ...this.options(), memory: this.pooled() },
					decodeSnapshot(text),
					this.quantumImage()
				)
			);
			return true;
		}
		this.store = new DurableStore(this.sql);
		const recovery = this.store.recover();
		if (!recovery) return false;
		this.machine = this.keep(
			await Machine.restore(
				{ ...this.options(), restoreFiles: recovery.files, memory: this.pooled() },
				decodeSnapshot(recovery.snapshot),
				recovery.image
			)
		);
		this.restoredFiles += recovery.files.length;
		// what the cadence learned travels with the object, and this is a loss it has to learn from
		const learned = this.meta('cadence');
		this.cadence = new Cadence(
			{ minMs: Number(this.meta('min') ?? 5000) },
			learned ? JSON.parse(learned) : undefined
		);
		this.cadence.lost();
		this.saveCadence();
		return true;
	}

	/** the write-back arm: changed pages only, restored from the store */
	private async writebackCheckpoint() {
		const snapshot = await this.machine!.checkpoint();
		const cost = this.store!.writeCheckpoint(snapshot.memory, encodeSnapshot(snapshot));
		await this.ctx.storage.sync();
		const recovery = this.store!.recover()!;
		const memory = this.machine!.memory;
		this.machine = null;
		this.machine = await Machine.restore(
			{ ...this.options(), restoreFiles: recovery.files, memory: memory },
			decodeSnapshot(recovery.snapshot),
			recovery.image
		);
		// a deployed Worker's clock stands still while it computes, so the cost is modeled from what
		// the report measured: ~50 ms to unwind and rewind, 2 ms per MiB hashed, 0.2 ms per page written
		const mib = snapshot.memory.byteLength / (1 << 20);
		this.cadence.checkpointed(50 + 2 * mib + 0.2 * cost.changed, cost.rows);
		this.saveCadence();
		return cost;
	}

	private saveCadence() {
		this.sql.exec(
			'INSERT OR REPLACE INTO meta (k, v) VALUES (?, ?)',
			'cadence',
			JSON.stringify(this.cadence.learned)
		);
	}

	override async fetch(request: Request): Promise<Response> {
		const url = new URL(request.url);
		const q = (name: string, fallback: number) => Number(url.searchParams.get(name) ?? fallback);
		const who = { instance: this.instance };
		try {
			switch (url.pathname) {
				case '/burn': {
					let x = 1;
					const end = q('iters', 6e8);
					for (let i = 0; i < end; i++) x = (x * 1103515245 + 12345) | 0;
					return Response.json({ op: 'burn', x, ...who });
				}
				case '/start': {
					this.arm = url.searchParams.get('arm') ?? 'writeback';
					this.pages = q('pages', 800);
					this.store = new DurableStore(this.sql);
					this.cadence = new Cadence({ minMs: q('min', 5000) });
					this.ctx.storage.sql.exec('INSERT OR REPLACE INTO meta (k, v) VALUES (?, ?)', 'min', String(q('min', 5000)));
					this.ctx.storage.sql.exec('INSERT OR REPLACE INTO meta (k, v) VALUES (?, ?), (?, ?)', 'arm', this.arm, 'pages', String(this.pages));
					this.machine = this.keep(new Machine({ ...this.options(), memory: this.pooled() }));
					await this.run(25_000, () => this.output.includes('# '));
					this.machine.type(`${JOBS[url.searchParams.get('job') ?? 'write']}\n`);
					await this.run(2000);
					const before = this.sql.written;
					return Response.json({ op: 'start', arm: this.arm, rows: this.sql.written - before, tail: this.output.slice(-200), ...who });
				}
				case '/quantum': {
					const restored = !this.machine;
					if (restored) {
						if (!(await this.recoverLost())) return Response.json({ op: 'quantum', ok: false, reason: 'not booted', ...who });
						this.restores++;
					}
					const before = this.sql.written;
					const wall = q('wall', 5000);
					const outcome = await this.run(wall);
					let checkpoint: object | null = null;
					if (this.arm === 'quantum') {
						await this.quantumCheckpoint();
						this.checkpoints++;
						checkpoint = { full: true };
					} else {
						this.cadence.ran(wall);
						if (this.cadence.due) {
							checkpoint = await this.writebackCheckpoint();
							this.checkpoints++;
						}
					}
					return Response.json({
						op: 'quantum',
						outcome,
						rows: this.sql.written - before,
						checkpoint,
						interval: this.cadence.interval,
						lossMs: this.cadence.lossMs,
						progress: this.progress(),
						fsyncs: this.fsyncs,
						restored,
						restoredFiles: this.restoredFiles,
						...who
					});
				}
				case '/lose':
					// what a replaced instance sees: the machine gone, storage kept
					this.machine = null;
					return Response.json({ op: 'lose', ...who });
				case '/stop':
					// drop the machine so the next arm does not share an isolate with its memory
					this.machine = null;
					POOL.delete(this.ctx.id.toString());
					this.ctx.abort('arm done');
					return new Response('unreachable');
				case '/report':
					return Response.json({
						op: 'report',
						arm: this.arm,
						rows: this.sql.written,
						checkpoints: this.checkpoints,
						fsyncs: this.fsyncs,
						restores: this.restores,
						progress: this.progress(),
						stats: this.machine?.stats,
						tail: this.output.slice(-300),
						...who
					});
			}
			return new Response('unknown', { status: 404 });
		} catch (error) {
			return Response.json({ error: String(error), stack: (error as Error).stack, ...who }, { status: 500 });
		}
	}
}

export default {
	async fetch(request: Request, env: Env): Promise<Response> {
		const url = new URL(request.url);
		return env.MACHINE.get(env.MACHINE.idFromName(url.searchParams.get('do') ?? 'default')).fetch(request);
	}
} satisfies ExportedHandler<Env>;
