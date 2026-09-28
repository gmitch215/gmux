/**
 * When a running machine checkpoints, and the one alarm that wakes an idle one.
 *
 * A quantum boundary is not a checkpoint boundary. The interval is Young's optimum for a job that
 * loses its work since the last checkpoint at a mean rate: `sqrt(2 C M)`, with `C` what a
 * checkpoint costs and `M` the mean machine time between losses. It is counted in time the machine
 * actually ran, so an idle machine never comes due. It never checkpoints faster than its share of
 * the daily rows budget allows, unless losses come faster still: an interval longer than half the
 * mean time between losses would let most work be lost before it is saved.
 */
export interface IntervalOptions {
	/**
	 * mean machine time between losses before any is seen, ms; a warm socket kept an object 30+
	 * minutes (default 30 min)
	 */
	lossMs?: number;
	/** the account's daily rows-written budget (Free: 100,000) */
	rowsPerDay?: number;
	/** the share of it this machine's checkpoints may spend (default 0.5) */
	rowShare?: number;
	/** bounds on the interval, ms of machine time (defaults 5 s and 10 min) */
	minMs?: number;
	maxMs?: number;
}

/** the checkpoint interval in machine-busy ms, from what the last checkpoints cost */
export function checkpointInterval(costMs: number, rows: number, options: IntervalOptions = {}) {
	const loss = options.lossMs ?? 30 * 60_000;
	const young = Math.sqrt(2 * Math.max(costMs, 0) * loss);
	const budget = (options.rowsPerDay ?? 100_000) * (options.rowShare ?? 0.5);
	const byRows = (Math.max(rows, 0) * 86_400_000) / budget;
	// the rows share yields to losses: an interval past the mean time between them saves nothing
	const interval = Math.min(Math.max(young, byRows), loss / 2);
	return Math.min(options.maxMs ?? 600_000, Math.max(options.minMs ?? 5_000, interval));
}

/** what a cadence has learned, to carry across instances of the object */
export interface CadenceState {
	cost: number | null;
	rows: number | null;
	/** machine time observed, and the losses in it */
	ranMs: number;
	losses: number;
}

/**
 * Tracks machine time since the last checkpoint and says when the next is due. Costs are smoothed
 * over checkpoints, and a checkpoint that found nothing changed still counts its cost. The mean time
 * between losses is `lossMs` until one is seen, then machine time run over losses seen, so a
 * machine that keeps losing its instance checkpoints more often
 */
export class Cadence {
	private busy = 0;
	private state: CadenceState;

	private readonly options: IntervalOptions;

	constructor(options: IntervalOptions = {}, state?: CadenceState) {
		this.options = options;
		this.state = state ? { ...state } : { cost: null, rows: null, ranMs: 0, losses: 0 };
	}

	/** what it has learned, for `new Cadence(options, state)` in the next instance */
	get learned(): CadenceState {
		return { ...this.state };
	}

	/** the mean machine time between losses, ms */
	get lossMs(): number {
		if (!this.state.losses) return this.options.lossMs ?? 30 * 60_000;
		return this.state.ranMs / this.state.losses;
	}

	/** the machine ran for `ms` */
	ran(ms: number) {
		this.busy += ms;
		this.state.ranMs += ms;
	}

	/** the machine was lost and came back from its last checkpoint */
	lost() {
		this.state.losses++;
		this.busy = 0;
	}

	/** a checkpoint was taken: what it cost, in ms and rows */
	checkpointed(costMs: number, rows: number) {
		const blend = (old: number | null, value: number) =>
			old === null ? value : old * 0.7 + value * 0.3;
		this.state.cost = blend(this.state.cost, costMs);
		this.state.rows = blend(this.state.rows, rows);
		this.busy = 0;
	}

	/** the current interval, ms of machine time */
	get interval(): number {
		return this.state.cost === null
			? (this.options.minMs ?? 5_000)
			: checkpointInterval(this.state.cost, this.state.rows ?? 0, {
					...this.options,
					lossMs: this.lossMs
				});
	}

	/** machine time run since the last checkpoint */
	get sinceMs(): number {
		return this.busy;
	}

	/** whether a checkpoint is due */
	get due(): boolean {
		return this.busy >= this.interval;
	}
}

/** the part of `ctx.storage` the alarm needs */
export interface AlarmStorage {
	getAlarm(): Promise<number | null> | number | null;
	setAlarm(at: number): Promise<void> | void;
}

/**
 * One alarm for the earliest of any number of named deadlines (a Linux timer, a checkpoint coming
 * due, a watchdog). Each `setAlarm` writes a row, so it is moved only when the earliest deadline
 * comes sooner than the alarm already set, or when nothing is set; an alarm left early wakes the
 * object once and is set again from what is wanted then
 */
export class Alarm {
	private readonly wanted = new Map<string, number>();
	private set: number | null | undefined = undefined;
	/** `setAlarm` calls made */
	sets = 0;

	private readonly storage: AlarmStorage;

	constructor(storage: AlarmStorage) {
		this.storage = storage;
	}

	/** wants a wake at `at` (ms since the epoch) for `kind`, or no longer does with null */
	want(kind: string, at: number | null) {
		if (at === null) this.wanted.delete(kind);
		else this.wanted.set(kind, at);
	}

	/** the earliest wanted deadline, or null */
	get next(): number | null {
		let soonest: number | null = null;
		for (const at of this.wanted.values()) if (soonest === null || at < soonest) soonest = at;
		return soonest;
	}

	/** the alarm fired: nothing is set any more, and the deadlines it was for have passed; answers their kinds */
	fired(now: number): string[] {
		this.set = null;
		const passed: string[] = [];
		for (const [kind, at] of this.wanted)
			if (at <= now) {
				this.wanted.delete(kind);
				passed.push(kind);
			}
		return passed;
	}

	/** makes the platform's one alarm cover the earliest wanted deadline */
	async sync() {
		if (this.set === undefined) this.set = await this.storage.getAlarm();
		const next = this.next;
		if (next === null) return;
		if (this.set !== null && this.set <= next) return;
		await this.storage.setAlarm(next);
		this.set = next;
		this.sets++;
	}
}
