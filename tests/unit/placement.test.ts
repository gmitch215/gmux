import { describe, expect, it } from 'vitest';
import { MAX_PRIMES, placement, prime, type PlacementStore } from '../../src/worker/placement.ts';

function store(): PlacementStore & { rows: Map<string, string> } {
	const rows = new Map<string, string>();
	return { rows, get: (k) => rows.get(k) ?? null, set: (k, v) => void rows.set(k, v) };
}

describe('placement', () => {
	it('primes on a fresh object and is placed once another instance answers', () => {
		const s = store();
		expect(placement(s, 'a')).toBe('prime');
		expect(placement(s, 'b')).toBe('placed');
		expect(placement(s, 'b')).toBe('placed');
		expect(placement(s, 'c')).toBe('placed');
	});

	it('primes again while the priming instance is still the one answering', () => {
		const s = store();
		expect(placement(s, 'a')).toBe('prime');
		expect(placement(s, 'a')).toBe('prime');
		expect(s.rows.get('placed')).toBeUndefined();
	});

	it('is placed on a host that never replaces the object, after MAX_PRIMES burns', () => {
		const s = store();
		for (let i = 0; i < MAX_PRIMES; i++) expect(placement(s, 'a')).toBe('prime');
		expect(placement(s, 'a')).toBe('placed');
		expect(placement(s, 'a')).toBe('placed');
		expect(s.rows.get('placed')).toBe('1');
	});

	it('counts burns per instance, so a replacement starts from zero', () => {
		const s = store();
		s.rows.set('primed_by', 'a');
		s.rows.set('primes', String(MAX_PRIMES));
		expect(placement(s, 'b')).toBe('placed');
	});

	it('burns the requested iterations', () => {
		expect(prime(3)).toBe(prime(3));
		expect(prime(0)).toBe(1);
	});
});
