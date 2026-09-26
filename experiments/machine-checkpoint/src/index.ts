import { DurableObject } from 'cloudflare:workers';
import kernelAsync from './wasm/kernel.async.wasm';
import kernelPlain from './wasm/kernel.wasm';
import processAsync from './wasm/process.async.wasm';
import processPlain from './wasm/process.wasm';
import vmlinux from './wasm/vmlinux.wasm';

interface Env {
	PROBE: DurableObjectNamespace<Probe>;
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

/** the value `run` must return, computed outside wasm */
function expected(task: number, iters: number, depth: number): number {
	let sum = 0;
	const frames = (1000 * depth * (depth + 1)) / 2;
	for (let i = 0; i < iters; i++) {
		sum = (sum + Math.imul(i, 3) + task + (i + 7) + frames + Math.imul(depth, i)) | 0;
	}
	return sum;
}

const PAGES = 2;
const KERNEL_BUF = (t: number) => 0x1000 + t * 0x800;
const PROCESS_BUF = (t: number) => 0x8000 + t * 0x2000;
const KERNEL_BUF_SIZE = 0x800;
const PROCESS_BUF_SIZE = 0x2000;

type Wake = 'run' | 'unwind';

interface Task {
	id: number;
	kernel: WebAssembly.Instance;
	proc: WebAssembly.Instance;
	run: (task: number, iters: number, depth: number) => Promise<number>;
	wake: ((cmd: Wake) => void) | null;
	parked: Deferred;
	done: Promise<number | null>;
	result: number | null;
	rewinding: boolean;
	unwinding: boolean;
	log: number[];
	replay: number[];
}

type Mode = 'async' | 'plain';

/**
 * Tasks share one memory; each has its own kernel and process instance, the shape of linux-wasm
 * (one vmlinux instance per task over a shared memory). Warm switches are JSPI; a checkpoint turns
 * every JSPI-parked stack into Asyncify state in linear memory.
 */
class Machine {
	readonly memory = new WebAssembly.Memory({ initial: PAGES });
	readonly tasks: Task[] = [];
	parks = 0;
	resumes = 0;

	constructor(
		readonly mode: Mode,
		readonly iters: number,
		readonly depth: number
	) {}

	private exports(t: Task) {
		return {
			kernel: t.kernel.exports as Record<string, Function>,
			proc: t.proc.exports as Record<string, Function>
		};
	}

	private instantiate(id: number, replay: number[] = []): Task {
		const task = {} as Task;
		task.id = id;
		task.wake = null;
		task.parked = deferred();
		task.result = null;
		task.rewinding = false;
		task.unwinding = false;
		task.log = [];
		task.replay = replay;
		const block = new WebAssembly.Suspending((t: number, arg: number) => {
			const st = this.tasks[t]!;
			if (st.rewinding) {
				const { kernel, proc } = this.exports(st);
				kernel.asyncify_stop_rewind!();
				proc.asyncify_stop_rewind!();
				st.rewinding = false;
			}
			// replay answers from the log without parking, the way a restore re-drives a process
			if (st.replay.length) {
				const value = st.replay.shift()!;
				st.log.push(value);
				return value;
			}
			this.parks++;
			return new Promise<number>((resolve) => {
				st.wake = (cmd) => {
					if (cmd === 'unwind') {
						const { kernel, proc } = this.exports(st);
						const view = new DataView(this.memory.buffer);
						view.setUint32(KERNEL_BUF(t), KERNEL_BUF(t) + 8, true);
						view.setUint32(KERNEL_BUF(t) + 4, KERNEL_BUF(t) + KERNEL_BUF_SIZE, true);
						view.setUint32(PROCESS_BUF(t), PROCESS_BUF(t) + 8, true);
						view.setUint32(PROCESS_BUF(t) + 4, PROCESS_BUF(t) + PROCESS_BUF_SIZE, true);
						kernel.asyncify_start_unwind!(KERNEL_BUF(t));
						proc.asyncify_start_unwind!(PROCESS_BUF(t));
						st.unwinding = true;
						resolve(0);
						return;
					}
					const value = arg + 7;
					st.log.push(value);
					resolve(value);
				};
				st.parked.resolve();
			});
		});
		const kernelModule = this.mode === 'async' ? kernelAsync : kernelPlain;
		const processModule = this.mode === 'async' ? processAsync : processPlain;
		task.kernel = new WebAssembly.Instance(kernelModule, {
			env: { memory: this.memory },
			host: { block }
		});
		task.proc = new WebAssembly.Instance(processModule, {
			env: { memory: this.memory },
			kernel: { syscall: task.kernel.exports.syscall }
		});
		task.run = WebAssembly.promising(task.proc.exports.run as Function) as Task['run'];
		this.tasks[id] = task;
		return task;
	}

	private launch(task: Task): Promise<void> {
		task.done = task.run(task.id, this.iters, this.depth).then((v) => {
			if (task.unwinding) {
				const { kernel, proc } = this.exports(task);
				kernel.asyncify_stop_unwind!();
				proc.asyncify_stop_unwind!();
				task.unwinding = false;
				return null;
			}
			task.result = v;
			return v;
		});
		return Promise.race([task.parked.promise, task.done.then(() => undefined)]);
	}

	async start(count: number): Promise<void> {
		for (let t = 0; t < count; t++) await this.launch(this.instantiate(t));
	}

	/** wakes each parked task once, round robin, `rounds` times */
	async step(rounds: number): Promise<void> {
		for (let r = 0; r < rounds; r++) {
			for (const task of this.tasks) {
				if (!task.wake) continue;
				const wake = task.wake;
				task.wake = null;
				task.parked = deferred();
				this.resumes++;
				wake('run');
				await Promise.race([task.parked.promise, task.done.then(() => undefined)]);
			}
		}
	}

	async drain(): Promise<void> {
		while (this.tasks.some((t) => t.wake)) await this.step(1);
	}

	/** unwinds every parked task into linear memory and returns the image */
	async unwindAll(): Promise<{ memory: Uint8Array; tasks: object[] }> {
		for (const task of this.tasks) {
			if (!task.wake) continue;
			const wake = task.wake;
			task.wake = null;
			wake('unwind');
			await task.done;
		}
		return {
			memory: new Uint8Array(this.memory.buffer).slice(),
			tasks: this.tasks.map((t) => ({ id: t.id, result: t.result, log: t.log }))
		};
	}

	/** rebuilds tasks from an image; Asyncify rewinds each parked stack back into its JSPI park */
	async rewindAll(
		image: Uint8Array,
		tasks: { id: number; result: number | null }[]
	): Promise<void> {
		new Uint8Array(this.memory.buffer).set(image);
		for (const saved of tasks) {
			const task = this.instantiate(saved.id);
			if (saved.result !== null) {
				task.result = saved.result;
				task.done = Promise.resolve(saved.result);
				continue;
			}
			const { kernel, proc } = this.exports(task);
			kernel.asyncify_start_rewind!(KERNEL_BUF(saved.id));
			proc.asyncify_start_rewind!(PROCESS_BUF(saved.id));
			task.rewinding = true;
			await this.launch(task);
		}
	}

	/** rebuilds tasks from logs alone: fresh memory, every syscall answered from the log until it runs out */
	async replayAll(tasks: { id: number; result: number | null; log: number[] }[]): Promise<void> {
		for (const saved of tasks) await this.launch(this.instantiate(saved.id, [...saved.log]));
	}

	verify(count: number) {
		const bad: number[] = [];
		for (let t = 0; t < count; t++) {
			if (this.tasks[t]?.result !== expected(t, this.iters, this.depth)) bad.push(t);
		}
		const kernelCalls = new DataView(this.memory.buffer).getUint32(0, true);
		return { ok: bad.length === 0, bad, kernelCalls, expectedKernelCalls: count * this.iters };
	}
}

export class Probe extends DurableObject<Env> {
	private readonly instance = crypto.randomUUID();
	private machine: Machine | null = null;

	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env);
		ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS ckpt (k TEXT PRIMARY KEY, v BLOB)');
	}

	override async fetch(request: Request): Promise<Response> {
		const url = new URL(request.url);
		const q = (name: string, fallback: number) =>
			Number(url.searchParams.get(name) ?? fallback);
		const op = url.pathname.split('/').pop();
		const tasks = q('tasks', 4);
		const iters = q('iters', 50);
		const depth = q('depth', 16);
		const mode = (url.searchParams.get('mode') ?? 'async') as Mode;
		const who = { instance: this.instance };
		try {
			switch (op) {
				case 'warm': {
					const m = new Machine(mode, iters, depth);
					await m.start(tasks);
					await m.drain();
					return Response.json({ op, mode, parks: m.parks, ...m.verify(tasks), ...who });
				}
				case 'park': {
					this.machine = new Machine(mode, iters, depth);
					await this.machine.start(tasks);
					await this.machine.step(q('rounds', 20));
					return Response.json({ op, mode, parks: this.machine.parks, ...who });
				}
				case 'checkpoint': {
					if (!this.machine)
						return Response.json({ op, ok: false, reason: 'nothing parked', ...who });
					const replay = url.searchParams.get('arm') === 'replay';
					const image = replay
						? {
								memory: new Uint8Array(0),
								tasks: this.machine.tasks.map((t) => ({
									id: t.id,
									result: t.result,
									log: t.log
								}))
							}
						: await this.machine.unwindAll();
					const meta = JSON.stringify({
						mode: this.machine.mode,
						iters,
						depth,
						arm: replay ? 'replay' : 'asyncify',
						tasks: image.tasks
					});
					this.ctx.storage.sql.exec(
						'INSERT OR REPLACE INTO ckpt (k, v) VALUES (?, ?)',
						'memory',
						image.memory
					);
					this.ctx.storage.sql.exec(
						'INSERT OR REPLACE INTO ckpt (k, v) VALUES (?, ?)',
						'meta',
						meta
					);
					if (url.searchParams.get('sync') !== '0') await this.ctx.storage.sync();
					const stored = this.ctx.storage.sql
						.exec('SELECT count(*) AS n FROM ckpt')
						.one().n;
					return Response.json({
						op,
						bytes: image.memory.byteLength,
						metaBytes: meta.length,
						rows: 2,
						stored,
						...who
					});
				}
				case 'evict':
					this.ctx.abort('g7 forced eviction');
					return new Response('unreachable');
				case 'restore': {
					const rows = this.ctx.storage.sql.exec('SELECT k, v FROM ckpt').toArray();
					const get = (k: string) => rows.find((r) => r.k === k)?.v;
					const meta = JSON.parse(String(get('meta')));
					const m = new Machine(meta.mode, meta.iters, meta.depth);
					if (meta.arm === 'replay') await m.replayAll(meta.tasks);
					else
						await m.rewindAll(new Uint8Array(get('memory') as ArrayBuffer), meta.tasks);
					this.machine = m;
					return Response.json({
						op,
						arm: meta.arm,
						parked: m.tasks.filter((t) => t.wake).length,
						...who
					});
				}
				case 'finish': {
					if (!this.machine)
						return Response.json({ op, ok: false, reason: 'nothing parked', ...who });
					await this.machine.drain();
					return Response.json({
						op,
						...this.machine.verify(tasks),
						resumes: this.machine.resumes,
						...who
					});
				}
				case 'vmlinux': {
					const maximum = q('max', 2048);
					const memory = new WebAssembly.Memory({ initial: 15, maximum, shared: true });
					const imports: Record<string, unknown> = { memory };
					for (const i of WebAssembly.Module.imports(vmlinux)) {
						if (i.kind === 'function')
							imports[i.name] = () => {
								throw new Error(`stub ${i.name}`);
							};
					}
					const instance = new WebAssembly.Instance(vmlinux, {
						env: imports as WebAssembly.ModuleImports
					});
					return Response.json({
						op,
						maximum,
						shared: memory.buffer instanceof SharedArrayBuffer,
						bytesAfterStart: memory.buffer.byteLength,
						exports: Object.keys(instance.exports).length,
						...who
					});
				}
				case 'who':
					return Response.json({ op, machine: !!this.machine, ...who });
			}
			return new Response('unknown op', { status: 404 });
		} catch (error) {
			return Response.json(
				{ op, error: String(error), stack: (error as Error).stack, ...who },
				{ status: 500 }
			);
		}
	}
}

export default {
	async fetch(request: Request, env: Env): Promise<Response> {
		const url = new URL(request.url);
		const name = url.searchParams.get('do') ?? 'default';
		return env.PROBE.get(env.PROBE.idFromName(name)).fetch(request);
	}
} satisfies ExportedHandler<Env>;
