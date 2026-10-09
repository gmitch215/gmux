import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Keeper, QUANTUM_MS, type KeeperHost, type Policy } from '../../../src/worker/keeper.ts';
import type { Machine } from '../../../src/worker/machine/machine.ts';
import { siteOptions } from '../../../src/worker/site-machine.ts';
import { hostRuntime } from '../../../scripts/wasm/router-modules.ts';
import { FREE_DAY, OBJECT_GB } from '../../../src/worker/thermal.ts';
import { JOBS, READ, readback, start, type Job } from './jobs.ts';
import { sqlite } from '../../write-back/scripts/sqlite.ts';

/**
 * One idle machine, its keeper, and its alarms on a virtual clock: the real kernel and the site's
 * pump, run event by event, with the time between events skipped and waits for a Linux timer
 * counted as time passed. An object is replaced (a new keeper over the same rows, as a Durable
 * Object that lost its instance) when EVICT_MS passed since it last ran.
 *
 *   POLICY   JSON of a keeper Policy (default: the tree)
 *   JOB      none | silent (sleep 60 loop, no output) | gzip (gzip -c, sleep 0.01) | cpu (shell arithmetic)
 *   HOURS    virtual hours to run after the job starts (default 1)
 *   MAX_EVENTS  stop after this many alarm events
 *   ACTIVITY_MS  a user attaches, types one command and leaves this often (0 for never)
 *   EVICT_MS  default 15000
 *   OUT      file for one JSON line per event
 * `node --no-warnings --experimental-strip-types experiments/decisions/scripts/sim.ts`
 */
const env = process.env;
const policy = JSON.parse(env.POLICY ?? '{}') as Partial<Policy>;
const job = (env.JOB ?? 'none') as Job;
const HOURS = Number(env.HOURS ?? 1);
const MAX_EVENTS = Number(env.MAX_EVENTS ?? Infinity);
const ACTIVITY_MS = Number(env.ACTIVITY_MS ?? 0);
const EVICT_MS = Number(env.EVICT_MS ?? 15_000);
const N = env.N ? Number(env.N) : undefined;

const root = new URL('../../../', import.meta.url).pathname;
const kernel = (name: string) => new Uint8Array(readFileSync(join(root, 'build/kernel', name)));
const build = {
	vmlinux: new WebAssembly.Module(kernel('vmlinux.async.wasm')),
	busybox: new WebAssembly.Module(kernel('busybox.async.wasm')),
	busyboxGuard: new WebAssembly.Module(kernel('busybox.guard.wasm')),
	katybug: new WebAssembly.Module(kernel('katybug.wasm')),
	runtime: hostRuntime(),
	initrd: kernel('initramfs.bin'),
	manifest: JSON.parse(readFileSync(join(root, 'build/kernel/manifest.json'), 'utf8'))
};

// virtual wall clock: the real one plus every skipped stretch
let skew = 0;
const vnow = () => Date.now() + skew;
const sql = sqlite();
let alarm: number | null = null;
let alarmSets = 0;
let memory: WebAssembly.Memory | undefined;
let output = '';
let typed = '';
let keeper: Keeper;
let lastRan = -Infinity;

const host: KeeperHost = {
	sql,
	alarms: { getAlarm: () => alarm, setAlarm: (at) => void ((alarm = at), alarmSets++) },
	sync: async () => {},
	now: vnow,
	decided: () => {},
	options: () =>
		siteOptions(build, {
			memory,
			sha256: (bytes) => createHash('sha256').update(bytes).digest('hex'),
			write: (text) => {
				if (!probing) keeper.activity();
				output += text;
			}
		})
};
const machineOptions = host.options;
host.options = () => ({ ...machineOptions(), now: () => BigInt(Math.round(vnow() * 1000)) * 1000n });
// what a guest command writes to a file is not activity; the probe that reads the guest is
let probing = false;
const probe = { count: 0, wallMs: 0 };
host.userTimerMs = async () => {
	const machine = keeper.machine;
	if (!machine) return null;
	probing = true;
	output = '';
	const started = vnow();
	machine.type(
		"echo TL:x$(grep 'expires at' /proc/timer_list | sed 's/.*\\[in \\([-0-9]*\\) to.*/\\1/' | tr '\\n' ,)\n"
	);
	let steps = 0;
	await machine.run(
		() => /TL:x[-0-9,]*\r?\n/.test(output) || ++steps > 4000,
		async (ms) => void (skew += Math.min(ms, 50))
	);
	probing = false;
	if (env.DEBUG) console.error('probe', steps, JSON.stringify(output.slice(-300)));
	probe.count++;
	probe.wallMs += vnow() - started;
	const listed = /TL:x([-0-9,]*)\r?\n/.exec(output)?.[1] ?? '';
	// the kernel's own timers fall inside a few seconds either side of now; a user's sleep is further off
	const far = listed
		.split(',')
		.filter(Boolean)
		.map((ns) => Number(ns) / 1e6)
		.filter((ms) => Math.abs(ms) > 10_000);
	return far.length ? Math.max(0, Math.min(...far)) : null;
};

const fresh = () => (keeper = new Keeper(host, {}, policy));

/** the site's pump (src/site-do.ts), waits taken from the virtual clock */
async function pump(budgetMs: number, unattended: boolean) {
	const before = { wall: vnow(), rows: sql.written, sets: alarmSets };
	const { machine, from } = await keeper.open();
	memory = machine.memory;
	const stop = keeper.turn(budgetMs, unattended);
	let waits = 0;
	const outcome = await machine.run(
		() => {
			if (typed) {
				machine.type(typed);
				typed = '';
			}
			return stop();
		},
		keeper.sleeper(async (ms) => {
			if (ms > 0) waits++;
			skew += Math.min(ms, 50);
		})
	);
	if (outcome === 'halted') await keeper.halted();
	else if (outcome === 'crashed') keeper.crashed();
	else await keeper.ran(vnow() - before.wall, false);
	lastRan = vnow();
	return {
		from,
		outcome,
		wallMs: vnow() - before.wall,
		steps: keeper.turnSteps,
		waits,
		rows: sql.written - before.rows + (alarmSets - before.sets)
	};
}

const events: object[] = [];
const log = (event: object) => events.push(event);
const seconds = (ms: number) => Math.round(ms / 100) / 10;

// #region start
fresh();
keeper.arrived();
{
	const { machine } = await keeper.open();
	memory = machine.memory;
	const until = (text: string) => async () => {
		for (let i = 0; i < 400 && !output.includes(text); i++) await pump(QUANTUM_MS, false);
		if (!output.includes(text)) throw new Error(`no ${text} in ${output.slice(-300)}`);
	};
	await until('# ')();
	if (!JOBS.includes(job)) throw new Error(`JOB ${job}`);
	const guest = start(job, N);
	if (guest) {
		output = '';
		typed = `${guest}\n`;
		keeper.activity();
		await pump(1000, false);
		await pump(1000, false);
	}
	// the site would checkpoint this on its alarm; an object replaced first needs one to restore
	await keeper.checkpoint();
	await keeper.arm(false);
}
const startedAt = vnow();
const startWritten = { rows: sql.written, sets: alarmSets };
// #endregion

// #region run
let nextActivity = ACTIVITY_MS > 0 ? startedAt + ACTIVITY_MS : Infinity;
const end = startedAt + HOURS * 3_600_000;
let alarmEvents = 0;
let activities = 0;
while (vnow() < end && alarmEvents < MAX_EVENTS) {
	const due = Math.min(alarm ?? Infinity, nextActivity);
	if (due === Infinity || due >= end) {
		skew += Math.max(0, end - vnow());
		break;
	}
	skew += Math.max(0, due - vnow());
	if (vnow() - lastRan > EVICT_MS) fresh();
	if (due === nextActivity && nextActivity <= (alarm ?? Infinity)) {
		nextActivity += ACTIVITY_MS;
		activities++;
		keeper.arrived();
		typed = 'echo hi\n';
		keeper.activity();
		const r = await pump(250, false);
		log({ at: seconds(vnow() - startedAt), kind: 'activity', ...r, quietMs: keeper.quietMs });
		continue;
	}
	alarm = null;
	alarmEvents++;
	const at = vnow();
	const ran = await keeper.woke(false);
	let r;
	if (ran) r = await pump(QUANTUM_MS, true);
	if (ran && env.FORCE_CHECKPOINT) await keeper.checkpoint();
	else await keeper.arm(false);
	log({
		at: seconds(at - startedAt),
		kind: 'alarm',
		ran,
		...(r ?? { wallMs: vnow() - at, rows: 0 }),
		quietMs: keeper.quietMs,
		next: alarm === null ? null : seconds(alarm - vnow()),
		dropped: keeper.thermal.dropped
	});
}
// #endregion

// what the guest did, read the way a user would: attach and look
let read = '';
if (job !== 'none') {
	if (vnow() - lastRan > EVICT_MS) fresh();
	output = '';
	keeper.arrived();
	typed = READ;
	keeper.activity();
	for (let i = 0; i < 200 && !/R:[^$\r\n]*:[^$\r\n]*:\d+/.test(output); i++) await pump(1000, false);
	read = readback(output)?.join(' / ') ?? `unread: ${output.slice(-200)}`;
}

interface Event {
	at: number;
	kind: string;
	ran: boolean;
	wallMs: number;
	rows: number;
	steps?: number;
	waits?: number;
	from?: string;
}
const alarms = (events as Event[]).filter((e) => e.kind === 'alarm');
const ranEvents = alarms.filter((e) => e.ran);
const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
const hours = HOURS;
const wallMean = mean(alarms.map((e) => e.wallMs));
const rowsMean = mean(alarms.map((e) => e.rows));
const virtualHours = (vnow() - startedAt) / 3_600_000;
const perDay = virtualHours > 0 ? (alarms.length / virtualHours) * 24 : 0;
// the thermal rule reads no rate before ten minutes of watching; what comes after is the steady state
const STEADY_S = 660;
const steady = alarms.filter((e) => e.at >= STEADY_S);
const steadyHours = Math.max(virtualHours - STEADY_S / 3600, 0);
const steadyPerDay = steadyHours > 0 ? (steady.length / steadyHours) * 24 : 0;
const steadyWall = mean(steady.map((e) => e.wallMs));
const steadyRows = steady.reduce((a, e) => a + e.rows, 0);
const summary = {
	policy: { ...keeper.policy },
	job,
	hours,
	virtualHours: Math.round(virtualHours * 1000) / 1000,
	alarmEvents: alarms.length,
	ranEvents: ranEvents.length,
	activities,
	restoredEvents: ranEvents.filter((e) => e.from === 'restored').length,
	wallMsMean: wallMean === null ? null : Math.round(wallMean * 10) / 10,
	rowsMean: rowsMean === null ? null : Math.round(rowsMean * 100) / 100,
	rowsTotal: sql.written - startWritten.rows + (alarmSets - startWritten.sets),
	wakesPerDay: Math.round(perDay),
	steady: {
		events: steady.length,
		wakesPerDay: Math.round(steadyPerDay),
		wallMsMean: steadyWall === null ? null : Math.round(steadyWall * 10) / 10,
		rowsPerDay: steadyHours > 0 ? Math.round((steadyRows / steadyHours) * 24) : 0,
		gbSecondsPerDay:
			steadyWall === null ? 0 : Math.round((steadyPerDay * steadyWall * OBJECT_GB) / 100) / 10
	},
	quietMs: keeper.quietMs,
	probes: probe,
	guest: read,
	day: {
		// per Free day at this hour's rate: requests = one per wake, the meters of src/worker/thermal.ts
		requestsShare: alarms.length ? (perDay * 1) / FREE_DAY.requests : 0,
		gbSeconds: wallMean === null ? 0 : (perDay * wallMean * OBJECT_GB) / 1000
	}
};
if (env.OUT) writeFileSync(env.OUT, events.map((e) => JSON.stringify(e)).join('\n') + '\n');
console.log(JSON.stringify(summary));
process.exit(0);
