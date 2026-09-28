/**
 * The Free account's baseline, which a deployed suite run must leave as it found it: no Worker, no
 * Durable Object namespace, and only the two KV namespaces the account keeps. Reads
 * FREE_CLOUDFLARE_ACCOUNT_ID and FREE_CLOUDFLARE_API_TOKEN, never the paid account's credentials.
 * `bun tests/suites/free.ts` prints the counts and exits 1 when the account is off its baseline
 */
export const KV = ['cfw_free_config', 'cfw-oneclick-config-kv'];

export interface Baseline {
	workers: string[];
	namespaces: string[];
	kv: string[];
}

export function onBaseline(b: Baseline): boolean {
	return (
		!b.workers.length &&
		!b.namespaces.length &&
		[...b.kv].sort().join() === [...KV].sort().join()
	);
}

async function list(path: string): Promise<Record<string, unknown>[]> {
	const account = process.env.FREE_CLOUDFLARE_ACCOUNT_ID;
	const token = process.env.FREE_CLOUDFLARE_API_TOKEN;
	if (!account || !token)
		throw new Error('FREE_CLOUDFLARE_ACCOUNT_ID and FREE_CLOUDFLARE_API_TOKEN');
	const r = await fetch(
		`https://api.cloudflare.com/client/v4/accounts/${account}/${path}?per_page=100`,
		{
			headers: { authorization: `Bearer ${token}` }
		}
	);
	const body = (await r.json()) as {
		success: boolean;
		result: Record<string, unknown>[];
		errors: unknown;
	};
	if (!body.success) throw new Error(`${path}: ${JSON.stringify(body.errors)}`);
	return body.result;
}

export async function baseline(): Promise<Baseline> {
	const [workers, namespaces, kv] = await Promise.all([
		list('workers/scripts'),
		list('workers/durable_objects/namespaces'),
		list('storage/kv/namespaces')
	]);
	return {
		workers: workers.map((w) => String(w.id)),
		namespaces: namespaces.map((n) => String(n.name ?? n.id)),
		kv: kv.map((k) => String(k.title))
	};
}

if (import.meta.main) {
	const b = await baseline();
	console.log(
		`free account: ${b.workers.length} workers [${b.workers.join(', ')}], ${b.namespaces.length} ` +
			`Durable Object namespaces [${b.namespaces.join(', ')}], ${b.kv.length} KV [${b.kv.join(', ')}]`
	);
	process.exit(onBaseline(b) ? 0 : 1);
}
