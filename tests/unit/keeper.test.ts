import binaryen from 'binaryen';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { sqlite } from '../../experiments/write-back/scripts/sqlite.ts';
import {
	checkpointCost,
	Keeper,
	QUIET_MAX_MS,
	QUIET_MIN_MS,
	STEPS_MAX,
	STEPS_MIN,
	type KeeperHost
} from '../../src/worker/keeper.ts';
import type { Machine } from '../../src/worker/machine/machine.ts';

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
			while (!stop()) if (++steps > 1e6) throw new Error('the turn never stopped');
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
