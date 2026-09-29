import { exact, JOBS, READ, readback, start, type Job } from './jobs.ts';

/**
 * One idle-machine arm on a deployed site: claims the machine, gets a prompt, starts JOB in the
 * guest, leaves, does nothing for MINUTES (no request reaches the worker; its alarms are the only
 * activity, read afterwards from `wrangler tail`), then reads the status and attaches to read the job's
 * progress. Prints one JSON line with the times.
 * `WORKER_URL=<url> JOB=silent MINUTES=15 node --no-warnings --experimental-strip-types experiments/decisions/scripts/deployed.ts`
 */
if (!process.env.WORKER_URL) {
	console.error('usage: WORKER_URL=<url of the deployed worker> [JOB=none|silent|gzip|cpu] [MINUTES=15] deployed.ts');
	process.exit(2);
}
const base = process.env.WORKER_URL.replace(/\/$/, '');
const job = (process.env.JOB ?? 'silent') as Job;
if (!JOBS.includes(job)) throw new Error(`JOB ${job}`);
const MINUTES = Number(process.env.MINUTES ?? 15);
const iso = () => new Date().toISOString();

const FETCH_MS = 60_000;

async function retrying(path: string, init?: RequestInit) {
	for (let i = 0; ; i++) {
		const response = await fetch(`${base}${path}`, {
			...init,
			signal: AbortSignal.timeout(FETCH_MS)
		}).catch((error: Error) => {
			throw new Error(
				error.name === 'TimeoutError'
					? `${path}: no response in ${FETCH_MS} ms`
					: `${path}: ${error.message}`
			);
		});
		if (response.status !== 503 || i > 8) return response;
		await new Promise((r) => setTimeout(r, 1500));
	}
}

function socket(kind: 'control' | 'warm', token: string): Promise<WebSocket> {
	const ws = new WebSocket(
		`${base.replace(/^http/, 'ws')}/_gmux/term/ws?kind=${kind}&token=${encodeURIComponent(token)}`
	);
	return new Promise((resolve, reject) => {
		setTimeout(() => reject(new Error(`${kind} socket: no open in ${FETCH_MS} ms`)), FETCH_MS).unref();
		ws.addEventListener('open', () => resolve(ws), { once: true });
		ws.addEventListener('error', () => reject(new Error(`${kind} socket failed`)), { once: true });
	});
}

async function session(token: string, body: (type: (text: string) => void, until: (text: RegExp, ms?: number) => Promise<void>, out: () => string) => Promise<void>) {
	let output = '';
	const control = await socket('control', token);
	const warm = await socket('warm', token);
	control.addEventListener('message', (event) => {
		const msg = JSON.parse(String(event.data)) as { t: string; d: string };
		if (msg.t === 'out') output += msg.d.replaceAll('\r', '');
	});
	const ticker = setInterval(() => control.send(JSON.stringify({ t: 'tick' })), 1000);
	const until = async (text: RegExp, ms = 180_000) => {
		const started = Date.now();
		while (!text.test(output)) {
			if (Date.now() - started > ms) throw new Error(`no ${text} after ${ms} ms:\n${output.slice(-800)}`);
			await new Promise((r) => setTimeout(r, 200));
		}
	};
	try {
		await body((text) => control.send(JSON.stringify({ t: 'in', d: text })), until, () => output);
	} finally {
		clearInterval(ticker);
		control.close();
		warm.close();
	}
}

const claimed = await retrying('/_gmux/claim', { method: 'POST' });
const { token } = (await claimed.json()) as { token: string };
if (!token) throw new Error(`claim: ${claimed.status}`);
const out: Record<string, unknown> = { worker: base, job, minutes: MINUTES, claimedAt: iso() };
await session(token, async (type, until) => {
	type('\n');
	await until(/# $/);
	const command = start(job);
	if (command) {
		type(`${command}\n`);
		await until(/\[1\] \d+/);
	}
	// a few quanta so the job has started and a checkpoint can come due
	await new Promise((r) => setTimeout(r, 8000));
});
out.leftAt = iso();
await new Promise((r) => setTimeout(r, MINUTES * 60_000));
out.readAt = iso();
out.status = await (await retrying('/_gmux/status')).json();
if (job !== 'none')
	await session(token, async (type, until, output) => {
		type('\n');
		await until(/# $/);
		type(READ);
		await until(/R:[^$\r\n]*:[^$\r\n]*:\d+/);
		const got = readback(output());
		out.guest = got;
		out.exact = got ? exact(job, got[0]) : 'unread';
	});
out.doneAt = iso();
console.log(JSON.stringify(out));
