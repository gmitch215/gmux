// one socket object, a client evicted mid-run and idle gaps; the connection must be the same one
// throughout and every answer must equal a direct DoH query
const B = process.env.G6_URL ?? 'https://gmux-socket.gmitch215-free.workers.dev';
const gaps = (process.argv[2] ?? '0,30,120,300').split(',').map(Number);
const t = Date.now();
const socket = `sock-${t}`;
const client = `client-${t}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// names whose answers do not rotate between resolvers' replies
const names = ['example.com', 'example.org', 'example.net', 'iana.org', 'example.com', 'example.org'];
const direct = async (name) =>
	((await (await fetch(`https://dns.google/resolve?name=${name}&type=A`, { headers: { accept: 'application/dns-json' } })).json()).Answer ?? [])
		.map((a) => a.data)
		.sort();
console.log('open', await (await fetch(`${B}/open?socket=${socket}&keepalive=${process.env.KEEPALIVE ?? 0}`)).text());
let connection = null;
let ok = true;
const query = async (label, name) => {
	const r = await (await fetch(`${B}/query?client=${client}&socket=${socket}&name=${name}`)).json();
	const want = await direct(name);
	const same = connection === null || r.connection === connection;
	connection ??= r.connection;
	const exact = JSON.stringify(r.answer) === JSON.stringify(want);
	ok &&= same && exact;
	console.log(label.padEnd(18), JSON.stringify({ client: r.client?.slice(0, 8), socketObject: r.instance?.slice(0, 8), sameConnection: same, queries: r.queries, keepalives: r.keepalives, age: r.ageSeconds, exact, error: r.error }));
};
await query('before', names[0]);
await (await fetch(`${B}/evict?client=${client}`)).text().catch(() => '');
await query('after eviction', names[1]);
for (const [i, gap] of gaps.entries()) {
	await sleep(gap * 1000);
	await query(`after ${gap}s idle`, names[(i + 2) % names.length]);
}
console.log(ok ? 'PASS the connection outlived the client and every gap' : 'FAIL');
