import { execSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';

/**
 * The deployed site's staged start, against a fresh deployment (nothing stored).
 * - `start`: claims, connects, and times the first prompt; the status says whether the machine
 *   came from the shipped bootstrap image ("started") or booted.
 * - `survive`: then types an init that burns about N shell iterations of CPU (well past the ~1 s a
 *   new object gets, and past many events), and when it has checkpointed at least once, runs
 *   REDEPLOY (a `wrangler deploy` of the same site), which replaces the object mid-init; the init
 *   must end with its exact count after a restore.
 * - `port`: for an image taken after such an init (scripts/bootstrap.ts --run ... --until READY),
 *   types a line to the shell parked in `read` and times the answer.
 * `node --experimental-strip-types drive.ts <start|survive|port> <base url>` (N=3000000,
 * REDEPLOY="<command>")
 */
const [mode, baseArg] = process.argv.slice(2);
const base = (baseArg ?? 'http://localhost:8787').replace(/\/$/, '');
const N = Number(process.env.N ?? 3_000_000);
const log = (event: string, data: object = {}) =>
	console.log(JSON.stringify({ at: new Date().toISOString(), event, ...data }));

async function retrying(path: string, init?: RequestInit) {
	for (let i = 0; ; i++) {
		const response = await fetch(`${base}${path}`, init);
		if (response.status !== 503 || i > 12) return response;
		await new Promise((r) => setTimeout(r, 1500));
	}
}

function socket(kind: 'control' | 'warm', owner: string): Promise<WebSocket> {
	const url = `${base.replace(/^http/, 'ws')}/_gmux/term/ws?kind=${kind}&token=${encodeURIComponent(owner)}`;
	const ws = new WebSocket(url);
	return new Promise((resolve, reject) => {
		ws.addEventListener('open', () => resolve(ws), { once: true });
		ws.addEventListener('error', () => reject(new Error(`${kind} socket failed`)), { once: true });
	});
}

let output = '';
const statuses: string[] = [];
const drops: string[] = [];
async function attach(owner: string) {
	let closing = false;
	let control = await socket('control', owner);
	let warm = await socket('warm', owner);
	// a replaced object drops its sockets; the terminal page reconnects, and so does this
	const watch = (kind: 'control' | 'warm', ws: WebSocket) =>
		ws.addEventListener('close', async () => {
			if (closing) return;
			drops.push(`${kind} ${new Date().toISOString()}`);
			for (;;) {
				await new Promise((r) => setTimeout(r, 1000));
				try {
					const again = await socket(kind, owner);
					if (kind === 'control') {
						control = again;
						listen(again);
					} else warm = again;
					watch(kind, again);
					return;
				} catch {
					// the new version is still placing
				}
			}
		});
	const listen = (ws: WebSocket) =>
		ws.addEventListener('message', (event) => {
			const msg = JSON.parse(String(event.data)) as { t: string; d: string };
			if (msg.t === 'out') output += msg.d.replaceAll('\r', '');
			if (msg.t === 'status') statuses.push(msg.d);
		});
	listen(control);
	watch('control', control);
	watch('warm', warm);
	// the warm socket holds the object resident; ticks go on the control socket, as the page's do
	const tick = JSON.stringify({ t: 'tick' });
	const ticker = setInterval(
		() => warm.readyState === 1 && control.readyState === 1 && control.send(tick),
		1000
	);
	const type = async (text: string) => {
		while (control.readyState !== 1) await new Promise((r) => setTimeout(r, 200));
		control.send(JSON.stringify({ t: 'in', d: text }));
	};
	const until = async (test: () => boolean, what: string, ms = 600_000) => {
		const started = Date.now();
		while (!test()) {
			if (Date.now() - started > ms) {
				if (process.env.OUTFILE) writeFileSync(process.env.OUTFILE, output);
				throw new Error(`no ${what} after ${ms} ms:\n${output.slice(-1500)}`);
			}
			await new Promise((r) => setTimeout(r, 200));
		}
		return Date.now() - started;
	};
	const close = () => {
		closing = true;
		clearInterval(ticker);
		control.close();
		warm.close();
	};
	return { type, until, close };
}
// a reset object answers its request with an error page; the next request reaches its successor
const status = async (): Promise<any> => {
	for (let i = 0; ; i++) {
		const r = await retrying('/_gmux/status');
		const text = await r.text();
		try {
			return JSON.parse(text);
		} catch {
			resets.push(`${new Date().toISOString()} ${r.status}`);
			if (i > 20) throw new Error(`status: ${r.status} ${text.slice(0, 200)}`);
			await new Promise((ok) => setTimeout(ok, 2000));
		}
	}
};
const resets: string[] = [];

const claimed = await retrying('/_gmux/claim', { method: 'POST' });
const { token } = (await claimed.json()) as { token: string };
if (!token) throw new Error(`claim: ${claimed.status}`);
const attached = Date.now();
const t = await attach(token);
let pass = true;
if (mode === 'port') {
	// the image's shell is parked in `read`; the first line typed is the port's input
	await t.type('hello\n');
	const ms = await t.until(() => output.includes('got hello'), 'the parked port', 120_000);
	log('port', { ms, since: Date.now() - attached, statuses, durable: (await status()).durable });
	t.close();
	console.log('PASS port');
	process.exit(0);
}
await t.type('\n');
const promptMs = await t.until(() => /# $/.test(output), 'prompt', 120_000);
const first = await status();
log('prompt', { ms: promptMs, since: Date.now() - attached, statuses, durable: first.durable });
if (mode === 'survive') {
	// the loop's own count is the check: a restore resumes it where its last checkpoint left it
	const from = output.length;
	await t.type(
		`i=0; while [ $i -lt ${N} ]; do i=$((i+1)); [ $((i % 250000)) = 0 ] && echo P$i; done; echo READY $((i+0))\n`
	);
	await t.until(() => /P\d+/.test(output.slice(from)), 'progress');
	let now = await status();
	while (!(now.durable?.checkpoints > 0)) {
		await new Promise((r) => setTimeout(r, 2000));
		now = await status();
	}
	const progress = [...output.slice(from).matchAll(/P(\d+)/g)].at(-1)?.[1];
	log('redeploy', { progress, durable: now.durable });
	execSync(process.env.REDEPLOY ?? 'false', { stdio: 'inherit' });
	const readyMs = await t.until(() => /READY \d+/.test(output.slice(from)), 'READY');
	const ready = Number(/READY (\d+)/.exec(output.slice(from))![1]);
	const after = await status();
	log('ready', { ready, readyMs, drops, resets, statuses, durable: after.durable });
	pass = ready === N && (after.durable?.restores ?? 0) > 0 && drops.length > 0;
}
t.close();
console.log(pass ? `PASS ${mode}` : `FAIL ${mode}`);
process.exit(pass ? 0 : 1);
