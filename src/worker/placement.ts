/**
 * First placement: Cloudflare replaces a new Durable Object once, after the event in which its CPU
 * across events passes ~1 s, losing its memory and sockets. A machine spends that on nothing: the
 * object's first request burns past the threshold before any machine exists and answers "placing",
 * and the replacement instance, seeing another instance did the burning, marks the object placed.
 */
export interface PlacementStore {
	get(key: string): string | null;
	set(key: string, value: string): void;
}

/** ~1.5 s of CPU on the Free plan (5.3 ns per iteration), past the ~1 s threshold with room */
export const PRIME_ITERATIONS = 2.8e8;

/**
 * burns one instance survives before the host is taken to never replace objects (self-hosted
 * workerd); Cloudflare replaces after the first event past ~1 s, so three (~4.5 s) is far past it
 */
export const MAX_PRIMES = 3;

/** `placed` once a replacement instance has seen the object; `prime` for the instance to burn in */
export function placement(store: PlacementStore, instance: string): 'placed' | 'prime' {
	if (store.get('placed')) return 'placed';
	const by = store.get('primed_by');
	const primes = by === instance ? Number(store.get('primes') ?? 0) : 0;
	if ((by && by !== instance) || primes >= MAX_PRIMES) {
		store.set('placed', '1');
		return 'placed';
	}
	store.set('primed_by', instance);
	store.set('primes', String(primes + 1));
	return 'prime';
}

/** spends CPU; the result keeps the loop from being optimized away */
export function prime(iterations = PRIME_ITERATIONS): number {
	let x = 1;
	for (let i = 0; i < iterations; i++) x = (x * 1103515245 + 12345) | 0;
	return x;
}
