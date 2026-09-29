import { describe, expect, it } from 'vitest';
import {
	arrive,
	begin,
	decide,
	EPISODE_MS,
	keeps,
	LEVELS,
	machineWake,
	MIN_SPAN_MS,
	price,
	rate,
	RESIDENT_MS,
	RESTORE_MS,
	reuse,
	TAU_MS,
	WAKE_MS,
	type History
} from '../../src/worker/thermal.ts';

const HOUR = 3_600_000;

describe('keeps', () => {
	it('keeps when reuse * miss beats keep + transition, and drops on a tie', () => {
		expect(keeps({ reuse: 0.5, miss: 100, keep: 30, transition: 19 })).toBe(true);
		expect(keeps({ reuse: 0.5, miss: 100, keep: 30, transition: 20 })).toBe(false);
		expect(keeps({ reuse: 0.5, miss: 100, keep: 30, transition: 21 })).toBe(false);
	});

	it('weighs the miss by the probability: certain reuse pays, impossible reuse never does', () => {
		expect(keeps({ reuse: 1, miss: 10, keep: 9, transition: 0 })).toBe(true);
		expect(keeps({ reuse: 0, miss: 1e9, keep: 0, transition: 0 })).toBe(false);
	});

	it('counts the transition against keeping', () => {
		expect(keeps({ reuse: 1, miss: 10, keep: 4, transition: 5 })).toBe(true);
		expect(keeps({ reuse: 1, miss: 10, keep: 4, transition: 6 })).toBe(false);
	});
});

describe('decide', () => {
	it('answers with every input and the gain, for each of the six levels', () => {
		for (const level of LEVELS) {
			const d = decide(level, { reuse: 0.25, miss: 80, keep: 5, transition: 5 });
			expect(d).toEqual({
				level,
				kept: true,
				reuse: 0.25,
				miss: 80,
				keep: 5,
				transition: 5,
				gain: 10,
				why: 'reuse pays for keeping'
			});
		}
		const dropped = decide('lane', { reuse: 0.25, miss: 80, keep: 5, transition: 15 });
		expect(dropped).toMatchObject({
			kept: false,
			gain: 0,
			why: 'reuse does not pay for keeping'
		});
	});

	it('keeps with no history, because nothing measured says drop', () => {
		expect(
			decide('machine', { reuse: null, miss: 1, keep: 1e9, transition: 1e9 })
		).toMatchObject({
			kept: true,
			gain: null,
			reuse: null
		});
	});

	it('refuses inputs that are not a probability or a cost', () => {
		const ok = { miss: 1, keep: 1, transition: 1 };
		expect(() => decide('machine', { ...ok, reuse: 1.01 })).toThrow(RangeError);
		expect(() => decide('machine', { ...ok, reuse: -0.1 })).toThrow(RangeError);
		expect(() => decide('machine', { ...ok, reuse: Number.NaN })).toThrow(RangeError);
		expect(() => decide('machine', { reuse: 0.5, ...ok, miss: -1 })).toThrow(/miss/);
		expect(() => decide('machine', { reuse: 0.5, ...ok, keep: Number.NaN })).toThrow(/keep/);
		expect(() => decide('machine', { reuse: 0.5, ...ok, transition: Infinity })).toThrow(
			/transition/
		);
	});
});

describe('price', () => {
	it("is parts per million of Free's day, per meter", () => {
		expect(price.requests(1)).toBe(10);
		expect(price.rows(1)).toBe(10);
		// 128 MB for a second is 0.128 GB-s of 13,000
		expect(price.wall(1000)).toBeCloseTo((0.128 * 1e6) / 13_000, 9);
		expect(price.wall(0)).toBe(0);
	});
});

describe('arrivals', () => {
	it('reads no rate before it has watched long enough, and none with no history', () => {
		expect(rate(null, 0)).toBeNull();
		expect(reuse(null, 0, 1000)).toBeNull();
		const h = begin(1_000_000);
		expect(rate(h, 1_000_000 + MIN_SPAN_MS - 1)).toBeNull();
		expect(rate(h, 1_000_000 + MIN_SPAN_MS)).toBe(0);
	});

	it('counts an arrival once per episode', () => {
		let h: History = begin(0);
		h = arrive(h, 100_000);
		expect(h.events).toBe(1);
		const same = arrive(h, 100_000 + EPISODE_MS - 1);
		expect(same).toBe(h);
		expect(arrive(h, 100_000 + EPISODE_MS).events).toBeCloseTo(
			1 + Math.exp(-EPISODE_MS / TAU_MS),
			9
		);
		expect(arrive(null, 500_000).events).toBe(1);
	});

	it('reads a steady rate back within a few percent, young or old', () => {
		let h: History | null = null;
		const every = 2 * HOUR;
		// arrivals per period read back, where 1 is exact
		const perPeriod = (history: History | null, now: number) =>
			rate(history, now)! * (every / 1000);
		for (let t = 0; t <= 10 * 86_400_000; t += every) h = arrive(h, t);
		expect(perPeriod(h, 10 * 86_400_000)).toBeGreaterThan(0.95);
		expect(perPeriod(h, 10 * 86_400_000)).toBeLessThan(1.15);
		let young: History | null = null;
		for (let t = 0; t <= 6 * HOUR; t += every) young = arrive(young, t);
		expect(perPeriod(young, 6 * HOUR)).toBeGreaterThan(0.9);
		expect(perPeriod(young, 6 * HOUR)).toBeLessThan(1.6);
	});

	it('lets a busy past fade until the rate is small', () => {
		let h: History = begin(0);
		for (let i = 0; i < 100; i++) h = arrive(h, i * 2 * EPISODE_MS);
		const busy = rate(h, 100 * 2 * EPISODE_MS)!;
		const later = rate(h, 5 * 86_400_000)!;
		expect(later).toBeLessThan(busy / 100);
	});

	it('gives the probability of an arrival within a window from the rate', () => {
		const h: History = { first: 0, at: 0, last: 0, events: 0 };
		expect(reuse(h, 2 * MIN_SPAN_MS, 15_000)).toBe(0);
		const busy: History = { first: 0, at: 10 * HOUR, last: 10 * HOUR, events: 36_000 };
		const r = rate(busy, 10 * HOUR)!;
		expect(reuse(busy, 10 * HOUR, 15_000)).toBeCloseTo(1 - Math.exp(-r * 15), 12);
		expect(reuse(busy, 10 * HOUR, 0)).toBe(0);
	});

	it('survives JSON, which is how a keeper stores it', () => {
		const h = arrive(begin(5_000_000), 5_100_000);
		expect(JSON.parse(JSON.stringify(h))).toEqual(h);
		expect(JSON.parse(JSON.stringify(begin(1)))).toEqual(begin(1));
	});
});

describe('machineWake', () => {
	it('keeps with no history, and reads none before the observation is long enough', () => {
		expect(machineWake(null, 0, 1000)).toMatchObject({ kept: true, reuse: null });
		expect(machineWake(begin(0), MIN_SPAN_MS - 1, 1000)).toMatchObject({ kept: true });
	});

	it('drops a machine nobody has come back to', () => {
		const d = machineWake(begin(0), 5 * HOUR, HOUR);
		expect(d).toMatchObject({ level: 'machine', kept: false, reuse: 0 });
		expect(d.gain).toBeLessThan(0);
	});

	it('prices the miss as a restore, the wake as a request, a row and its pump, and a far wake as a restore too', () => {
		const near = machineWake(begin(0), HOUR, RESIDENT_MS);
		const far = machineWake(begin(0), HOUR, RESIDENT_MS + 1);
		expect(near.miss).toBeCloseTo(price.wall(RESTORE_MS), 9);
		expect(near.keep).toBeCloseTo(20 + price.wall(WAKE_MS), 9);
		expect(near.transition).toBe(0);
		expect(far.transition).toBeCloseTo(price.wall(RESTORE_MS), 9);
	});

	it('does not keep even at certain reuse: the wake costs more than the restore it saves', () => {
		const certain: History = { first: 0, at: 0, last: 0, events: 1e12 };
		const d = machineWake(certain, HOUR, 1000);
		expect(d.reuse).toBe(1);
		expect(d.kept).toBe(false);
		// a request and a row alone are 20 ppm, a restore has to take 2 s of wall to match
		expect(d.miss).toBeLessThan(20);
		expect(price.wall(2032)).toBeGreaterThan(20);
		expect(price.wall(2031)).toBeLessThan(20);
	});
});
