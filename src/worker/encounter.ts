/**
 * How often a request meets a machine that is not running: the share of requests that had to wait for
 * a restore, a bootstrap image or a boot. A request is counted once, by what the object had to do for
 * it, in the shape of the cold-encounter counters the sibling project keeps for its PHP runtime
 */

/** one request's outcome, from the object's point of view */
export type Encounter =
	/** refused before the machine was woken: a body over the bound, an object still being placed */
	| 'none'
	/** needed the machine and found it running */
	| 'warm'
	/** needed it and restored the last checkpoint */
	| 'restored'
	/** needed it and restored the shipped bootstrap image */
	| 'bootstrapped'
	/** needed it and booted it */
	| 'booted';

/** how the keeper opened the machine a request needed (`Keeper.open`) */
export type Opened = 'running' | 'restored' | 'bootstrapped' | 'booted';

export type EncounterCounts = Record<Encounter, number>;

export const ZERO_ENCOUNTERS: EncounterCounts = {
	none: 0,
	warm: 0,
	restored: 0,
	bootstrapped: 0,
	booted: 0
};

const ORDER = ['none', 'warm', 'restored', 'bootstrapped', 'booted'] as const;

/** what the machine's opening says about the request: a running machine is warm, any other way is cold */
export function encounterOf(from: Opened): Encounter {
	return from === 'running' ? 'warm' : from;
}

/**
 * The counts and three cold shares: of the requests that used the machine, of the requests the object
 * saw, and of its requests that the machine's state decided. A share is null on an empty denominator,
 * so an unused object does not read as well tuned
 */
export type EncounterReport = EncounterCounts & {
	total: number;
	/** requests that used the machine */
	machine: number;
	cold: number;
	coldOfMachine: number | null;
	coldOfTotal: number | null;
};

/** the totals and cold shares of one object's counts */
export function report(counts: EncounterCounts): EncounterReport {
	const cold = counts.restored + counts.bootstrapped + counts.booted;
	const machine = counts.warm + cold;
	const total = machine + counts.none;
	return {
		...counts,
		total,
		machine,
		cold,
		coldOfMachine: machine === 0 ? null : Number((cold / machine).toFixed(4)),
		coldOfTotal: total === 0 ? null : Number((cold / total).toFixed(4))
	};
}

/** the counts with the outcome added */
export function record(counts: EncounterCounts, outcome: Encounter): EncounterCounts {
	return { ...counts, [outcome]: counts[outcome] + 1 };
}

/** `meta` is TEXT */
export function serialise(counts: EncounterCounts): string {
	return ORDER.map((k) => counts[k]).join(',');
}

/** reads the counts back; anything unexpected is zero, since a lost count beats a wrong share */
export function parse(raw: string | null | undefined): EncounterCounts {
	if (!raw) return { ...ZERO_ENCOUNTERS };
	const parts = raw.split(',').map(Number);
	if (parts.length !== ORDER.length || parts.some((n) => !Number.isSafeInteger(n) || n < 0))
		return { ...ZERO_ENCOUNTERS };
	return Object.fromEntries(ORDER.map((k, i) => [k, parts[i]!])) as EncounterCounts;
}

/** where the counts live between instances of the object */
export interface EncounterStore {
	get(): string | null;
	set(value: string): void;
}

/**
 * The object's counters. A cold encounter is written at once (it is the event the counters exist for,
 * and each one cost a restore or a boot already); warm and refused requests are counted in memory and
 * written with the next cold encounter or `flush` (the keeper's checkpoints), so a request costs no
 * row. An isolate that dies loses the warm and refused requests since the last write, never a cold one
 */
export class Encounters {
	private counts: EncounterCounts;
	private dirty = false;
	private readonly store: EncounterStore;

	constructor(store: EncounterStore) {
		this.store = store;
		this.counts = parse(store.get());
	}

	record(outcome: Encounter) {
		this.counts = record(this.counts, outcome);
		this.dirty = true;
		if (outcome !== 'none' && outcome !== 'warm') this.flush();
	}

	/** writes the counts if any request has been counted since the last write */
	flush() {
		if (!this.dirty) return;
		this.dirty = false;
		this.store.set(serialise(this.counts));
	}

	report(): EncounterReport {
		return report(this.counts);
	}
}
