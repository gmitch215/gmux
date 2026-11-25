import { writeFileSync } from 'node:fs';
import { Ingress } from '../../../src/worker/machine/ingress.ts';
import { Machine } from '../../../src/worker/machine/machine.ts';

/**
 * A preload that times named methods of `Machine` and `Ingress` from outside, so the product carries nothing: each reports
 * its calls and its own time (time in a wrapped callee is taken out, and the wrapper's cost, measured on an empty
 * function, is subtracted per call), and the process's wall from the preload to exit. An async method is timed over its
 * synchronous part only, which is the host's own CPU before it first awaits.
 *   METHODS=drainConsole,fillDeferred OUT=<file> node --import ./method-timers.ts <script> [args]
 * METHODS lists `name` for Machine or `Ingress.name`. The file gets one JSON object.
 */
const out = process.env.OUT;
const wanted = (process.env.METHODS ?? '').split(',').filter(Boolean);
if (!out || !wanted.length) throw new Error('OUT=<file> and METHODS=<names> are required');
const calls = new Map<string, number>();
const self = new Map<string, bigint>();
const stack: { name: string; child: bigint }[] = [];
const now = () => process.hrtime.bigint();

function wrap<F extends (...args: any[]) => any>(name: string, fn: F): F {
	return function (this: unknown, ...args: any[]) {
		const frame = { name, child: 0n };
		stack.push(frame);
		const start = now();
		try {
			return fn.apply(this, args);
		} finally {
			const took = now() - start;
			stack.pop();
			if (stack.length) stack[stack.length - 1]!.child += took;
			calls.set(name, (calls.get(name) ?? 0) + 1);
			self.set(name, (self.get(name) ?? 0n) + took - frame.child);
		}
	} as F;
}

for (const name of wanted) {
	const [owner, method] = name.includes('.') ? name.split('.') : ['Machine', name];
	const proto = (owner === 'Ingress' ? Ingress : Machine).prototype as unknown as Record<
		string,
		(...args: any[]) => any
	>;
	const original = proto[method!];
	if (typeof original !== 'function') throw new Error(`${owner} has no ${method}`);
	proto[method!] = wrap(name, original);
}

function timerNs(): number {
	const probe = wrap('probe', () => 0);
	const outer = wrap('outer', () => {
		for (let i = 0; i < 200000; i++) probe();
	});
	outer();
	const per = (Number(self.get('outer') ?? 0n) + Number(self.get('probe') ?? 0n)) / 200000;
	for (const name of ['probe', 'outer']) {
		calls.delete(name);
		self.delete(name);
	}
	return per;
}
const overhead = timerNs();
const start = performance.now();

process.on('exit', () => {
	const methods: Record<string, { calls: number; selfUs: number; selfUsNet: number }> = {};
	for (const name of wanted) {
		const n = calls.get(name) ?? 0;
		const us = Number(self.get(name) ?? 0n) / 1000;
		methods[name] = {
			calls: n,
			selfUs: +us.toFixed(1),
			selfUsNet: +Math.max(0, us - (n * overhead) / 1000).toFixed(1)
		};
	}
	writeFileSync(
		out,
		JSON.stringify({ timerNs: +overhead.toFixed(1), wallMs: +(performance.now() - start).toFixed(1), methods })
	);
});
