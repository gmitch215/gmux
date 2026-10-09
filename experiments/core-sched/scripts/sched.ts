import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * The scheduler's decisions alone, with no kernel under them: a machine's own pickIdle, arm and
 * nextDeadline over a table of `k` idle cpus among `k + 450` runners (the kernel's threads are
 * runners too), timed per call. `wake` raises one cpu's word each iteration, picks it and arms it
 * again; `quiet` polls a table where nothing is due, as a step does while every cpu waits on a
 * timer. MACHINE names the machine module (default: the working tree's), CORE the C core module,
 * ARM the label to print.
 * `node --experimental-strip-types experiments/core-sched/scripts/sched.ts <k> [iterations] [runs]`
 */
const root = new URL('../../../', import.meta.url).pathname;
const { Machine } = await import(process.env.MACHINE ?? join(root, 'src/worker/machine/machine.ts'));
const k = Number(process.argv[2] ?? 64);
const iterations = Number(process.argv[3] ?? 500_000);
const runs = Number(process.argv[4] ?? 3);
const core = process.env.CORE ? new WebAssembly.Module(readFileSync(process.env.CORE)) : undefined;
const empty = new WebAssembly.Module(new Uint8Array([0, 0x61, 0x73, 0x6d, 1, 0, 0, 0]));
const FILLER = 450;
const WORDS = 0x1000;

function build() {
	const machine: any = new Machine({
		vmlinux: empty,
		initrd: new Uint8Array(0),
		cmdline: '',
		registry: new Map(),
		sha256: () => '',
		maximumPages: 64,
		now: () => 0n,
		// a baseline machine.ts takes `core`, the current one `runtime.core`
		...(core ? { core, runtime: { core } } : {})
	});
	if (core) machine.startCore(machine.memory.grow(1) * 0x10000);
	const idlers: any[] = [];
	for (let i = 0; i < k + FILLER; i++) {
		const runner = machine.runner(`r${i}`, { kind: 'boot' });
		runner.id = 0x100000 + i * 0x800;
		machine.runners.set(runner.id, runner);
		if (i % Math.max(1, Math.floor((k + FILLER) / k)) === 0 && idlers.length < k) idlers.push(runner);
	}
	const arm = (runner: any, at: number, deadline: bigint) =>
		machine.arm ? machine.arm(runner, WORDS + at * 8, deadline) : (runner.idle = { word: WORDS + at * 8, deadline });
	return { machine, idlers, arm };
}

function wake() {
	const { machine, idlers, arm } = build();
	const words = new BigInt64Array(machine.memory.buffer);
	idlers.forEach((r, i) => arm(r, i, 1_000_000n + BigInt(i)));
	const t0 = performance.now();
	for (let n = 0; n < iterations; n++) {
		const at = n % k;
		words[WORDS / 8 + at] = 1n;
		const picked = machine.pickIdle(true);
		if (picked !== idlers[at]) throw new Error(`picked the wrong cpu at ${n}`);
		picked.idle = null;
		words[WORDS / 8 + at] = 0n;
		arm(picked, at, 1_000_000n + BigInt(n));
	}
	return ((performance.now() - t0) * 1e6) / iterations;
}

function quiet() {
	const { machine, idlers, arm } = build();
	idlers.forEach((r, i) => arm(r, i, 1_000_000n + BigInt(i)));
	const t0 = performance.now();
	for (let n = 0; n < iterations; n++) if (machine.pickIdle(true) !== null) throw new Error('woke');
	return ((performance.now() - t0) * 1e6) / iterations;
}

function deadline() {
	const { machine, idlers, arm } = build();
	idlers.forEach((r, i) => arm(r, i, 1_000_000n + BigInt(i)));
	const t0 = performance.now();
	for (let n = 0; n < iterations; n++) if (machine.nextDeadline() === null) throw new Error('none');
	return ((performance.now() - t0) * 1e6) / iterations;
}

// what a call into the module costs against the same work on a JS array: the ready queue's
// push and shift, and a call that does nothing
function crossing(kind: 'noop' | 'queue-js' | 'queue-core') {
	const exports = build().machine.core;
	const queue: number[] = [];
	const t0 = performance.now();
	if (kind === 'noop') for (let n = 0; n < iterations; n++) exports.core_idle_count();
	else if (kind === 'queue-core')
		for (let n = 0; n < iterations; n++) {
			exports.core_ready_push(n & 63);
			exports.core_ready_shift();
		}
	else
		for (let n = 0; n < iterations; n++) {
			queue.push(n & 63);
			queue.shift();
		}
	return ((performance.now() - t0) * 1e6) / iterations;
}

const loads: (readonly [string, () => number])[] = [
	['wake', wake],
	['quiet', quiet],
	['deadline', deadline]
];
if (core)
	loads.push(
		['noop call', () => crossing('noop')],
		['queue push+shift, core', () => crossing('queue-core')],
		['queue push+shift, array', () => crossing('queue-js')]
	);
for (const [name, fn] of loads) {
	const samples = Array.from({ length: runs }, () => fn());
	console.log(
		JSON.stringify({
			arm: process.env.ARM ?? (core ? 'core' : 'ts'),
			load: name,
			idle: k,
			runners: k + FILLER,
			nsPerCall: samples.map((s) => +s.toFixed(1))
		})
	);
}
