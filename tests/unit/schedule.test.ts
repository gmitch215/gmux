import { describe, expect, it } from 'vitest';
import { Alarm, Cadence, checkpointInterval } from '../../src/worker/schedule.ts';

describe('checkpointInterval', () => {
	it("is Young's optimum, sqrt(2 C M), between its bounds", () => {
		// 300 ms checkpoints, a loss every 30 minutes of machine time
		expect(checkpointInterval(300, 0)).toBeCloseTo(Math.sqrt(2 * 300 * 1_800_000), 6);
		expect(checkpointInterval(0.001, 0)).toBe(5_000);
		expect(checkpointInterval(1e6, 0)).toBe(600_000);
	});

	it("never checkpoints faster than the machine's share of the daily rows allows", () => {
		// 50 rows a checkpoint against 50,000 rows a day is one checkpoint every 86.4 s
		expect(checkpointInterval(1, 50)).toBeCloseTo(86_400, 6);
		expect(checkpointInterval(1, 50, { rowsPerDay: 1_000_000, rowShare: 1 })).toBe(5_000);
	});

	it('lets losses that come faster than the rows share allows win', () => {
		// the rows share alone would wait 86.4 s; losses every 20 s cap it at 10 s
		expect(checkpointInterval(1, 50, { lossMs: 20_000 })).toBe(10_000);
	});

	it('follows the loss rate it is given', () => {
		expect(checkpointInterval(1_000, 0, { lossMs: 60_000 })).toBeCloseTo(Math.sqrt(12e7), 6);
	});
});

describe('Cadence', () => {
	it('comes due on machine time run, not wall time, at the interval its last checkpoints set', () => {
		const cadence = new Cadence({ lossMs: 50_000, minMs: 1_000 });
		expect(cadence.due).toBe(false);
		cadence.ran(1_000);
		// before any checkpoint the interval is the lower bound
		expect(cadence.due).toBe(true);
		cadence.checkpointed(100, 0);
		expect(cadence.sinceMs).toBe(0);
		expect(cadence.interval).toBeCloseTo(Math.sqrt(2 * 100 * 50_000), 6);
		cadence.ran(3_000);
		expect(cadence.due).toBe(false);
		cadence.ran(200);
		expect(cadence.due).toBe(true);
	});

	it('learns the mean time between losses, and checkpoints sooner for a machine that keeps losing', () => {
		const cadence = new Cadence({ lossMs: 100_000, minMs: 1 });
		cadence.checkpointed(100, 0);
		const before = cadence.interval;
		for (let i = 0; i < 9; i++) {
			cadence.ran(5_000);
			cadence.lost();
		}
		// nine losses in 45 s of machine time; the interval is capped at half that mean
		expect(cadence.lossMs).toBe(5_000);
		expect(cadence.interval).toBeCloseTo(Math.sqrt(2 * 100 * 5_000), 6);
		expect(cadence.interval).toBeLessThan(before);
		expect(cadence.sinceMs).toBe(0);
	});

	it('carries what it learned to the next instance', () => {
		const first = new Cadence({ lossMs: 100_000 });
		first.checkpointed(200, 3);
		first.ran(4_000);
		first.lost();
		const next = new Cadence({ lossMs: 100_000 }, first.learned);
		expect(next.learned).toEqual({ cost: 200, rows: 3, ranMs: 4_000, losses: 1 });
		expect(next.interval).toBe(first.interval);
		expect(next.sinceMs).toBe(0);
	});

	it('smooths what checkpoints cost', () => {
		const cadence = new Cadence({ lossMs: 50_000, minMs: 1 });
		cadence.checkpointed(100, 0);
		cadence.checkpointed(200, 0);
		expect(cadence.interval).toBeCloseTo(Math.sqrt(2 * 130 * 50_000), 6);
	});
});

describe('Alarm', () => {
	const storage = (initial: number | null = null) => {
		const s = {
			at: initial,
			calls: [] as number[],
			getAlarm: () => s.at,
			setAlarm: (at: number) => {
				s.at = at;
				s.calls.push(at);
			}
		};
		return s;
	};

	it('sets the one alarm for the earliest deadline wanted, and moves it only earlier', async () => {
		const s = storage();
		const alarm = new Alarm(s);
		alarm.want('timer', 5_000);
		alarm.want('checkpoint', 9_000);
		await alarm.sync();
		alarm.want('watchdog', 7_000);
		await alarm.sync();
		alarm.want('timer', 3_000);
		await alarm.sync();
		expect(s.calls).toEqual([5_000, 3_000]);
		expect(alarm.sets).toBe(2);
		expect(alarm.next).toBe(3_000);
	});

	it('keeps an alarm already set early enough, from an earlier instance', async () => {
		const s = storage(1_000);
		const alarm = new Alarm(s);
		alarm.want('timer', 2_000);
		await alarm.sync();
		expect(s.calls).toEqual([]);
	});

	it('sets again after firing, from the deadlines still ahead', async () => {
		const s = storage();
		const alarm = new Alarm(s);
		alarm.want('timer', 1_000);
		alarm.want('checkpoint', 4_000);
		await alarm.sync();
		expect(alarm.fired(1_000)).toEqual(['timer']);
		await alarm.sync();
		expect(s.calls).toEqual([1_000, 4_000]);
		alarm.want('checkpoint', null);
		expect(alarm.fired(4_000)).toEqual([]);
		await alarm.sync();
		expect(alarm.next).toBeNull();
		expect(s.calls).toHaveLength(2);
	});
});
