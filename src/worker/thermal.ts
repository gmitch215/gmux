/** the levels one keep-or-drop rule serves; only the machine's has a call site so far (keeper.arm) */
export const LEVELS = ['machine', 'process', 'executable', 'chunk', 'lane', 'result'] as const;
export type Level = (typeof LEVELS)[number];

/** what a decision weighs, all in one unit (ppm of Free's day, see `price`) */
export interface Inputs {
	/** probability the kept thing is used again within the window; null when there is no history */
	reuse: number | null;
	/** what a use costs when the thing was dropped */
	miss: number;
	/** what keeping it costs over the window */
	keep: number;
	/** what moving it into the kept state costs */
	transition: number;
}

export interface Decision extends Inputs {
	level: Level;
	kept: boolean;
	/** `reuse * miss - keep - transition`, null when `reuse` is */
	gain: number | null;
	why: string;
}

/** keeps when `reuse * miss > keep + transition`; a tie drops */
export function keeps(inputs: Inputs & { reuse: number }): boolean {
	return inputs.reuse * inputs.miss > inputs.keep + inputs.transition;
}

/** the rule, with its inputs kept in the answer; with no history it keeps, as nothing measured says drop */
export function decide(level: Level, inputs: Inputs): Decision {
	const { reuse, miss, keep, transition } = inputs;
	if (reuse !== null && !(reuse >= 0 && reuse <= 1))
		throw new RangeError(`reuse is a probability, got ${reuse}`);
	for (const [name, value] of Object.entries({ miss, keep, transition }))
		if (!(value >= 0) || !Number.isFinite(value))
			throw new RangeError(`${name} is a cost, got ${value}`);
	if (reuse === null)
		return {
			level,
			kept: true,
			...inputs,
			gain: null,
			why: 'no history, so nothing says drop'
		};
	const gain = reuse * miss - keep - transition;
	const kept = keeps({ ...inputs, reuse });
	return {
		level,
		kept,
		...inputs,
		gain,
		why: kept ? 'reuse pays for keeping' : 'reuse does not pay for keeping'
	};
}

// #region price
/** Free's daily Durable Object meters: requests, rows written, and GB-s of duration at 128 MB */
export const FREE_DAY = { requests: 100_000, rows: 100_000, gbSeconds: 13_000 };
export const OBJECT_GB = 0.128;

/** costs as parts per million of the Free day's meter they draw on, so unlike meters add */
export const price = {
	requests: (n: number) => (n * 1e6) / FREE_DAY.requests,
	rows: (n: number) => (n * 1e6) / FREE_DAY.rows,
	wall: (ms: number) => (ms / 1000) * ((OBJECT_GB * 1e6) / FREE_DAY.gbSeconds)
};
// #endregion

// #region history
/** what arrivals a keeper has seen; `events` is decayed to `at`, `last` is the last one counted */
export interface History {
	first: number;
	at: number;
	last: number;
	events: number;
	/** when the rule first dropped since the last arrival */
	dropped?: number;
}

/** older arrivals count for less: a day, the length of the meters it is priced against */
export const TAU_MS = 86_400_000;
/** no rate is read from less observation than this */
export const MIN_SPAN_MS = 600_000;
/** arrivals closer than this are one use */
export const EPISODE_MS = 60_000;

const decayed = (history: History, now: number) =>
	history.events * Math.exp(-Math.max(now - history.at, 0) / TAU_MS);

/** starts observing, counting nothing */
export function begin(now: number): History {
	return { first: now, at: now, last: now - EPISODE_MS, events: 0 };
}

/** counts an arrival, unless it is inside the last one's episode */
export function arrive(history: History | null, now: number): History {
	const seen = history ?? begin(now);
	if (now - seen.last < EPISODE_MS) return seen;
	return { first: seen.first, at: now, last: now, events: decayed(seen, now) + 1 };
}

/**
 * Arrivals per second, or null before `MIN_SPAN_MS` of observation. The events are divided by the
 * window a decaying count of a steady rate accumulates, `tau * (1 - exp(-span / tau))`, so a young
 * history is not read as a burst.
 */
export function rate(history: History | null, now: number): number | null {
	if (!history || now - history.first < MIN_SPAN_MS) return null;
	const window = TAU_MS * (1 - Math.exp(-(now - history.first) / TAU_MS));
	return (decayed(history, now) * 1000) / window;
}

/** P(at least one arrival within `windowMs`), if arrivals are a Poisson process (an assumption) */
export function reuse(history: History | null, now: number, windowMs: number): number | null {
	const r = rate(history, now);
	return r === null ? null : 1 - Math.exp((-r * windowMs) / 1000);
}
// #endregion

// #region machine
/** wall ms of an idle alarm event that restored the machine, and of one that did not (n=20, n=61) */
export const RESTORE_MS = 73;
export const WAKE_MS = 39;
/** how long an object woken by an alarm stays in memory, ms: lost by 15 s in the residency arms */
export const RESIDENT_MS = 15_000;

/**
 * Whether an idle machine's timer wake is worth arming. A wake keeps the machine in memory for
 * `RESIDENT_MS`, and an arrival in that window skips the restore it would pay. The wake costs a
 * request, an alarm row and its pump; when it is further off than that window it also restores the
 * machine to run. What an on-time Linux timer is worth to its owner is not priced here.
 */
export function machineWake(history: History | null, now: number, inMs: number): Decision {
	return decide('machine', {
		reuse: reuse(history, now, RESIDENT_MS),
		miss: price.wall(RESTORE_MS),
		keep: price.requests(1) + price.rows(1) + price.wall(WAKE_MS),
		transition: inMs > RESIDENT_MS ? price.wall(RESTORE_MS) : 0
	});
}
// #endregion
