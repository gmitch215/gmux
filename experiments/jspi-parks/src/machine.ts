import kernelModule from './wasm/kernel.wasm';
import processModule from './wasm/process.wasm';

export interface Deferred<T = void> {
	promise: Promise<T>;
	resolve: (value: T) => void;
}

export function deferred<T = void>(): Deferred<T> {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((r) => (resolve = r));
	return { promise, resolve };
}

/** the value `run` must return, computed outside wasm */
export function expected(task: number, iters: number, depth: number): number {
	let sum = 0;
	const frames = (1000 * depth * (depth + 1)) / 2;
	for (let i = 0; i < iters; i++) {
		const sys = (Math.imul(i, 3) + task + (i + 7)) | 0;
		sum = (sum + sys + frames + Math.imul(depth, i)) | 0;
	}
	return sum;
}

type Run = (task: number, iters: number, depth: number) => Promise<number>;

/**
 * Tasks share one "process" instance and call one "kernel" instance; every syscall parks the
 * task's whole stack through a Suspending import until the scheduler wakes it.
 */
export class Machine {
	readonly wake = new Map<number, () => void>();
	readonly signal = new Map<number, Deferred>();
	readonly done = new Map<number, Promise<number>>();
	readonly results = new Map<number, number>();
	parks = 0;
	resumes = 0;
	readonly kernel: WebAssembly.Instance;
	private readonly run: Run;

	constructor() {
		const block = new WebAssembly.Suspending((task: number, arg: number) => {
			this.parks++;
			return new Promise<number>((resolve) => {
				this.wake.set(task, () => resolve(arg + 7));
				this.signal.get(task)?.resolve();
			});
		});
		this.kernel = new WebAssembly.Instance(kernelModule, { host: { block } });
		const proc = new WebAssembly.Instance(processModule, {
			kernel: { syscall: this.kernel.exports.syscall }
		});
		this.run = WebAssembly.promising(proc.exports.run as Function) as Run;
	}

	async start(tasks: number, iters: number, depth: number): Promise<void> {
		for (let t = 0; t < tasks; t++) {
			const parked = deferred();
			this.signal.set(t, parked);
			const done = this.run(t, iters, depth).then((v) => {
				this.results.set(t, v);
				return v;
			});
			this.done.set(t, done);
			await Promise.race([parked.promise, done]);
		}
	}

	async step(task: number): Promise<void> {
		const wake = this.wake.get(task);
		if (!wake) return;
		this.wake.delete(task);
		const parked = deferred();
		this.signal.set(task, parked);
		this.resumes++;
		wake();
		await Promise.race([parked.promise, this.done.get(task)]);
	}

	async drain(): Promise<void> {
		while (this.wake.size) {
			for (const task of [...this.wake.keys()]) await this.step(task);
		}
	}

	verify(tasks: number, iters: number, depth: number): { ok: boolean; bad: number[] } {
		const bad: number[] = [];
		for (let t = 0; t < tasks; t++) {
			if (this.results.get(t) !== expected(t, iters, depth)) bad.push(t);
		}
		return { ok: bad.length === 0, bad };
	}
}

/** the rig's machine: tasks share a process instance and call a kernel instance; every syscall parks */
export async function parkTasks(tasks: number, depth: number) {
	const wake = new Map<number, () => void>();
	const signal = new Map<number, Deferred>();
	const block = new WebAssembly.Suspending((t: number, arg: number) => {
		return new Promise<number>((resolve) => {
			wake.set(t, () => resolve(arg + 7));
			signal.get(t)?.resolve();
		});
	});
	const kernel = new WebAssembly.Instance(kernelModule, { host: { block } });
	const proc = new WebAssembly.Instance(processModule, {
		kernel: { syscall: kernel.exports.syscall }
	});
	const run = WebAssembly.promising(proc.exports.run as Function);
	const done: Promise<number>[] = [];
	for (let t = 0; t < tasks; t++) {
		const d = deferred();
		signal.set(t, d);
		const p = run(t, 1, depth) as Promise<number>;
		done.push(p);
		await Promise.race([d.promise, p]);
	}
	return {
		parked: wake.size,
		drain: async () => {
			for (const w of wake.values()) w();
			await Promise.all(done);
		}
	};
}
