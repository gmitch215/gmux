import { decodeSnapshot, DurableStore, encodeSnapshot, type Sql, type Written } from './durable.ts';
import { Machine, type MachineOptions, type Snapshot } from './machine/machine.ts';
import { Alarm, Cadence, type AlarmStorage, type IntervalOptions } from './schedule.ts';
import { arrive, begin, machineWake, type Decision, type History } from './thermal.ts';

/** what an event's pump may spend of wall time when an alarm or a tick runs the machine, ms */
export const QUANTUM_MS = 5000;

/** what the keeper needs from its Durable Object */
export interface KeeperHost {
	/** told every keep-or-drop decision the thermal rule makes, with its inputs */
	decided?(decision: Decision): void;
	sql: Sql;
	alarms: AlarmStorage;
	/** resolves once every write so far is durable (`ctx.storage.sync`) */
	sync(): Promise<void>;
	/** a machine's options, before the keeper adds its file syncs and restores */
	options(): MachineOptions;
	/** wall time, ms since the epoch */
	now?(): number;
	/** ms until the earliest timer a user process waits on (not the kernel's own), null for none */
	userTimerMs?(): Promise<number | null>;
	/**
	 * a machine checkpointed after boot (src/worker/bootstrap.ts), when the host has one taken from
	 * this build: a machine with nothing stored restores it instead of booting
	 */
	bootstrap?(): Promise<{
		snapshot: Snapshot;
		lazy: { byteLength: number; read(start: number, end: number): Promise<Uint8Array> };
	} | null>;
}

/**
 * a checkpoint's cost in ms, modeled: a deployed Worker's clock stands still while it computes. The
 * terms are the write-back rig's measurements: ~50 ms to unwind and rewind, 2 ms per MiB hashed,
 * 0.2 ms per page written
 */
export function checkpointCost(bytes: number, changed: number): number {
	return 50 + (2 * bytes) / (1 << 20) + 0.2 * changed;
}

/** the soonest an unattended machine is woken again, and the longest it is left, ms */
export const QUIET_MIN_MS = 1000;
export const QUIET_MAX_MS = 3_600_000;

/**
 * An event's pump is bounded by steps as well as by its wall budget: a deployed Worker's clock moves
 * only at some I/O (a storage sync that wrote, a timer only sometimes), so a job that does none never
 * reaches a wall budget, and one event ran 23 s of CPU against 30 s allowed. A step is one task's
 * turn; its cost is learned from the real time an event took, read at the start of the next, and
 * starts at 1 ms (0.3 ms for the write job and 0.55 ms for a CPU loop under Node)
 */
export const STEP_MS_START = 1;
export const STEPS_MIN = 500;
// ponytail: a turn whose steps got k times dearer mid-event runs k times its budget before the
// next turn learns it; a CPU clock or per-step cost weights would close that
export const STEPS_MAX = 12_000;
/** the event right after a restore spent part of its CPU on the restore: half the steps */
export const RESTORE_SHARE = 0.5;

/**
 * The choices the idle-machine measurements compare. The defaults are what the site runs; each
 * other value is an option under test
 */
export interface Policy {
	/**
	 * how an alarm turn ends: `first` at the first wait for a timer, `budget` never (it sleeps out
	 * its wall budget), `remaining` when a wait outlasts what is left of the budget, `over` when a
	 * wait is longer than `overMs`
	 */
	turnEnd: 'first' | 'budget' | 'remaining' | 'over';
	overMs: number;
	/**
	 * what happens to a timer wake the thermal rule drops: `rule` it is dropped, `always` every wake
	 * is kept, `floor` it is held off to one wake per `floorMs`, `ontime` it is kept (no more than
	 * one per `floorMs`) only while the host reports a user timer pending
	 */
	wake: 'rule' | 'always' | 'floor' | 'ontime';
	floorMs: number;
	/** checkpoints at the end of every alarm turn, so what a silent job did in it survives the object being lost */
	saveWake: boolean;
	/** wakes a machine that has runnable work and no timer to wait on (a checkpoint clears the alarm that would have) */
	rearmBusy: boolean;
	/** keeps the quiet period in `gmux_meta`, so an object that lost its instance does not restart it */
	persistQuiet: boolean;
}

export const DEFAULT_POLICY: Policy = {
	turnEnd: 'over',
	overMs: 100,
	wake: 'floor',
	floorMs: 900_000,
	saveWake: true,
	rearmBusy: true,
	persistQuiet: true
};

/** one pump's steps, and what stopped it */
interface Turn {
	start: number;
	steps: number;
	stopped: 'steps' | 'wall' | null;
}

/**
 * Keeps one machine durable in its Durable Object's SQLite: restores it from the last checkpoint
 * and the files synced after it when the object lost it, checkpoints when the adaptive interval
 * comes due, and keeps the object's one alarm on the earliest of the machine's next Linux deadline
 * and its unsaved work.
 *
 * An idle kernel always has a timer within a few seconds (its own housekeeping), so an unattended
 * machine is not woken sooner than a quiet period that doubles, up to an hour, each time it ran
 * without output, input or a file sync, and drops back to a second when it does something. A
 * user's timer then fires late by at most about as long as the machine had been quiet
 */
export class Keeper {
	machine: Machine | null = null;
	readonly store: DurableStore;
	readonly alarm: Alarm;
	/** checkpoints taken, restores from storage, bootstrap images restored, checkpoints refused */
	counts = { checkpoints: 0, restores: 0, bootstraps: 0, refused: 0 };
	/** what the last checkpoint wrote, and why the last refused one was refused */
	last: { written: Written | null; refused: string | null } = { written: null, refused: null };
	/** how long an unattended idle machine is left before its next wake, ms */
	quietMs = QUIET_MIN_MS;

	/** what one step of the pump costs, ms of real time, as learned */
	stepMs = STEP_MS_START;
	/** the step cap the last turn ran under */
	stepCap = 0;

	private lastTurn: Turn | null = null;

	/** the steps the last turn ran */
	get turnSteps(): number {
		return this.lastTurn?.steps ?? 0;
	}
	private restoredNow = false;
	private cadence: Cadence;
	/** output, input or a file sync since the alarm was last pointed, and since the last checkpoint */
	private active = false;
	private dirty = false;
	private readonly host: KeeperHost;
	/** what arrivals it has seen, which the thermal rule reads a reuse probability from */
	history: History | null;
	/** the last keep-or-drop decision, and how many of each this instance made */
	thermal: { last: Decision | null; kept: number; dropped: number } = {
		last: null,
		kept: 0,
		dropped: 0
	};

	readonly policy: Policy;

	constructor(host: KeeperHost, interval: IntervalOptions = {}, policy: Partial<Policy> = {}) {
		this.host = host;
		this.policy = { ...DEFAULT_POLICY, ...policy };
		this.store = new DurableStore(host.sql);
		this.alarm = new Alarm(host.alarms);
		const meta = (k: string) =>
			host.sql.exec('SELECT v FROM gmux_meta WHERE k = ?', k).toArray()[0]?.v;
		const learned = meta('cadence');
		this.cadence = new Cadence(interval, learned ? JSON.parse(String(learned)) : undefined);
		const seen = meta('thermal');
		this.history = seen ? JSON.parse(String(seen)) : null;
		const quiet = this.policy.persistQuiet ? Number(meta('quiet')) : 0;
		if (quiet >= QUIET_MIN_MS) this.quietMs = quiet;
	}

	private saveHistory() {
		this.host.sql.exec(
			"INSERT OR REPLACE INTO gmux_meta (k, v) VALUES ('thermal', ?)",
			JSON.stringify(this.history)
		);
	}

	/** somebody attached to the machine */
	arrived() {
		this.history = arrive(this.history, this.now());
		this.saveHistory();
	}

	private now() {
		return this.host.now ? this.host.now() : Date.now();
	}

	/** the machine did something a user can see: printed, took input, or synced a file */
	activity() {
		this.active = true;
		this.dirty = true;
	}

	private options(extra: Partial<MachineOptions> = {}): MachineOptions {
		return {
			...this.host.options(),
			fileSync: async (file) => {
				this.activity();
				this.store.writeFile(file);
				await this.host.sync();
			},
			...extra
		};
	}

	private saveCadence() {
		this.host.sql.exec(
			"INSERT OR REPLACE INTO gmux_meta (k, v) VALUES ('cadence', ?)",
			JSON.stringify(this.cadence.learned)
		);
	}

	/** restores the last checkpoint into `memory` (the old machine's, when it had one) */
	private async restore(memory?: WebAssembly.Memory): Promise<Machine | null> {
		const recovery = this.store.recover();
		if (!recovery) return null;
		this.machine = null;
		this.machine = await Machine.restore(
			this.options({ restoreFiles: recovery.files, memory }),
			decodeSnapshot(recovery.snapshot),
			recovery.image
		);
		return this.machine;
	}

	/**
	 * the machine: the running one, else the last checkpoint restored (the object lost its machine,
	 * which the cadence learns from), else the host's bootstrap image restored, else a new one that
	 * boots when first run
	 */
	async open(): Promise<{
		machine: Machine;
		from: 'running' | 'restored' | 'bootstrapped' | 'booted';
	}> {
		if (this.machine) return { machine: this.machine, from: 'running' };
		if (!this.history) {
			this.history = begin(this.now());
			this.saveHistory();
		}
		const restored = await this.restore(this.host.options().memory);
		if (restored) {
			this.counts.restores++;
			this.restoredNow = true;
			this.cadence.lost();
			this.saveCadence();
			return { machine: restored, from: 'restored' };
		}
		this.dirty = true;
		const image = await this.host.bootstrap?.();
		if (image) {
			this.machine = await Machine.restore(
				this.options(),
				image.snapshot,
				undefined,
				image.lazy
			);
			this.counts.bootstraps++;
			this.restoredNow = true;
			return { machine: this.machine, from: 'bootstrapped' };
		}
		this.machine = new Machine(this.options());
		return { machine: this.machine, from: 'booted' };
	}

	/**
	 * the stop condition for one event's pump (`Machine.run`'s `until`): `budgetMs` of wall time or
	 * the step cap, whichever comes first. The previous turn, when its cap stopped it, teaches the
	 * cost of a step: its steps over the real time from its start to now (one the clock stopped may
	 * have slept, so it teaches nothing). A dearer step lowers the cap at once; a cheaper one raises
	 * it at most twofold a turn; `unattended` also ends it at the first wait (see `sleeper`)
	 */
	turn(budgetMs: number, unattended = false): () => boolean {
		this.unattended = unattended;
		this.idled = false;
		this.waitedMs = 0;
		const start = this.now();
		this.budgetMs = budgetMs;
		this.startedAt = start;
		const last = this.lastTurn;
		// a deployed clock can stand still from one event to the next, and a step then looks free
		// (one event ran 18 s of CPU on a cap learned at 0 ms): a turn the clock never saw teaches nothing
		if (last?.stopped === 'steps' && start > last.start)
			this.stepMs = (start - last.start) / last.steps;
		const fit = Math.floor(budgetMs / this.stepMs);
		let cap = Math.min(STEPS_MAX, fit, this.stepCap ? 2 * this.stepCap : fit);
		if (this.restoredNow) cap *= RESTORE_SHARE;
		this.restoredNow = false;
		this.stepCap = Math.max(STEPS_MIN, Math.floor(cap));
		const turn: Turn = { start, steps: 0, stopped: null };
		this.lastTurn = turn;
		const stepCap = this.stepCap;
		return () => {
			if (++turn.steps > stepCap) turn.stopped = 'steps';
			// a deployed clock stands still while code runs, so an unattended turn's waits count too
			else if (Math.max(this.now() - start, this.waitedMs) > budgetMs) turn.stopped = 'wall';
			return turn.stopped !== null || this.idled;
		};
	}

	private unattended = false;
	private idled = false;
	private budgetMs = 0;
	private startedAt = 0;
	private waitedMs = 0;

	private endsTurn(ms: number): boolean {
		if (!this.unattended || ms <= 0) return false;
		switch (this.policy.turnEnd) {
			case 'first':
				return true;
			case 'budget':
				return false;
			case 'remaining':
				return ms > this.budgetMs - (this.now() - this.startedAt);
			case 'over':
				return ms > this.policy.overMs;
		}
	}

	/**
	 * the pump's wait for a Linux timer. On an unattended turn (an alarm woke the machine) a wait the
	 * policy's `turnEnd` names ends the turn and the alarm holds the rest (sleeping out the budget
	 * billed 5 s a wake); the others count against the budget
	 */
	sleeper(wait: (ms: number) => Promise<void>): (ms: number) => Promise<void> {
		return (ms) => {
			if (this.endsTurn(ms)) this.idled = true;
			else if (this.unattended && ms > 0) this.waitedMs += ms;
			return wait(ms);
		};
	}

	/**
	 * the machine ran for `ms` and its pump has returned: checkpoints when due, then points the
	 * alarm at what comes next; `attended` when a warm socket drives the machine, so no Linux timer
	 * needs the alarm. Answers what a checkpoint wrote
	 */
	async ran(ms: number, attended = false): Promise<Written | null> {
		const turn = this.lastTurn;
		// the clock missed the CPU a turn spent; its steps did not
		this.cadence.ran(Math.max(ms, turn ? turn.steps * this.stepMs : 0));
		// a turn stopped by its budget had work left: the machine is busy, not quiet
		if (turn?.stopped) this.activity();
		const saveNow = this.policy.saveWake && this.unattended;
		const written =
			this.machine && (this.cadence.due || saveNow) ? await this.checkpoint() : null;
		await this.arm(attended);
		return written;
	}

	/** checkpoints the machine now and continues it from the store; null when it refused */
	async checkpoint(): Promise<Written | null> {
		// one at a time: until the resume below, the machine is spent or gone
		if (!this.machine || this.checkpointing) return null;
		this.checkpointing = true;
		try {
			return await this.checkpointOnce(this.machine);
		} finally {
			this.checkpointing = false;
		}
	}

	private checkpointing = false;

	private async checkpointOnce(machine: Machine): Promise<Written | null> {
		const memory = machine.memory;
		let snapshot;
		try {
			snapshot = await machine.checkpoint();
		} catch (error) {
			// a refusal leaves the machine running; the next quantum tries again
			this.counts.refused++;
			this.last.refused = String((error as Error).message ?? error);
			return null;
		}
		const written = this.store.writeCheckpoint(snapshot.memory, encodeSnapshot(snapshot));
		await this.host.sync();
		this.cadence.checkpointed(
			checkpointCost(snapshot.memory.byteLength, written.changed),
			written.rows
		);
		this.saveCadence();
		this.counts.checkpoints++;
		this.last.written = written;
		this.dirty = false;
		// a checkpointed machine continues only from a restore; its memory already is the image, and
		// the old instances go before the new ones are made
		this.machine = null;
		this.machine = await Machine.resume(this.options({ memory }), snapshot);
		return written;
	}

	/** the timer wake the rule dropped, as the policy leaves it: null, or the time it is kept at */
	private async dropped(timer: number, now: number): Promise<number | null> {
		const { wake, floorMs } = this.policy;
		let kept: number | null = null;
		if (wake === 'always') kept = timer;
		else if (wake === 'floor') kept = Math.max(timer, now + floorMs);
		else if (wake === 'ontime') {
			const userMs = (await this.host.userTimerMs?.()) ?? null;
			if (userMs !== null) kept = Math.max(timer, now + Math.max(userMs, floorMs));
		}
		if (kept === null && this.history && this.history.dropped === undefined) {
			this.history = { ...this.history, dropped: now };
			this.saveHistory();
		}
		return kept;
	}

	/**
	 * the next Linux deadline, no sooner than the quiet period, and unsaved work an interval of wall
	 * time from now, on the one alarm
	 */
	async arm(attended = false) {
		const machine = this.machine;
		const now = this.now();
		const idle = !this.active;
		const quiet = this.active ? QUIET_MIN_MS : Math.min(this.quietMs * 2, QUIET_MAX_MS);
		if (this.policy.persistQuiet && quiet !== this.quietMs)
			this.host.sql.exec(
				"INSERT OR REPLACE INTO gmux_meta (k, v) VALUES ('quiet', ?)",
				String(quiet)
			);
		this.quietMs = quiet;
		this.active = false;
		const deadline = machine?.deadline ?? null;
		const rearm = this.policy.rearmBusy && machine?.runnable === true;
		let timer = attended
			? null
			: deadline === null
				? rearm
					? now + this.quietMs
					: null
				: now + Math.max(this.quietMs, Number(deadline - machine!.clockNs) / 1e6);
		// a machine that did nothing visible is kept awake only while its arrivals pay for the wake
		if (timer !== null && idle) {
			const decision = machineWake(this.history, now, timer - now);
			this.thermal.last = decision;
			this.thermal[decision.kept ? 'kept' : 'dropped']++;
			this.host.decided?.(decision);
			if (!decision.kept) timer = await this.dropped(timer, now);
		}
		this.alarm.want('timer', timer);
		this.alarm.want('checkpoint', machine && this.dirty ? now + this.cadence.interval : null);
		await this.alarm.sync();
	}

	/**
	 * the alarm fired: checkpoints unsaved work that came due (not while the machine `running`
	 * in a pump), and answers whether the machine
	 * should run: a Linux timer came due, or this object is new, cannot tell what the alarm was for,
	 * and has a machine stored
	 */
	async woke(running = false): Promise<boolean> {
		const fresh = !this.machine && this.alarm.next === null;
		const kinds = this.alarm.fired(this.now());
		// a running pump checkpoints when it returns, if due
		if (kinds.includes('checkpoint') && this.machine && this.dirty && !running)
			await this.checkpoint();
		return kinds.includes('timer') || (fresh && this.store.checkpointed);
	}

	/** the machine halted: drop it and everything stored, so the next open boots */
	async halted() {
		this.machine = null;
		this.store.clear();
		await this.host.sync();
		this.alarm.want('timer', null);
		this.alarm.want('checkpoint', null);
	}

	/** the machine stopped with an error: drop it, and the next open restores the last checkpoint */
	crashed() {
		this.machine = null;
	}
}
