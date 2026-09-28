import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Keeper, type KeeperHost } from '../../../src/worker/keeper.ts';
import { sqlite } from './sqlite.ts';

/**
 * CPU per event of the site's pump, under a clock that stands still while code runs, as a deployed
 * Worker's does. A new event starts on the real clock and a storage sync catches it up; a timer moves
 * it by its own delay only (CLOCK=real: a timer catches it up too). Each event is one pump of QUANTUM
 * ms, as a warm tick or an alarm gives it, stopped by the keeper's turn budget (BOUND=clock: by the
 * wall budget alone, as the site did before), then the keeper's checkpoint when due. After REPLACE
 * events the keeper is dropped and a new one restores the machine, as a replaced object's does.
 * Prints each event's CPU split into the restore, the run and the keeper's work.
 * `node --experimental-strip-types experiments/write-back/scripts/event-cpu.ts` (JOB=write|cpu)
 */
const root = new URL('../../../', import.meta.url).pathname;
const kernel = (name: string) => new Uint8Array(readFileSync(join(root, 'build/kernel', name)));
const manifest = JSON.parse(readFileSync(join(root, 'build/kernel/manifest.json'), 'utf8'));
const modules = {
	vmlinux: new WebAssembly.Module(kernel('vmlinux.async.wasm')),
	busybox: new WebAssembly.Module(kernel('busybox.async.wasm')),
	guard: new WebAssembly.Module(kernel('busybox.guard.wasm')),
	katybug: new WebAssembly.Module(kernel('katybug.wasm'))
};
const QUANTUM = Number(process.env.QUANTUM ?? 5000);
const EVENTS = Number(process.env.EVENTS ?? 10);
const REPLACE = Number(process.env.REPLACE ?? 5);
// an event this long is reported unbounded and stopped, so the rig ends
const GIVE_UP_MS = 60_000;
const JOBS: Record<string, string> = {
	write:
		'mkdir -p /data; x=$(seq 1 8000); i=0; while :; do f=/data/f$((i % 16)); echo "$i $x" > $f; ' +
		'[ $((i % 256)) = 0 ] && fsync $f; i=$((i + 1)); [ $((i % 64)) = 0 ] && echo W$i; done &\n',
	cpu: 'i=0; while :; do i=$((i + 1)); [ $((i % 5000)) = 0 ] && echo C$i; done &\n'
};

const real = () => performance.timeOrigin + performance.now();
let frozen = real();
Date.now = () => Math.floor(frozen);
const catchUp = () => void (frozen = real());
const wait = (ms: number) =>
	new Promise<void>((r) =>
		setTimeout(() => {
			if (process.env.CLOCK === 'real') catchUp();
			else frozen += ms;
			r();
		}, ms)
	);
const cpu = () => {
	const u = process.cpuUsage();
	return (u.user + u.system) / 1000;
};

const sql = sqlite();
let alarm: number | null = null;
let output = '';
let memory: WebAssembly.Memory | undefined;
let syncs = 0;
const host: KeeperHost = {
	sql,
	alarms: { getAlarm: () => alarm, setAlarm: (at) => void (alarm = at) },
	sync: async () => {
		syncs++;
		await new Promise((r) => setImmediate(r));
		catchUp();
	},
	options: () => ({
		vmlinux: modules.vmlinux,
		initrd: kernel('initramfs.bin'),
		cmdline: 'maxcpus=3 root=/dev/ram0 rootfstype=ramfs init=/init console=hvc console=ttyS0',
		registry: new Map([
			[manifest.busybox, modules.busybox],
			[manifest.katybug, modules.katybug]
		]),
		guarded: new Map([[manifest.busybox, modules.guard]]),
		maximumPages: 800,
		sharedKernel: true,
		asyncify: true,
		memory,
		sha256: (bytes) => createHash('sha256').update(bytes).digest('hex'),
		write: (text) => (output = (output + text).slice(-4000))
	})
};
let keeper = new Keeper(host);

/** one event: the site's pump, then the keeper */
async function event(typed = '') {
	catchUp();
	const c0 = cpu();
	const w0 = real();
	const s0 = syncs;
	const { machine, from } = await keeper.open();
	memory = machine.memory;
	if (typed) machine.type(typed);
	const started = Date.now();
	const c1 = cpu();
	const stop = keeper.turn(QUANTUM);
	let steps = 0;
	const outcome = await machine.run(
		() => {
			steps++;
			if (real() - w0 > GIVE_UP_MS) return true;
			return process.env.BOUND === 'clock' ? Date.now() - started > QUANTUM : stop();
		},
		(ms) => wait(Math.min(ms, 50))
	);
	const c2 = cpu();
	const written = await keeper.ran(Date.now() - started);
	const c3 = cpu();
	return {
		from,
		outcome,
		cpuMs: Math.round(c3 - c0),
		restoreMs: Math.round(c1 - c0),
		runMs: Math.round(c2 - c1),
		keeperMs: Math.round(c3 - c2),
		wallMs: Math.round(real() - w0),
		unbounded: real() - w0 > GIVE_UP_MS,
		steps,
		stepCap: keeper.stepCap,
		stepMs: Number(keeper.stepMs.toFixed(3)),
		syncs: syncs - s0,
		checkpoint: written && { rows: written.rows, changed: written.changed }
	};
}

await event('\n');
while (!output.includes('# ')) await event();
let worst = 0;
for (let i = 0; i < EVENTS; i++) {
	if (i === REPLACE) {
		// a replaced object: the machine is gone, its memory is pooled, the rows stay
		await keeper.checkpoint();
		keeper = new Keeper(host);
	}
	const r = await event(i ? '' : JOBS[process.env.JOB ?? 'write']);
	worst = Math.max(worst, r.cpuMs);
	console.log(JSON.stringify({ event: i, ...r }));
}
console.log(JSON.stringify({ worstCpuMs: worst }));
process.exit(0);
