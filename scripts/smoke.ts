/**
 * drives a running site the way the terminal page does: claims the machine (or uses GMUX_TOKEN),
 * opens the control and warm sockets, waits for the shell and checks that a command answers.
 * `bun scripts/smoke.ts [base url]` (default http://localhost:8787); exits nonzero on failure
 */
const base = (process.argv[2] ?? 'http://localhost:8787').replace(/\/$/, '');
const timeoutMs = Number(process.env.GMUX_SMOKE_TIMEOUT_MS ?? 120_000);

async function token(): Promise<string> {
	if (process.env.GMUX_TOKEN) return process.env.GMUX_TOKEN;
	const response = await fetch(`${base}/_gmux/claim`, { method: 'POST' });
	const body = (await response.json()) as { token?: string; error?: string };
	if (!body.token) throw new Error(`claim: ${response.status} ${body.error ?? ''}`);
	return body.token;
}

function socket(kind: 'control' | 'warm', owner: string): Promise<WebSocket> {
	const url = `${base.replace(/^http/, 'ws')}/_gmux/term/ws?kind=${kind}&token=${encodeURIComponent(owner)}`;
	const ws = new WebSocket(url);
	return new Promise((resolve, reject) => {
		ws.addEventListener('open', () => resolve(ws), { once: true });
		ws.addEventListener('error', () => reject(new Error(`${kind} socket failed`)), {
			once: true
		});
	});
}

const owner = await token();
const control = await socket('control', owner);
const warm = await socket('warm', owner);
const ticker = setInterval(
	() => warm.readyState === 1 && control.send(JSON.stringify({ t: 'tick' })),
	1000
);
let output = '';
control.addEventListener('message', (event) => {
	const msg = JSON.parse(String(event.data)) as { t: string; d: string };
	if (msg.t === 'out') output += msg.d;
	if (msg.t === 'status' && msg.d === 'crashed') output += '\n[machine crashed]\n';
});
const type = (text: string) => control.send(JSON.stringify({ t: 'in', d: text }));
const until = async (text: string) => {
	const started = Date.now();
	while (!output.includes(text)) {
		if (output.includes('[machine crashed]') || Date.now() - started > timeoutMs)
			throw new Error(
				`no "${text}" after ${Date.now() - started} ms:\n${output.slice(-2000)}`
			);
		await new Promise((r) => setTimeout(r, 100));
	}
};

let ok = false;
try {
	const started = Date.now();
	type('\n');
	await until('# ');
	const prompt = Date.now() - started;
	type('echo gmux-$((6*7)); uname -sm\n');
	await until('gmux-42');
	ok = true;
	console.log(`smoke: prompt in ${prompt} ms, the shell answers`);
} catch (error) {
	console.error(`smoke: ${(error as Error).message}`);
} finally {
	clearInterval(ticker);
	control.close();
	warm.close();
}
process.exit(ok ? 0 : 1);
