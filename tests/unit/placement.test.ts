import { describe, expect, it } from 'vitest';
import { placement, prime, type PlacementStore } from '../../src/worker/placement.ts';

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

	it('burns the requested iterations', () => {
		expect(prime(3)).toBe(prime(3));
		expect(prime(0)).toBe(1);
	});
});
