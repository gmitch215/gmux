import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Times the machine's scheduling loop under a load of pipe-connected or sleeping busybox tasks:
 * boots build/kernel, sets the load up, then runs a fixed number of pump steps and reports the
 * host time per step and per task switch (time the host spent waiting on timers is left out).
 * MACHINE names the machine module to time (default src/worker/machine/machine.ts, a copy of an
 * older one for a baseline), CORE=1 passes the C scheduler core, TRACE=<file> writes the `resume`
 * trace lines of the window, GMUX_BUILD points at another build.
 * `node --experimental-strip-types experiments/core-sched/scripts/load.ts <ring|sleepers> <tasks> [steps]`
 */
const root = new URL('../../../', import.meta.url).pathname;
const kernel = join(process.env.GMUX_BUILD ?? join(root, 'build'), 'kernel');
const read = (path: string) => new Uint8Array(readFileSync(path));
const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const manifest = JSON.parse(readFileSync(join(kernel, 'manifest.json'), 'utf8'));
if (process.env.FROZEN) {
	// the kernel seeds hashes and layouts from the host's random bytes; a fixed stream makes a run repeat
	let seed = 0x9e3779b9;
	Object.defineProperty(globalThis.crypto, 'getRandomValues', {
		value: (data: Uint8Array) => {
			for (let i = 0; i < data.length; i++) {
				seed ^= seed << 13;
				seed ^= seed >>> 17;
				seed ^= seed << 5;
				data[i] = seed & 0xff;
			}
			return data;
		}
	});
}
const { Machine } = await import(
	process.env.MACHINE ?? join(root, 'src/worker/machine/machine.ts')
);

const [kind, tasksArg, stepsArg] = process.argv.slice(2);
if (kind !== 'ring' && kind !== 'sleepers') {
	console.error('usage: load.ts <ring|sleepers> <tasks> [steps]');
	process.exit(2);
}
const tasks = Number(tasksArg ?? 4);
const steps = Number(stepsArg ?? 20000);
const tokens = Math.max(1, tasks >> 2);

// a ring of cat processes joined by fifos, opened read-write so no open waits on its neighbour,
// with a few tokens circulating; or sleepers plus two cats passing one token back and forth
const setup =
	kind === 'ring'
		? [
				'mkdir -p /r; cd /r',
				`i=0; while [ $i -lt ${tasks} ]; do mkfifo f$i; i=$((i+1)); done`,
				`i=0; while [ $i -lt ${tasks} ]; do j=$((i+1)); [ $j -eq ${tasks} ] && j=0; cat 0<> f$i 1<> f$j & i=$((i+1)); done`,
				`t=0; while [ $t -lt ${tokens} ]; do echo x 1<> f$((t*${tasks}/${tokens})); t=$((t+1)); done`
			]
		: [
				'mkdir -p /r; cd /r; mkfifo wa wb',
				`i=0; while [ $i -lt ${tasks} ]; do sleep 100000 & i=$((i+1)); done`,
				'cat 0<> wa 1<> wb & cat 0<> wb 1<> wa & echo x 1<> wa'
			];

let output = '';
const lines: string[] = [];
const machine = new Machine({
	vmlinux: new WebAssembly.Module(read(join(kernel, 'vmlinux.wasm'))),
	initrd: read(join(kernel, 'initramfs.bin')),
	cmdline: 'maxcpus=3 root=/dev/ram0 rootfstype=ramfs init=/init console=hvc console=ttyS0',
	registry: new Map([[manifest.busybox, new WebAssembly.Module(read(join(kernel, 'busybox.wasm')))]]),
	maximumPages: 4096,
	sha256,
	sharedKernel: true,
	...(process.env.FROZEN ? { now: () => 0n } : {}),
	...(process.env.CORE ? { core: new WebAssembly.Module(read(process.env.CORE)) } : {}),
	trace: Boolean(process.env.TRACE),
	log: (line: string) => process.env.TRACE && lines.push(line),
	write: (text: string) => {
		output += text;
		if (process.env.PHASE === 'echo') process.stderr.write(text);
	}
});

let slept = 0;
const sleep = async (ms: number) => {
	const t = performance.now();
	await new Promise((r) => setTimeout(r, Math.min(ms, 5)));
	slept += performance.now() - t;
};
const run = async (until: () => boolean, budget = Infinity) => {
	const t = Date.now();
	let n = 0;
	return machine.run(() => until() || (++n % 4096 === 0 && Date.now() - t > 600_000), sleep, budget);
};

const phase = (name: string) =>
	process.env.PHASE && console.error(`${(performance.now() / 1000).toFixed(1)}s ${name}`);
await run(() => output.includes('# '));
phase('booted');
const at = output.length;
machine.type(`${setup.join('\n')}\necho SETUP$((6*7))\n`);
await run(() => output.slice(at).includes('SETUP42'));
phase('set up');
if (process.env.SHOWSETUP) console.log(output.slice(at));
// let the load reach its steady state before the window
await run(() => false, 5000);
phase('warm');
if (process.env.TRACE) lines.length = 0;

const before = { ...machine.stats };
const session = process.env.PROF ? new (await import('node:inspector')).Session() : null;
let profile: unknown = null;
if (session) {
	session.connect();
	session.post('Profiler.enable');
	session.post('Profiler.setSamplingInterval', { interval: 100 });
	session.post('Profiler.start');
}
slept = 0;
const t0 = performance.now();
const why = await run(() => false, steps);
const wall = performance.now() - t0 - slept;
if (session) session.post('Profiler.stop', (_, result) => (profile = result.profile));
if (profile) {
	const { writeFileSync } = await import('node:fs');
	writeFileSync(process.env.PROF!, JSON.stringify(profile));
}
const after = machine.stats;
const table = (machine as any).runners as Map<number, { idle: unknown }>;
let idling = 0;
for (const r of table.values()) if (r.idle) idling++;
const switches = after.switches - before.switches;
console.log(
	JSON.stringify({
		kind,
		tasks,
		core: Boolean(process.env.CORE),
		why,
		steps,
		runners: after.runners,
		mapSize: table.size,
		idling,
		switches,
		idles: after.idles - before.idles,
		relaxes: after.relaxes - before.relaxes,
		windowMs: +wall.toFixed(1),
		slept: +slept.toFixed(1),
		nsPerStep: Math.round((wall * 1e6) / steps),
		nsPerSwitch: switches ? Math.round((wall * 1e6) / switches) : null
	})
);
if (process.env.PROBE) {
	const from = output.length;
	machine.type(`${process.env.PROBE}\necho PROBE$((6*7))\n`);
	await run(() => output.slice(from).includes('PROBE42'));
	console.log(output.slice(from));
}
if (process.env.TRACE) {
	const { writeFileSync } = await import('node:fs');
	writeFileSync(
		process.env.TRACE,
		lines
			.filter((l) => l.startsWith('resume '))
			.join('\n')
			.concat('\n')
	);
}
process.exit(why === 'budget' ? 0 : 1);
