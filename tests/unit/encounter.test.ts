import { describe, expect, it } from 'vitest';
import {
	encounterOf,
	Encounters,
	parse,
	record,
	report,
	serialise,
	ZERO_ENCOUNTERS
} from '../../src/worker/encounter.ts';

describe('encounter counts', () => {
	it('classes how the machine was opened: running is warm, every other way is cold and kept apart', () => {
		expect(encounterOf('running')).toBe('warm');
		expect(encounterOf('restored')).toBe('restored');
		expect(encounterOf('bootstrapped')).toBe('bootstrapped');
		expect(encounterOf('booted')).toBe('booted');
	});

	it('adds one outcome at a time and leaves the counts it was given alone', () => {
		const once = record(ZERO_ENCOUNTERS, 'warm');
		expect(once).toEqual({ ...ZERO_ENCOUNTERS, warm: 1 });
		expect(ZERO_ENCOUNTERS.warm).toBe(0);
		expect(record(record(once, 'booted'), 'none')).toEqual({
			...ZERO_ENCOUNTERS,
			warm: 1,
			booted: 1,
			none: 1
		});
	});

	it('reports null shares on an empty denominator, so an unused object is not well tuned', () => {
		expect(report(ZERO_ENCOUNTERS)).toMatchObject({
			total: 0,
			machine: 0,
			cold: 0,
			coldOfMachine: null,
			coldOfTotal: null
		});
		// only refused requests: nothing used the machine, so no share of machine users
		expect(report({ ...ZERO_ENCOUNTERS, none: 3 })).toMatchObject({
			total: 3,
			machine: 0,
			coldOfMachine: null,
			coldOfTotal: 0
		});
	});

	it('derives the cold shares of the machine users and of every request', () => {
		const counts = { none: 2, warm: 5, restored: 1, bootstrapped: 1, booted: 1 };
		expect(report(counts)).toMatchObject({
			total: 10,
			machine: 8,
			cold: 3,
			coldOfMachine: 0.375,
			coldOfTotal: 0.3,
			restored: 1,
			bootstrapped: 1,
			booted: 1
		});
	});

	it('round-trips through its text form and reads anything odd as zero', () => {
		const counts = { none: 1, warm: 2, restored: 3, bootstrapped: 4, booted: 5 };
		expect(parse(serialise(counts))).toEqual(counts);
		for (const bad of [null, undefined, '', '1,2,3', '1,2,3,4,x', '1,2,3,4,-1', '1,2,3,4,5,6'])
			expect(parse(bad)).toEqual(ZERO_ENCOUNTERS);
	});
});

describe('Encounters', () => {
	function rig(initial: string | null = null) {
		const writes: string[] = [];
		const encounters = new Encounters({
			get: () => initial,
			set: (value) => void writes.push(value)
		});
		return { encounters, writes };
	}

	it('writes nothing for a warm or refused request, and every cold encounter at once', () => {
		const { encounters, writes } = rig();
		encounters.record('warm');
		encounters.record('none');
		expect(writes).toEqual([]);
		encounters.record('restored');
		// the cold write carries the warm and refused counts before it
		expect(writes).toEqual(['1,1,1,0,0']);
		encounters.record('booted');
		expect(writes).toEqual(['1,1,1,0,0', '1,1,1,0,1']);
		expect(encounters.report()).toMatchObject({ total: 4, cold: 2, coldOfMachine: 0.6667 });
	});

	it('writes the in-memory counts at a flush, and only when something was counted since the last write', () => {
		const { encounters, writes } = rig();
		encounters.flush();
		expect(writes).toEqual([]);
		encounters.record('warm');
		encounters.record('warm');
		encounters.flush();
		encounters.flush();
		expect(writes).toEqual(['0,2,0,0,0']);
	});

	it('picks up the counts an earlier instance of the object stored', () => {
		const { encounters } = rig('0,10,2,1,0');
		encounters.record('warm');
		expect(encounters.report()).toMatchObject({
			warm: 11,
			restored: 2,
			bootstrapped: 1,
			cold: 3
		});
	});
});
