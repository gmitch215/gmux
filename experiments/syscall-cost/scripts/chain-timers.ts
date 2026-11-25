import { writeFileSync } from 'node:fs';
import { Machine } from '../../../src/worker/machine/machine.ts';

/**
 * Timers around the host phases of the spawn chain, for census.ts: the Machine methods are wrapped from outside, so the
 * product carries nothing. Each phase reports calls and its own time (time in a wrapped callee is taken out), and the
 * wrapper's own cost is measured on an empty function and subtracted per call.
 *   PHASES=<file> node --no-warnings --experimental-strip-types chain-timers.ts <census workload>   (census.ts's env applies)
 * The file gets one JSON object: per phase `calls`, `selfUs` and `selfUsNet`, and `timerNs`, the wrapper's cost per call.
 */
const out = process.env.PHASES;
if (!out) throw new Error('PHASES=<file> names where the timers are written');
const names = [
	'lookup',
	'release',
	'abandon',
	'retire',
	'enterProgram',
	'recycledProgram',
	'program',
	'boundStack',
	'vforkStart',
	'vforkTerminal',
	'vforkChildStarts',
	'vforkParentBack'
];
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

const proto = Machine.prototype as unknown as Record<string, (...args: any[]) => any>;
for (const name of names) {
	const original = proto[name];
	if (typeof original !== 'function') throw new Error(`Machine has no ${name}`);
	proto[name] = wrap(name, original);
}

// the wrapper's cost: an empty function wrapped and called under another wrapper, as the real ones nest
function timerNs(): number {
	const probe = wrap('probe', () => 0);
	const outer = wrap('outer', () => {
		for (let i = 0; i < 200000; i++) probe();
	});
	outer();
	const total = Number(self.get('outer') ?? 0n) + Number(self.get('probe') ?? 0n);
	const per = total / 200000;
	calls.delete('probe');
	calls.delete('outer');
	self.delete('probe');
	self.delete('outer');
	return per;
}
const overhead = timerNs();

process.on('exit', () => {
	const phases: Record<string, { calls: number; selfUs: number; selfUsNet: number }> = {};
	for (const name of names) {
		const n = calls.get(name) ?? 0;
		const us = Number(self.get(name) ?? 0n) / 1000;
		phases[name] = {
			calls: n,
			selfUs: +us.toFixed(1),
			selfUsNet: +Math.max(us - (n * overhead) / 1000, 0).toFixed(1)
		};
	}
	writeFileSync(out, JSON.stringify({ timerNs: +overhead.toFixed(1), phases }));
});

await import('./census.ts');
