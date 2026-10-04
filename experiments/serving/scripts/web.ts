import { createHash } from 'node:crypto';

/**
 * Boots the site's machine through the terminal WebSocket (as scripts/smoke.ts does), starts httpd
 * on /www and sends the six requests through the Worker: one JSON line each (status, headers a hop
 * would pass, bytes, body sha256, ms), in the shape experiments/serving/scripts/native.sh prints for curl.
 * WORKER_URL=<base url> node --experimental-strip-types experiments/serving/scripts/web.ts
 */
const base = (process.env.WORKER_URL ?? '').replace(/\/$/, '');
if (!base) {
	console.error('usage: WORKER_URL=<base url> node --experimental-strip-types web.ts');
	process.exit(2);
}
const timeoutMs = Number(process.env.TIMEOUT_MS ?? 180_000);
const hop = /^(date|connection|keep-alive|transfer-encoding|last-modified|etag)$/;

/** a request that may meet the placement 503 of a new object: retried once */
async function get(
	path: string,
	init: RequestInit = {},
	retries = Number(process.env.RETRIES ?? 4)
): Promise<Response> {
	const response = await fetch(`${base}${path}`, {
		...init,
		// the edge compresses text for a client that accepts it; curl in native.sh does not ask
		headers: { 'accept-encoding': 'identity', ...(init.headers as object) }
	});
	if (response.status === 503 && retries > 0) {
		await response.arrayBuffer();
		await new Promise((r) => setTimeout(r, 1500));
		return get(path, init, retries - 1);
	}
	return response;
}

let owner = process.env.GMUX_TOKEN;
if (!owner) {
	const claim = await get('/_gmux/claim', { method: 'POST' });
	owner = ((await claim.json()) as { token?: string }).token;
	if (!owner) throw new Error(`claim: ${claim.status}`);
	console.error(`GMUX_TOKEN=${owner}`);
}
function socket(kind: 'control' | 'warm'): Promise<WebSocket> {
	const ws = new WebSocket(
		`${base.replace(/^http/, 'ws')}/_gmux/term/ws?kind=${kind}&token=${encodeURIComponent(owner!)}`
	);
	return new Promise((resolve, reject) => {
		ws.addEventListener('open', () => resolve(ws), { once: true });
		ws.addEventListener('error', () => reject(new Error(`${kind} socket failed`)), {
			once: true
		});
	});
}
const control = await socket('control');
const warm = await socket('warm');
const ticker = setInterval(
	() => warm.readyState === 1 && control.send(JSON.stringify({ t: 'tick' })),
	1000
);
let output = '';
control.addEventListener('message', (event) => {
	const msg = JSON.parse(String(event.data)) as { t: string; d: string };
	if (msg.t === 'out') output += msg.d;
});
const type = (text: string) => control.send(JSON.stringify({ t: 'in', d: text }));
async function until(text: string, from = 0) {
	const started = Date.now();
	while (!output.includes(text, from)) {
		if (Date.now() - started > timeoutMs)
			throw new Error(`no "${text}":\n${output.slice(-1500)}`);
		await new Promise((r) => setTimeout(r, 100));
	}
}
async function sh(command: string) {
	const from = output.length;
	type(`${command}; echo rc=$?-end\n`);
	await until('-end', from + command.length);
	return output.slice(from);
}

type('\n');
await until('# ');
await sh('mkdir -p /www/cgi-bin');
await sh('seq 1 400 | head -c 1024 > /www/1k.txt; seq 1 1000000 > /www/big.txt');
await sh(
	`printf '#!/bin/sh\\necho "Content-Type: text/plain"\\necho\\necho hello\\n' > /www/cgi-bin/hello.cgi; ` +
		`printf '#!/bin/sh\\necho "Content-Type: text/plain"\\necho\\nseq 1 3000000\\n' > /www/cgi-bin/stream.cgi; ` +
		'chmod +x /www/cgi-bin/*.cgi'
);
await sh('httpd -p 80 -h /www');
await sh('sleep 1');

const requests: [string, string, RequestInit][] = [
	['1k', '/1k.txt', {}],
	['404', '/nope', {}],
	['head', '/1k.txt', { method: 'HEAD' }],
	['range', '/1k.txt', { headers: { range: 'bytes=100-199' } }],
	['big', '/big.txt', {}],
	['cgi', '/cgi-bin/stream.cgi', {}]
];
const only = process.env.ONLY?.split(',');
for (const [name, path, init] of requests) {
	if (only && !only.includes(name)) continue;
	const started = Date.now();
	const response = await get(path, init);
	const hash = createHash('sha256');
	let bytes = 0;
	for await (const chunk of response.body ?? []) {
		hash.update(chunk);
		bytes += chunk.length;
	}
	const headers = [...response.headers]
		.filter(([n]) => !hop.test(n))
		.map(([n, v]) => `${n}: ${v}`)
		.sort();
	console.log(
		JSON.stringify({
			web: name,
			status: response.status,
			headers,
			bytes,
			sha256: hash.digest('hex'),
			ms: Date.now() - started
		})
	);
}
const status = await (await get('/_gmux/status')).json();
console.log(JSON.stringify({ status: { stats: (status as any).stats, durable: (status as any).durable } }));
clearInterval(ticker);
control.close();
warm.close();
process.exit(0);
