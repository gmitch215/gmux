import { WasmInterpreter } from '@drupflare/burrow/interpret';
import wasm3Module from '@drupflare/burrow/vendor/wasm3.wasm';
import { DurableObject } from 'cloudflare:workers';
import { deferred, type Deferred, expected, Machine } from './machine';
import guestBytes from './wasm/guest.bin';

interface Env {
	PROBE: DurableObjectNamespace<Probe>;
	ASSETS?: Fetcher;
}
interface Linked {
	fn: (...args: number[]) => unknown;
	arity: number;
	returns: boolean;
}

/** one burrow interpreter whose host calls suspend through JSPI instead of returning at once */
async function suspendingInterpreter() {
	const handlers: Linked[] = [];
	let shim: any;
	const hostCall = new WebAssembly.Suspending(async (id: number, sp: number) => {
		const linked = handlers[id];
		if (!linked) return 1;
		const base = linked.returns ? 1 : 0;
		const slots = new BigUint64Array(shim.memory.buffer, sp);
		const args: number[] = [];
		for (let i = 0; i < linked.arity; i++) {
			args.push(Number(BigInt.asIntN(32, slots[base + i] ?? 0n)));
		}
		const result = await linked.fn(...args);
		if (linked.returns && typeof result === 'number') {
			new BigUint64Array(shim.memory.buffer, sp)[0] = BigInt(result) & 0xffffffffn;
		}
		return 0;
	});
	const instance = await WebAssembly.instantiate(wasm3Module, {
		env: { emscripten_notify_memory_growth: () => {} },
		burrow: { host_call: hostCall }
	});
	shim = instance.exports;
	shim._initialize();
	if (shim.burrow_init(1024 * 1024, 0) !== 0) throw new Error('burrow_init failed');
	const vm = new (WasmInterpreter as any)(shim, handlers) as WasmInterpreter;
	const cstring = (value: string): number => {
		const bytes = new TextEncoder().encode(`${value}\0`);
		const ptr = shim.burrow_alloc(bytes.length);
		new Uint8Array(shim.memory.buffer).set(bytes, ptr);
		return ptr;
	};
	const callIn = WebAssembly.promising(shim.burrow_call_in);
	return { vm, shim, cstring, callIn };
}

export class Probe extends DurableObject<Env> {
	private readonly instance = crypto.randomUUID();

	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env);
	}

	private who() {
		return { instance: this.instance, now: Date.now() };
	}
	private async wasm3(interps: number, iters: number, depth: number) {
		const wakes = new Map<number, () => void>();
		const signals = new Map<number, Deferred>();
		let parks = 0;
		const block = (task: number, arg: number) => {
			parks++;
			return new Promise<number>((resolve) => {
				wakes.set(task, () => resolve(arg + 7));
				signals.get(task)?.resolve();
			});
		};
		const runs: { done: Promise<number>; result?: number }[] = [];
		for (let t = 0; t < interps; t++) {
			const { vm, cstring, callIn } = await suspendingInterpreter();
			const guest = vm.load(new Uint8Array(guestBytes), {
				imports: { host: { block: { signature: 'i(ii)', fn: block as any } } }
			});
			const parked = deferred();
			signals.set(t, parked);
			const entry: { done: Promise<number>; result?: number } = { done: Promise.resolve(0) };
			entry.done = callIn(guest.index, cstring('run'), t, iters, depth, 0).then(
				(v: bigint) => {
					entry.result = Number(BigInt.asIntN(32, v));
					return entry.result;
				}
			);
			runs.push(entry);
			await Promise.race([parked.promise, entry.done]);
		}
		let resumes = 0;
		while (wakes.size) {
			for (const t of [...wakes.keys()]) {
				const wake = wakes.get(t)!;
				wakes.delete(t);
				const parked = deferred();
				signals.set(t, parked);
				resumes++;
				wake();
				await Promise.race([parked.promise, runs[t]!.done]);
			}
		}
		const bad = runs.flatMap((r, t) => (r.result === expected(t, iters, depth) ? [] : [t]));
		return {
			interps,
			iters,
			depth,
			parks,
			resumes,
			ok: bad.length === 0,
			bad,
			results: runs.map((r) => r.result)
		};
	}

	override async fetch(request: Request): Promise<Response> {
		const url = new URL(request.url);
		const q = (n: string, f: number) => Number(url.searchParams.get(n) ?? f);
		const op = url.pathname.slice(1);
		const who = { op, instance: this.instance };
		try {
			switch (op) {
				case 'parks': {
					const tasks = q('tasks', 4);
					const iters = q('iters', 250);
					const depth = q('depth', 16);
					const machine = new Machine();
					await machine.start(tasks, iters, depth);
					await machine.drain();
					const verdict = machine.verify(tasks, iters, depth);
					return Response.json({
						op,
						tasks,
						iters,
						depth,
						parks: machine.parks,
						resumes: machine.resumes,
						kernelCalls: (machine.kernel.exports.calls as () => number)(),
						...verdict,
						...this.who()
					});
				}
				case 'memory': {
					const tasks = q('tasks', 100);
					const depth = q('depth', 0);
					const machine = new Machine();
					await machine.start(tasks, 1, depth);
					const parked = machine.wake.size;
					await machine.drain();
					const verdict = machine.verify(tasks, 1, depth);
					return Response.json({ op, tasks, depth, parked, ...verdict, ...this.who() });
				}
				case 'wasm3':
					return Response.json({
						op,
						...(await this.wasm3(q('interps', 1), q('iters', 1000), q('depth', 4))),
						...this.who()
					});

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
