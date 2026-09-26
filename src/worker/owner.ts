/** where the owner token's hash lives; the machine's Durable Object backs it with SQLite */
export interface OwnerStore {
	get(): string | null;
	set(hash: string): void;
}

async function sha256(text: string): Promise<string> {
	const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
	return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** returns a new owner token the first time, and null once the machine has an owner */
export async function claim(store: OwnerStore): Promise<string | null> {
	if (store.get()) return null;
	const bytes = crypto.getRandomValues(new Uint8Array(32));
	const token = btoa(String.fromCharCode(...bytes))
		.replace(/\+/g, '-')
		.replace(/\//g, '_')
		.replace(/=+$/, '');
	store.set(await sha256(token));
	return token;
}

export async function verify(store: OwnerStore, token: string | null): Promise<boolean> {
	const stored = store.get();
	if (!stored || !token) return false;
	const given = await sha256(token);
	let diff = 0;
	for (let i = 0; i < stored.length; i++) diff |= stored.charCodeAt(i) ^ given.charCodeAt(i);
	return diff === 0 && given.length === stored.length;
}
