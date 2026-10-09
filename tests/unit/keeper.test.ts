import binaryen from 'binaryen';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { sqlite } from '../../experiments/write-back/scripts/sqlite.ts';
import { hostRuntime } from '../../scripts/wasm/router-modules.ts';
import { bootstrapOf, CHUNK, packImage, type BootstrapIndex } from '../../src/worker/bootstrap.ts';
import { encodeSnapshot } from '../../src/worker/durable.ts';
import {
	checkpointCost,
	DEFAULT_POLICY,
	Keeper,
	QUIET_MAX_MS,
	QUIET_MIN_MS,
	STEPS_MAX,
	STEPS_MIN,
	type KeeperHost,
	type Policy
} from '../../src/worker/keeper.ts';
import { Machine } from '../../src/worker/machine/machine.ts';
import { MIN_SPAN_MS, type Decision } from '../../src/worker/thermal.ts';

const RUNTIME = hostRuntime();

const PARK_IMPORTS = [
	'wasm_serialize_tasks',
	'wasm_create_and_run_task',
	'wasm_idle_wait',
	'wasm_cpu_relax',
	'wasm_halt',
	'wasm_user_mode_tail'
];

/** tests/fixtures/toy-kernel.wat, asyncified at its park imports as a checkpoint needs */
function toyKernel(asyncify = true): WebAssembly.Module {
	const module = binaryen.parseText(
		readFileSync(new URL('../fixtures/toy-kernel.wat', import.meta.url), 'utf8')
	);
	module.setFeatures(
		binaryen.Features.Atomics |
			binaryen.Features.MutableGlobals |
			binaryen.Features.BulkMemory |
			binaryen.Features.BulkMemoryOpt
	);
	if (asyncify) {
		binaryen.setPassArgument(
			'asyncify-imports',
			PARK_IMPORTS.map((name) => `env.${name}`).join(',')
		);
		module.runPasses(['asyncify']);
	}
	const bytes = module.emitBinary();
	module.dispose();
	return new WebAssembly.Module(bytes);
}

const KERNEL = toyKernel();

/** a keeper over node:sqlite and a toy machine on a clock that moves only when the pump sleeps */
function rig(options: { asyncify?: boolean; sql?: ReturnType<typeof sqlite> } = {}) {
	const clock = { ns: 0n, wall: 1_000_000 };
	const sql = options.sql ?? sqlite();
	const alarms: number[] = [];
	let output = '';
	const host: KeeperHost = {
		sql,
		alarms: {
			getAlarm: () => alarms.at(-1) ?? null,
			setAlarm: (at) => void alarms.push(at)
		},
		sync: async () => {},
		now: () => clock.wall,
		options: () => ({
			vmlinux: options.asyncify === false ? toyKernel(false) : KERNEL,
			initrd: new Uint8Array(16),
			cmdline: 'toy',
			registry: new Map(),
			maximumPages: 64,
			sharedKernel: true,
			asyncify: options.asyncify !== false,
			runtime: RUNTIME,
			sha256: (bytes) => String.fromCharCode(bytes[0] ?? 0),
			now: () => clock.ns,
			write: (text) => (output += text)
		})
	};
	const run = (machine: Machine, until: () => boolean) =>
		machine.run(until, async (ms) => void (clock.ns += BigInt(Math.max(ms, 1)) * 1_000_000n));
	return { clock, sql, alarms, host, run, output: () => output };
}

describe('Keeper', () => {
	it('boots with nothing stored, checkpoints when due, and continues the machine from the store', async () => {
		const r = rig();
		const keeper = new Keeper(r.host, { minMs: 1 });
		const opened = await keeper.open();
		expect(opened.from).toBe('booted');
		await r.run(opened.machine, () => r.output().includes('parent ok'));
		const written = await keeper.ran(10);
		expect(written!.rows).toBeGreaterThan(2);
		expect(keeper.counts).toMatchObject({ checkpoints: 1, restores: 0, refused: 0 });
		// the machine now runs from the store: the next open is the restored one
		expect(keeper.machine).not.toBe(opened.machine);
		expect((await keeper.open()).from).toBe('running');
		keeper.machine!.type('s');
		await r.run(keeper.machine!, () => r.output().includes('parent back ok'));
		expect(r.output()).toContain('parent back ok');
	});

	it('restores the last checkpoint into a new keeper over the same rows, and learns the loss', async () => {
		const r = rig();
		const first = new Keeper(r.host, { minMs: 1 });
		await r.run((await first.open()).machine, () => r.output().includes('parent ok'));
		await first.ran(10);
		const second = new Keeper(r.host, { minMs: 1 });
		const { machine, from } = await second.open();
		expect(from).toBe('restored');
		expect(second.counts.restores).toBe(1);
		machine.type('s');
		await r.run(machine, () => r.output().includes('parent back ok'));
		expect(r.output()).toContain('parent back ok');
		const learned = r.sql.exec("SELECT v FROM gmux_meta WHERE k = 'cadence'").toArray()[0]!.v;
		expect(JSON.parse(String(learned)).losses).toBe(1);
	});

	it("starts a machine from the host's bootstrap image with nothing stored, and prefers its own checkpoint after", async () => {
		const built = rig();
		const booted = new Machine(built.host.options());
		await built.run(booted, () => built.output().includes('parent ok'));
		const snapshot = await booted.checkpoint();
		const { blocks, chunks } = packImage(snapshot.memory);
		const index: BootstrapIndex = {
			version: 1,
			image: 'toy',
			cmdline: 'toy',
			maximumPages: 64,
			byteLength: snapshot.memory.byteLength,
			chunkBytes: CHUNK,
			blocks,
			snapshot: encodeSnapshot(snapshot)
		};
		const r = rig();
		let asked = 0;
		r.host.bootstrap = async () => (asked++, bootstrapOf(index, async (n) => chunks[n]!));
		const keeper = new Keeper(r.host, { minMs: 1 });
		const { machine, from } = await keeper.open();
		expect(from).toBe('bootstrapped');
		expect(keeper.counts.bootstraps).toBe(1);
		expect(machine.stats.restoreHooks).toBe(1);
		machine.type('s');
		await r.run(machine, () => r.output().includes('parent back ok'));
		expect(r.output()).toContain('echo:schild ok\nparent back ok\n');
		// a bootstrapped machine is unsaved work: its own checkpoint comes due and wins from then on
		await keeper.ran(10);
		expect(keeper.counts.checkpoints).toBe(1);
		const next = new Keeper(r.host, { minMs: 1 });
		expect((await next.open()).from).toBe('restored');
		expect(asked).toBe(1);
	});

	it('takes one checkpoint at a time, and none for an alarm while the machine runs', async () => {
		const r = rig();
		const keeper = new Keeper(r.host, { minMs: 1 });
		const { machine } = await keeper.open();
		await r.run(machine, () => r.output().includes('parent ok'));
		const first = keeper.checkpoint();
		expect(await keeper.checkpoint()).toBeNull();
		expect((await first)!.rows).toBeGreaterThan(2);
		keeper.activity();
		await keeper.arm(true);
		r.clock.wall += 5000;
		await keeper.woke(true);
		expect(keeper.counts).toMatchObject({ checkpoints: 1, refused: 0 });
	});

	it('counts a refused checkpoint and leaves the machine running', async () => {
		const r = rig({ asyncify: false });
		const keeper = new Keeper(r.host, { minMs: 1 });
		const { machine } = await keeper.open();
		await r.run(machine, () => r.output().includes('parent ok'));
		expect(await keeper.ran(10)).toBeNull();
		expect(keeper.counts.refused).toBe(1);
		expect(keeper.last.refused).toMatch(/needs asyncify/);
		expect(keeper.machine).toBe(machine);
	});

	it('wakes an unattended machine at its next Linux deadline, no sooner than a quiet period that doubles', async () => {
		const r = rig();
		const keeper = new Keeper(r.host);
		const { machine } = await keeper.open();
		await r.run(machine, () => r.output().includes('parent ok'));
		keeper.activity();
		await keeper.arm();
		// init's 1 ms deadline, held off to the quiet period
		expect(keeper.alarm.next).toBe(r.clock.wall + QUIET_MIN_MS);
		expect(r.alarms).toEqual([r.clock.wall + QUIET_MIN_MS]);
		await keeper.arm();
		expect(keeper.quietMs).toBe(2 * QUIET_MIN_MS);
		for (let i = 0; i < 30; i++) await keeper.arm();
		expect(keeper.quietMs).toBe(QUIET_MAX_MS);
		keeper.activity();
		await keeper.arm();
		expect(keeper.quietMs).toBe(QUIET_MIN_MS);
		// a warm socket drives the machine; only unsaved work wants the alarm
		await keeper.arm(true);
		expect(keeper.alarm.next).toBe(r.clock.wall + 5000);
	});

	it('ends an unattended turn at its first wait for a timer, where an attended one waits out its budget', async () => {
		const r = rig();
		const keeper = new Keeper(r.host);
		await r.run((await keeper.open()).machine, () => r.output().includes('parent ok'));
		const waited: number[] = [];
		const sleep = keeper.sleeper(async (ms) => void waited.push(ms));
		let stop = keeper.turn(5000, true);
		expect(stop()).toBe(false);
		// a yield (0 ms) is not a wait for a timer
		await sleep(0);
		expect(stop()).toBe(false);
		await sleep(400);
		expect(stop()).toBe(true);
		expect(waited).toEqual([0, 400]);
		// it ended idle, not by its budget, so the machine counts as quiet and the alarm backs off
		await keeper.ran(1);
		expect(keeper.quietMs).toBe(2 * QUIET_MIN_MS);
		stop = keeper.turn(5000);
		await sleep(400);
		expect(stop()).toBe(false);
	});

	describe('thermal rule', () => {
		/** the rule alone, without the floor that keeps a wake it drops */
		const RULE: Partial<Policy> = { wake: 'rule' };

		/** an idle machine, checkpointed so only its timer wants the alarm */
		async function idle(r: ReturnType<typeof rig>, keeper: Keeper) {
			const { machine } = await keeper.open();
			await r.run(machine, () => r.output().includes('parent ok'));
			await keeper.checkpoint();
		}

		it('keeps waking an idle machine while it has watched too little to read a rate', async () => {
			const r = rig();
			const decisions: Decision[] = [];
			const keeper = new Keeper({ ...r.host, decided: (d) => decisions.push(d) });
			await idle(r, keeper);
			r.clock.wall += MIN_SPAN_MS - 1;
			await keeper.arm();
			expect(decisions).toHaveLength(1);
			expect(decisions[0]).toMatchObject({ level: 'machine', kept: true, reuse: null });
			expect(keeper.alarm.next).toBe(r.clock.wall + 2 * QUIET_MIN_MS);
			expect(keeper.thermal).toMatchObject({ kept: 1, dropped: 0, last: decisions[0] });
		});

		it('drops the timer wake of an idle machine nobody returns to, and says why', async () => {
			const r = rig();
			const decisions: Decision[] = [];
			const keeper = new Keeper({ ...r.host, decided: (d) => decisions.push(d) }, {}, RULE);
			await idle(r, keeper);
			r.clock.wall += MIN_SPAN_MS;
			await keeper.arm();
			expect(keeper.alarm.next).toBeNull();
			expect(decisions[0]).toMatchObject({ kept: false, reuse: 0, why: expect.any(String) });
			expect(decisions[0]!.gain).toBeLessThan(0);
			expect(keeper.thermal).toMatchObject({ kept: 0, dropped: 1, last: decisions[0] });
			expect(keeper.history!.dropped).toBe(r.clock.wall);
			// stored, so a new instance of the object knows the machine was dropped
			expect(new Keeper(r.host).history).toEqual(keeper.history);
		});

		it('leaves unsaved work its checkpoint alarm when it drops the timer', async () => {
			const r = rig();
			const keeper = new Keeper(r.host);
			await idle(r, keeper);
			keeper.activity();
			await keeper.arm();
			r.clock.wall += MIN_SPAN_MS;
			await keeper.arm();
			expect(keeper.thermal.dropped).toBe(1);
			expect(keeper.alarm.next).toBeGreaterThan(r.clock.wall);
		});

		it('takes no decision for a machine that just did something, or one a warm socket drives', async () => {
			const r = rig();
			const decisions: Decision[] = [];
			const keeper = new Keeper({ ...r.host, decided: (d) => decisions.push(d) });
			await idle(r, keeper);
			r.clock.wall += MIN_SPAN_MS;
			keeper.activity();
			await keeper.arm();
			expect(keeper.alarm.next).toBe(r.clock.wall + QUIET_MIN_MS);
			await keeper.arm(true);
			expect(decisions).toHaveLength(0);
		});

		it('counts an arrival, stores it, and lets it undo a drop', async () => {
			const r = rig();
			const keeper = new Keeper(r.host, {}, RULE);
			await idle(r, keeper);
			r.clock.wall += MIN_SPAN_MS;
			await keeper.arm();
			expect(keeper.history!.dropped).toBeDefined();
			keeper.arrived();
			expect(keeper.history).toMatchObject({ events: 1, last: r.clock.wall });
			expect(keeper.history!.dropped).toBeUndefined();
			expect(new Keeper(r.host).history).toEqual(keeper.history);
		});
	});

	describe('policy', () => {
		/** an idle machine past the thermal rule's first ten minutes, so the rule drops its timer wake */
		async function dropped(policy: Partial<Policy>, host: Partial<KeeperHost> = {}) {
			const r = rig();
			const keeper = new Keeper({ ...r.host, ...host }, {}, policy);
			const { machine } = await keeper.open();
			await r.run(machine, () => r.output().includes('parent ok'));
			await keeper.checkpoint();
			r.clock.wall += MIN_SPAN_MS;
			await keeper.arm();
			return { r, keeper };
		}

		it('defaults to what the site runs', () => {
			expect(new Keeper(rig().host).policy).toEqual(DEFAULT_POLICY);
			expect(DEFAULT_POLICY).toMatchObject({
				turnEnd: 'over',
				wake: 'floor',
				floorMs: 900_000,
				saveWake: true,
				rearmBusy: true,
				persistQuiet: true
			});
		});

		describe('turn end', () => {
			/** the first wait of `ms`, `after` ms into a 5 s turn, and whether the turn ended */
			async function ended(
				turnEnd: Policy['turnEnd'],
				ms: number,
				after = 0,
				overMs?: number
			) {
				const r = rig();
				const keeper = new Keeper(
					r.host,
					{},
					{ turnEnd, overMs: overMs ?? DEFAULT_POLICY.overMs }
				);
				await r.run((await keeper.open()).machine, () => r.output().includes('parent ok'));
				const stop = keeper.turn(5000, true);
				r.clock.wall += after;
				await keeper.sleeper(async () => {})(ms);
				return stop();
			}

			it('first ends at any wait for a timer, budget at none', async () => {
				expect(await ended('first', 1)).toBe(true);
				expect(await ended('budget', 4000)).toBe(false);
			});

			it('remaining ends only when the wait outlasts what is left of the budget', async () => {
				expect(await ended('remaining', 400)).toBe(false);
				expect(await ended('remaining', 5001)).toBe(true);
				expect(await ended('remaining', 400, 4700)).toBe(true);
				expect(await ended('remaining', 200, 4700)).toBe(false);
			});

			it('over ends only when the wait is longer than the threshold', async () => {
				expect(await ended('over', 100)).toBe(false);
				expect(await ended('over', 101)).toBe(true);
				expect(await ended('over', 5, 0, 1)).toBe(true);
			});

			it('ends an unattended turn once its short waits add up to the budget, with the clock stopped', async () => {
				const r = rig();
				const keeper = new Keeper(r.host, {}, { turnEnd: 'over' });
				await r.run((await keeper.open()).machine, () => r.output().includes('parent ok'));
				const sleep = keeper.sleeper(async () => {});
				const stop = keeper.turn(5000, true);
				for (let i = 0; i < 500; i++) await sleep(10);
				expect(stop()).toBe(false);
				await sleep(10);
				expect(stop()).toBe(true);
				// an attended turn's waits are the wall clock's to count
				const attended = keeper.turn(5000);
				for (let i = 0; i < 600; i++) await sleep(10);
				expect(attended()).toBe(false);
			});

			it('ends an unattended turn on the time its timers skipped, with the host clock standing still', async () => {
				const r = rig();
				const frozen: KeeperHost = {
					...r.host,
					options: () => ({ ...r.host.options(), now: () => 0n })
				};
				const keeper = new Keeper(frozen, {}, { turnEnd: 'over' });
				const { machine } = await keeper.open();
				const quiet = keeper.sleeper(async () => {});
				await machine.run(() => r.output().includes('parent ok'), quiet, 20_000);
				// the toy idles on 1 ms timers: 40 of them are a 40 ms budget, far under the step floor
				const stop = keeper.turn(40, true);
				let waits = 0;
				const sleep = keeper.sleeper(async () => void waits++);
				expect(await machine.run(stop, sleep, 20_000)).toBe('until');
				expect(waits).toBeLessThan(60);
			});

			it('never ends an attended turn, or at a yield', async () => {
				const r = rig();
				const keeper = new Keeper(r.host, {}, { turnEnd: 'over', overMs: 0 });
				await r.run((await keeper.open()).machine, () => r.output().includes('parent ok'));
				const stop = keeper.turn(5000);
				await keeper.sleeper(async () => {})(400);
				expect(stop()).toBe(false);
				const unattended = keeper.turn(5000, true);
				await keeper.sleeper(async () => {})(0);
				expect(unattended()).toBe(false);
			});
		});

		describe('wake', () => {
			it('rule leaves the drop alone', async () => {
				const { keeper } = await dropped({ wake: 'rule' });
				expect(keeper.alarm.next).toBeNull();
			});

			it('always keeps the timer wake the rule dropped, at its quiet time', async () => {
				const { r, keeper } = await dropped({ wake: 'always' });
				expect(keeper.thermal.dropped).toBe(1);
				expect(keeper.alarm.next).toBe(r.clock.wall + keeper.quietMs);
				expect(keeper.history!.dropped).toBeUndefined();
			});

			it('floor holds it off to one wake per floorMs', async () => {
				const { r, keeper } = await dropped({ wake: 'floor', floorMs: 900_000 });
				expect(keeper.alarm.next).toBe(r.clock.wall + 900_000);
				// a quiet time already past the floor stays
				const late = await dropped({ wake: 'floor', floorMs: 1000 });
				expect(late.keeper.alarm.next).toBe(late.r.clock.wall + late.keeper.quietMs);
			});

			it('ontime keeps it only while the host reports a user timer, and no sooner than the floor', async () => {
				const pending = (ms: number | null) => ({ userTimerMs: async () => ms });
				const none = await dropped({ wake: 'ontime', floorMs: 60_000 }, pending(null));
				expect(none.keeper.alarm.next).toBeNull();
				expect(none.keeper.history!.dropped).toBeDefined();
				const soon = await dropped({ wake: 'ontime', floorMs: 60_000 }, pending(5000));
				expect(soon.keeper.alarm.next).toBe(soon.r.clock.wall + 60_000);
				const far = await dropped({ wake: 'ontime', floorMs: 60_000 }, pending(3_000_000));
				expect(far.keeper.alarm.next).toBe(far.r.clock.wall + 3_000_000);
				const unasked = await dropped({ wake: 'ontime' });
				expect(unasked.keeper.alarm.next).toBeNull();
			});
		});

		describe('rearm a busy machine', () => {
			/** a machine stopped mid-run: a task ready, no idle cpu, so no Linux deadline */
			async function busy(policy: Partial<Policy>) {
				const r = rig();
				const keeper = new Keeper(r.host, {}, policy);
				const { machine } = await keeper.open();
				let steps = 0;
				await r.run(machine, () => ++steps > 2);
				expect(machine.deadline).toBeNull();
				return { r, keeper, machine };
			}

			it('wakes it after the quiet period, where without it only unsaved work does', async () => {
				const off = await busy({ rearmBusy: false });
				expect(off.machine.runnable).toBe(true);
				await off.keeper.arm();
				expect(off.keeper.alarm.next).toBe(off.r.clock.wall + 5000);
				const on = await busy({});
				await on.keeper.arm();
				expect(on.keeper.alarm.next).toBe(on.r.clock.wall + 2 * QUIET_MIN_MS);
			});

			it('leaves a machine with nothing to run alone', async () => {
				const r = rig();
				const keeper = new Keeper(r.host);
				const { machine } = await keeper.open();
				expect(machine.runnable).toBe(false);
				await keeper.arm();
				expect(keeper.alarm.next).toBe(r.clock.wall + 5000);
			});
		});

		describe('save each wake', () => {
			async function turnEnded(policy: Partial<Policy>, attended: boolean) {
				const r = rig();
				const keeper = new Keeper(r.host, {}, policy);
				await r.run((await keeper.open()).machine, () => r.output().includes('parent ok'));
				keeper.turn(5000, !attended);
				await keeper.ran(1, attended);
				return keeper.counts.checkpoints;
			}

			it('checkpoints at the end of an alarm turn, and never at the end of an attended one', async () => {
				expect(await turnEnded({ saveWake: false }, false)).toBe(0);
				expect(await turnEnded({}, false)).toBe(1);
				expect(await turnEnded({}, true)).toBe(0);
			});
		});

		describe('quiet period', () => {
			const quiet = (r: ReturnType<typeof rig>) =>
				r.sql.exec("SELECT v FROM gmux_meta WHERE k = 'quiet'").toArray()[0]?.v;

			it('is lost with the instance when the policy does not keep it', async () => {
				const r = rig();
				const keeper = new Keeper(r.host, {}, { persistQuiet: false });
				await r.run((await keeper.open()).machine, () => r.output().includes('parent ok'));
				for (let i = 0; i < 3; i++) await keeper.arm();
				expect(keeper.quietMs).toBe(8 * QUIET_MIN_MS);
				expect(quiet(r)).toBeUndefined();
				expect(new Keeper(r.host, {}, { persistQuiet: false }).quietMs).toBe(QUIET_MIN_MS);
			});

			it('is kept in gmux_meta by default, one row per change', async () => {
				const r = rig();
				const keeper = new Keeper(r.host);
				await r.run((await keeper.open()).machine, () => r.output().includes('parent ok'));
				for (let i = 0; i < 3; i++) await keeper.arm();
				expect(quiet(r)).toBe(String(8 * QUIET_MIN_MS));
				expect(new Keeper(r.host).quietMs).toBe(8 * QUIET_MIN_MS);
				// a policy that does not keep it ignores the row
				expect(new Keeper(r.host, {}, { persistQuiet: false }).quietMs).toBe(QUIET_MIN_MS);
				for (let i = 0; i < 30; i++) await keeper.arm();
				const before = r.sql.written;
				await keeper.arm();
				expect(keeper.quietMs).toBe(QUIET_MAX_MS);
				expect(r.sql.written - before).toBe(0);
				keeper.activity();
				await keeper.arm();
				expect(quiet(r)).toBe(String(QUIET_MIN_MS));
			});
		});
	});

	it('checkpoints unsaved work when its alarm comes due, and runs the machine for a timer', async () => {
		const r = rig();
		const keeper = new Keeper(r.host);
		const { machine } = await keeper.open();
		await r.run(machine, () => r.output().includes('parent ok'));
		await keeper.arm(true);
		r.clock.wall += 5000;
		expect(await keeper.woke()).toBe(false);
		expect(keeper.counts.checkpoints).toBe(1);
		await keeper.arm();
		r.clock.wall += QUIET_MAX_MS;
		expect(await keeper.woke()).toBe(true);
	});

	it('runs the machine for an alarm that a new object cannot account for only with a machine stored', async () => {
		const r = rig();
		expect(await new Keeper(r.host).woke()).toBe(false);
		const keeper = new Keeper(r.host, { minMs: 1 });
		await r.run((await keeper.open()).machine, () => r.output().includes('parent ok'));
		await keeper.ran(10);
		expect(await new Keeper(r.host).woke()).toBe(true);
		await keeper.halted();
		expect(keeper.store.checkpointed).toBe(false);
		expect(await new Keeper(r.host).woke()).toBe(false);
		expect((await keeper.open()).from).toBe('booted');
	});

	it('drops a crashed machine and restores the last checkpoint next', async () => {
		const r = rig();
		const keeper = new Keeper(r.host, { minMs: 1 });
		await r.run((await keeper.open()).machine, () => r.output().includes('parent ok'));
		await keeper.ran(10);
		keeper.crashed();
		expect(keeper.machine).toBeNull();
		expect((await keeper.open()).from).toBe('restored');
	});

	describe('turn budget', () => {
		/** runs `stop` until it says stop, `stepMs` of real time a step, on a clock that never moves */
		const drive = (r: ReturnType<typeof rig>, stop: () => boolean, stepMs: number) => {
			let steps = 0;
			while (!stop()) if (++steps > 2e6) throw new Error('the turn never stopped');
			// the look that said stop came after a step too
			r.clock.wall += (steps + 1) * stepMs;
			return steps;
		};

		it('stops a turn by steps when the clock never moves, and learns what a step costs', () => {
			const r = rig();
			const keeper = new Keeper(r.host);
			// 1 ms a step until measured: 5,000 steps for a 5 s budget
			expect(drive(r, keeper.turn(5000), 0.25)).toBe(5000);
			// learned 0.25 ms; the cap grows at most twofold a turn, then fits the budget
			expect(drive(r, keeper.turn(5000), 0.25)).toBe(10_000);
			expect(drive(r, keeper.turn(5000), 0.25)).toBe(STEPS_MAX);
			expect(drive(r, keeper.turn(5000), 0.25) * 0.25).toBeLessThanOrEqual(5000);
			expect(keeper.stepMs).toBeCloseTo(0.25);
		});

		it('learns nothing from turns the clock never saw, so the cap does not run away', () => {
			const r = rig();
			const keeper = new Keeper(r.host);
			expect(drive(r, keeper.turn(5000), 1)).toBe(5000);
			// the next events start on a clock that stood still: each turn looks free
			for (let i = 0; i < 4; i++) drive(r, keeper.turn(5000), 0);
			expect(keeper.stepMs).toBe(1);
			expect(keeper.stepCap).toBe(5000);
		});

		it('keeps every turn within its budget of real time when a step gets dearer', () => {
			const r = rig();
			const keeper = new Keeper(r.host);
			const costs = [0.25, 0.25, 0.25, 0.25, 2, 2, 2, 0.5, 20, 20];
			const took = costs.map((ms) => drive(r, keeper.turn(5000), ms) * ms);
			// 75% of the 30 s event limit
			const limit = 22_500;
			// the turn a step got dearer runs its cap at the new cost: the ceiling (8x here)
			expect(took[4]).toBe(STEPS_MAX * 2);
			expect(took[4]).toBeGreaterThan(limit);
			// the turn after fits the budget again, and a cheaper step is no risk
			expect(took.slice(5, 8).every((ms) => ms <= 5000)).toBe(true);
			// a 40x jump from 0.5 ms: its own turn over, the next at the floor of STEPS_MIN
			expect(took[8]).toBeGreaterThan(limit);
			expect(took[9]).toBe(STEPS_MIN * 20);
			expect(took[9]).toBeLessThanOrEqual(limit);
		});

		it('gives the turn after a restore half the steps', async () => {
			const r = rig();
			const first = new Keeper(r.host, { minMs: 1 });
			await r.run((await first.open()).machine, () => r.output().includes('parent ok'));
			await first.ran(10);
			const keeper = new Keeper(r.host);
			expect((await keeper.open()).from).toBe('restored');
			expect(drive(r, keeper.turn(5000), 1)).toBe(2500);
			expect(drive(r, keeper.turn(5000), 1)).toBe(5000);
		});

		it('stops at the wall budget when the clock moves, learns nothing from it, and counts it busy', async () => {
			const r = rig();
			const keeper = new Keeper(r.host);
			const stop = keeper.turn(100);
			expect(stop()).toBe(false);
			// an idle machine: few steps, the budget spent asleep
			r.clock.wall += 101;
			expect(stop()).toBe(true);
			await r.run((await keeper.open()).machine, () => r.output().includes('parent ok'));
			for (let i = 0; i < 3; i++) await keeper.arm();
			expect(keeper.quietMs).toBe(8 * QUIET_MIN_MS);
			await keeper.ran(0);
			expect(keeper.quietMs).toBe(QUIET_MIN_MS);
			keeper.turn(100);
			expect(keeper.stepMs).toBe(1);
		});
	});

	it("models a checkpoint's cost from the bytes hashed and the pages written", () => {
		expect(checkpointCost(1 << 20, 10)).toBe(50 + 2 + 2);
	});
});
