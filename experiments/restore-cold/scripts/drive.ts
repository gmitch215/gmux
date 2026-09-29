import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';

/**
 * a cold restore against a warm one on the deployed rig. Each generation redeploys the worker (a
 * new version starts in a fresh isolate), pings it (the isolate starts and compiles its modules),
 * then runs the restore RUNS times: the first is cold, the rest warm. The workers' own clock stands
 * still while code runs, so each restore is read from `wrangler tail` (cpuTime, wallTime) by its seq.
 * `node --experimental-strip-types drive.ts <out.jsonl> [generations] [runs] [warm: a|b|c]` with CLOUDFLARE_ACCOUNT_ID and
 * CLOUDFLARE_API_TOKEN set, run from experiments/restore-cold; set WORKER_NAME and WORKER_URL to the deployed worker
 */
const [out = 'restore-cold.jsonl', gens = '10', runs = '4', warm = 'a'] = process.argv.slice(2);
const name = process.env.WORKER_NAME;
if (!name) throw new Error('set WORKER_NAME to the worker to deploy and tail');
const base = process.env.WORKER_URL;
if (!base) throw new Error('set WORKER_URL to the deployed worker, e.g. https://<name>.<subdomain>.workers.dev');
const wrangler = '../../node_modules/.bin/wrangler';

interface Tail {
	seq: string;
	cpuTime: number;
	wallTime: number;
	version: string;
}
const tails = new Map<string, Tail>();
const tail = spawn(wrangler, ['tail', name, '--format', 'json'], { stdio: ['ignore', 'pipe', 'inherit'] });
let buffer = '';
let depth = 0;
tail.stdout.on('data', (chunk: Buffer) => {
	for (const ch of chunk.toString()) {
		buffer += ch;
		if (ch === '{') depth++;
		if (ch === '}' && --depth === 0) {
			try {
				const e = JSON.parse(buffer.slice(buffer.indexOf('{')));
				const url = new URL(e.event?.request?.url ?? 'http://x/');
				const seq = url.searchParams.get('seq');
				if (seq) tails.set(seq, { seq, cpuTime: e.cpuTime, wallTime: e.wallTime, version: e.scriptVersion?.id });
			} catch {
				// a partial event
			}
			buffer = '';
		}
	}
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const get = async (path: string) => {
	const t = performance.now();
	const res = await fetch(`${base}${path}`, { signal: AbortSignal.timeout(90_000) });
	return { status: res.status, wall: performance.now() - t, body: res.status === 200 ? await res.json() : null };
};
const deploy = (gen: number) =>
	new Promise<void>((resolve, reject) => {
		const p = spawn(wrangler, ['deploy', '--name', name, '--var', `GEN:${gen}`, '--var', `WARM:${warm}`], { stdio: ['ignore', 'ignore', 'inherit'] });
		p.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`deploy ${gen}: ${code}`))));
	});

await sleep(6000);
const rows: Record<string, unknown>[] = [];
const seen = new Set<string>();
for (let g = 1; g <= Number(gens); g++) {
	await deploy(g);
	let ping;
	await sleep(40_000);
	for (let i = 0; i < 12; i++) {
		try {
			ping = await get(`/ping?seq=${g}-p`);
			if (ping.status === 200 && ping.body.served === 0 && !seen.has(ping.body.isolate)) break;
		} catch {
			// not up yet
		}
		await sleep(20_000);
	}
	if (!ping?.body || ping.body.served !== 0 || seen.has(ping.body.isolate)) {
		console.log(JSON.stringify({ gen: g, error: 'no fresh isolate', ping }));
		continue;
	}
	seen.add(ping.body.isolate);
	rows.push({ gen: g, warmArm: warm, seq: `${g}-p`, kind: 'ping', warmMs: ping.body.warmMs, isolate: ping.body.isolate, clientWall: ping.wall });
	for (let k = 1; k <= Number(runs); k++) {
		const r = await get(`/run?seq=${g}-${k}`);
		const row = { gen: g, warmArm: warm, seq: `${g}-${k}`, kind: k === 1 ? 'cold' : 'warm', status: r.status, clientWall: r.wall, ...r.body };
		rows.push(row);
		console.log(JSON.stringify(row));
	}
}
await sleep(15000);
tail.kill();
const joined = rows.map((r) => ({ ...r, ...(tails.get(String(r.seq)) ?? {}) }));
writeFileSync(out, joined.map((r) => JSON.stringify(r)).join('\n') + '\n');
console.log(`rows ${joined.length}, tail events matched ${joined.filter((r) => 'cpuTime' in r).length}`);
process.exit(0);
