/**
 * Starts the idle day: claims the machine, gets a prompt, runs one command, leaves, and prints the
 * status. The machine then has no socket, so only the keeper's alarms and the thermal rule act.
 * `WORKER_URL=<url of the deployed worker> [COMMAND=<shell command to start>] node --experimental-strip-types experiments/thermal/scripts/start.ts`
 */
if (!process.env.WORKER_URL) {
	console.error('usage: WORKER_URL=<url of the deployed worker> node --experimental-strip-types start.ts');
	process.exit(2);
}
const base = process.env.WORKER_URL.replace(/\/$/, '');
const log = (event: string, data: object = {}) =>
	console.log(JSON.stringify({ at: new Date().toISOString(), event, ...data }));

async function retrying(path: string, init?: RequestInit) {
	for (let i = 0; ; i++) {
		const response = await fetch(`${base}${path}`, init);
		if (response.status !== 503 || i > 8) return response;
		await new Promise((r) => setTimeout(r, 1500));
	}
}

function socket(kind: 'control' | 'warm', token: string): Promise<WebSocket> {
	const ws = new WebSocket(
		`${base.replace(/^http/, 'ws')}/_gmux/term/ws?kind=${kind}&token=${encodeURIComponent(token)}`
	);
	return new Promise((resolve, reject) => {
		ws.addEventListener('open', () => resolve(ws), { once: true });
		ws.addEventListener('error', () => reject(new Error(`${kind} socket failed`)), { once: true });
	});
}

const claimed = await retrying('/_gmux/claim', { method: 'POST' });
const { token } = (await claimed.json()) as { token: string };
if (!token) throw new Error(`claim: ${claimed.status}`);
log('claimed', { token });

let output = '';
const control = await socket('control', token);
const warm = await socket('warm', token);
control.addEventListener('message', (event) => {
	const msg = JSON.parse(String(event.data)) as { t: string; d: string };
	if (msg.t === 'out') output += msg.d.replaceAll('\r', '');
});
const ticker = setInterval(() => control.send(JSON.stringify({ t: 'tick' })), 1000);
const until = async (text: string, ms = 180_000) => {
	const started = Date.now();
	while (!output.includes(text)) {
		if (Date.now() - started > ms) throw new Error(`no "${text}" after ${ms} ms:\n${output.slice(-800)}`);
		await new Promise((r) => setTimeout(r, 200));
	}
};

const started = Date.now();
control.send(JSON.stringify({ t: 'in', d: '\n' }));
await until('# ');
log('prompt', { ms: Date.now() - started });
const command = process.env.COMMAND ?? 'echo idle-day';
control.send(JSON.stringify({ t: 'in', d: `${command}\necho started-$((6*7))\n` }));
await until('started-42');
log('command');
clearInterval(ticker);
control.close();
warm.close();
log('left', { status: await (await retrying('/_gmux/status')).json() });
