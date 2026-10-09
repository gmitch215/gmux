import { request } from 'node:http';
import { MAX_OPEN_STREAMS, MAX_REQUEST_BYTES } from '../../../src/worker/site-machine.ts';
import { connect, get } from './guest.ts';

/**
 * Checks the site's two limits through a running worker: MAX_OPEN_STREAMS stalled readers of the big
 * file fill the cap, the next request answers 503 with retry-after 1 and the control plane still
 * answers; cancelling a reader frees a slot; a declared body over MAX_REQUEST_BYTES and a chunked
 * one that passes it answer 413, and bodies of exactly the bound go through. One JSON line per check.
 * WORKER_URL=<base url> node --experimental-strip-types experiments/serving/scripts/limits.ts
 */
const base = (process.env.WORKER_URL ?? '').replace(/\/$/, '');
if (!base) {
	console.error('usage: WORKER_URL=<base url> node --experimental-strip-types limits.ts');
	process.exit(2);
}
const guest = await connect(base);
await guest.sh('mkdir -p /www/cgi-bin');
await guest.sh('seq 1 400 | head -c 1024 > /www/1k.txt; seq 1 1000000 > /www/big.txt');
await guest.sh(
	`printf '#!/bin/sh\\necho "Content-Type: text/plain"\\necho\\necho got $(wc -c)\\n' > /www/cgi-bin/sink.cgi; chmod +x /www/cgi-bin/sink.cgi`
);
await guest.sh('httpd -p 80 -h /www; sleep 1');
const say = (check: string, result: object) => console.log(JSON.stringify({ check, ...result }));
const accept = { 'accept-encoding': 'identity' };

// #region streams
const held: Response[] = [];
for (let i = 0; i < MAX_OPEN_STREAMS; i++)
	held.push(await get(base, '/big.txt', { headers: accept }));
say('cap filled', { cap: MAX_OPEN_STREAMS, statuses: held.map((r) => r.status) });
const over = await fetch(`${base}/big.txt`, { headers: accept });
say('over the cap', { status: over.status, retryAfter: over.headers.get('retry-after') });
await over.arrayBuffer();
const status = await fetch(`${base}/_gmux/status`);
say('control plane at the cap', { status: status.status });
await held[0]!.body!.cancel();
const freed = Date.now();
let after = 0;
while (Date.now() - freed < 20_000) {
	const res = await fetch(`${base}/1k.txt`, { headers: accept });
	await res.arrayBuffer();
	after = res.status;
	if (after === 200) break;
	await new Promise((r) => setTimeout(r, 250));
}
say('slot freed by a client cancel', { status: after, ms: Date.now() - freed });
for (const res of held.slice(1)) await res.body!.cancel();
await new Promise((r) => setTimeout(r, 1500));
const again = await Promise.all(
	Array.from({ length: MAX_OPEN_STREAMS }, async () => {
		const res = await fetch(`${base}/1k.txt`, { headers: accept });
		await res.arrayBuffer();
		return res.status;
	})
);
say('every slot free after all cancelled', { statuses: again });
// #endregion

// #region body
/** a POST of `bytes` to the sink CGI, declared (content-length) or chunked; the status and what the CGI counted */
function post(bytes: number, declared: boolean, sent = bytes) {
	return new Promise<{ status?: number; text: string; error?: string }>((resolve) => {
		const url = new URL(`${base}/cgi-bin/sink.cgi`);
		const req = request(
			url,
			{
				method: 'POST',
				headers: declared ? { 'content-length': bytes } : { 'transfer-encoding': 'chunked' }
			},
			(res) => {
				let text = '';
				res.on('data', (d) => (text += d));
				res.on('end', () => resolve({ status: res.statusCode, text: text.trim() }));
			}
		);
		req.on('error', (error) => resolve({ text: '', error: String(error) }));
		const chunk = Buffer.alloc(65_536, 'x');
		let left = sent;
		const write = () => {
			while (left > 0) {
				const n = Math.min(left, chunk.length);
				left -= n;
				if (!req.write(chunk.subarray(0, n))) return void req.once('drain', write);
			}
			if (declared && sent < bytes) return;
			req.end();
		};
		write();
	});
}
// a declared length over the bound is refused on the head alone, so only a little of it is sent
say('declared over the bound', { ...(await post(MAX_REQUEST_BYTES + 1, true, 1024)), bound: MAX_REQUEST_BYTES });
say('declared at the bound', { ...(await post(MAX_REQUEST_BYTES, true)), bound: MAX_REQUEST_BYTES });
// httpd ignores a chunked body, so a listener that takes whatever arrives answers for the chunked checks
await guest.sh(
	'kill $(pidof httpd); n=0; while :; do sleep 3000 | nc -l -p 80 | wc -c > /tmp/chunked.$n; n=$((n+1)); done > /dev/null 2>&1 &'
);
await guest.sh('sleep 1');
const taken = async (n: number) =>
	Number(/size=(\d+)/.exec(await guest.sh(`echo size=$(wc -c < /tmp/chunked.${n})`))?.[1]);
const started = Date.now();
const past = await post(MAX_REQUEST_BYTES + 65_536, false);
say('chunked past the bound', {
	...past,
	bound: MAX_REQUEST_BYTES,
	ms: Date.now() - started,
	guestBytes: await taken(0)
});
// #endregion

guest.close();
process.exit(0);
