/**
 * What a Cloudflare account holds (Workers, Durable Object namespaces, KV), so a deployed suite run
 * can leave the account as it found it. The account and token come from CLOUDFLARE_ACCOUNT_ID and
 * CLOUDFLARE_API_TOKEN, as wrangler reads them; nothing is assumed about which account.
 * `bun tests/suites/account.ts` prints the counts, `save <file>` records them and
 * `check <file>` exits 1 when the account differs from a saved record
 */
export interface Holdings {
	workers: string[];
	namespaces: string[];
	kv: string[];
}

export function same(a: Holdings, b: Holdings): boolean {
	const key = (h: Holdings) =>
		JSON.stringify([h.workers, h.namespaces, h.kv].map((xs) => [...xs].sort()));
	return key(a) === key(b);
}

async function list(path: string): Promise<Record<string, unknown>[]> {
	const account = process.env.CLOUDFLARE_ACCOUNT_ID;
	const token = process.env.CLOUDFLARE_API_TOKEN;
	if (!account || !token) throw new Error('CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN');
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

export async function holdings(): Promise<Holdings> {
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
	const { readFileSync, writeFileSync } = await import('node:fs');
	const [mode, file] = process.argv.slice(2);
	const now = await holdings();
	console.log(
		`account: ${now.workers.length} workers [${now.workers.join(', ')}], ${now.namespaces.length} ` +
			`Durable Object namespaces [${now.namespaces.join(', ')}], ${now.kv.length} KV [${now.kv.join(', ')}]`
	);
	if (mode === 'save' && file) writeFileSync(file, JSON.stringify(now));
	if (mode === 'check' && file) {
		const before = JSON.parse(readFileSync(file, 'utf8')) as Holdings;
		if (!same(before, now)) {
			console.error(`account differs from ${file}: ${JSON.stringify(before)}`);
			process.exit(1);
		}
	}
}
