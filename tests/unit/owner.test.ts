import { describe, expect, it } from 'vitest';
import { claim, type OwnerStore, verify } from '../../src/worker/owner.ts';

function memoryStore(): OwnerStore & { hash: string | null } {
	return {
		hash: null,
		get() {
			return this.hash;
		},
		set(hash) {
			this.hash = hash;
		}
	};
}

describe('owner token', () => {
	it('is claimed once and verifies', async () => {
		const store = memoryStore();
		const token = await claim(store);
		expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
		expect(await claim(store)).toBeNull();
		expect(await verify(store, token)).toBe(true);
	});

	it('stores a hash, never the token', async () => {
		const store = memoryStore();
		const token = await claim(store);
		expect(store.hash).toMatch(/^[0-9a-f]{64}$/);
		expect(store.hash).not.toContain(token!);
	});

	it('refuses a wrong, missing or unclaimed token', async () => {
		const store = memoryStore();
		expect(await verify(store, 'anything')).toBe(false);
		await claim(store);
		expect(await verify(store, 'wrong')).toBe(false);
		expect(await verify(store, null)).toBe(false);
	});
});
