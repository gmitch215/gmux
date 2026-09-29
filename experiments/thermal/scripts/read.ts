/**
 * Reads the idle day: the Durable Object meters (requests, rows, duration, CPU) of the deployed
 * worker's object namespace per 15 minutes since SINCE, and the object's status. The account is the
 * one the two variables name; only the namespaces of the worker SCRIPT (default gmux-thermal) count.
 * `CLOUDFLARE_ACCOUNT_ID=... CLOUDFLARE_API_TOKEN=... WORKER_URL=<url of the deployed worker> \
 *   SINCE=2026-09-29T08:19:00Z node --experimental-strip-types experiments/thermal/scripts/read.ts`
 * The status is one request to the object; NO_STATUS=1 skips it.
 */
if (!process.env.WORKER_URL && !process.env.NO_STATUS) {
	console.error(
		'usage: WORKER_URL=<url of the deployed worker> (or NO_STATUS=1) node --experimental-strip-types read.ts'
	);
	process.exit(2);
}
const base = (process.env.WORKER_URL ?? '').replace(/\/$/, '');
const script = process.env.SCRIPT ?? 'gmux-thermal';
const since = process.env.SINCE ?? new Date(Date.now() - 3_600_000).toISOString();
const account = process.env.CLOUDFLARE_ACCOUNT_ID;
const token = process.env.CLOUDFLARE_API_TOKEN;
if (!account || !token) throw new Error('CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN');

async function graphql(query: string) {
	const response = await fetch('https://api.cloudflare.com/client/v4/graphql', {
		method: 'POST',
		headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
		body: JSON.stringify({ query, variables: {} })
	});
	const body = (await response.json()) as { data: any; errors?: unknown };
	if (body.errors) throw new Error(JSON.stringify(body.errors));
	return body.data.viewer.accounts[0];
}

const namespaces = (await (
	await fetch(
		`https://api.cloudflare.com/client/v4/accounts/${account}/workers/durable_objects/namespaces`,
		{ headers: { authorization: `Bearer ${token}` } }
	)
).json()) as { result: { id: string; script: string }[] };
const ids = namespaces.result.filter((n) => n.script === script).map((n) => n.id);
if (!ids.length) throw new Error(`no object namespace for the script ${script}`);

const until = new Date().toISOString();
const window = `datetime_geq: "${since}", datetime_leq: "${until}"`;
const periodic = await graphql(`{ viewer { accounts(filter: { accountTag: "${account}" }) {
	durableObjectsPeriodicGroups(limit: 1000, filter: { ${window}, namespaceId_in: ${JSON.stringify(ids)} }, orderBy: [datetimeFifteenMinutes_ASC]) {
		dimensions { datetimeFifteenMinutes }
		sum { rowsWritten rowsRead duration cpuTime activeTime storageWriteUnits storageReadUnits }
	} } } }`);
const invocations = await graphql(`{ viewer { accounts(filter: { accountTag: "${account}" }) {
	durableObjectsInvocationsAdaptiveGroups(limit: 1000, filter: { ${window}, scriptName: "${script}" }, orderBy: [datetimeFifteenMinutes_ASC]) {
		dimensions { datetimeFifteenMinutes }
		sum { requests wallTime errors }
	} } } }`);

const rows = new Map<string, Record<string, number>>();
const at = (key: string) => rows.get(key) ?? rows.set(key, {}).get(key)!;
for (const g of periodic.durableObjectsPeriodicGroups)
	Object.assign(at(g.dimensions.datetimeFifteenMinutes), g.sum);
for (const g of invocations.durableObjectsInvocationsAdaptiveGroups)
	Object.assign(at(g.dimensions.datetimeFifteenMinutes), g.sum);

const total: Record<string, number> = {};
for (const [key, sum] of [...rows].sort()) {
	console.log(key, JSON.stringify(sum));
	for (const [name, value] of Object.entries(sum)) total[name] = (total[name] ?? 0) + value;
}
console.log('total', JSON.stringify(total));
console.log('window', since, until);
if (base) console.log('status', JSON.stringify(await (await fetch(`${base}/_gmux/status`)).json()));
