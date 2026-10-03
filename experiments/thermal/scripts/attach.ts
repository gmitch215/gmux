/**
 * Attaches to the claimed machine, runs COMMAND in the guest and prints what it wrote between two
 * markers, then leaves. TOKEN is the one `start.ts` printed when it claimed the machine.
 * `WORKER_URL=<url of the deployed worker> TOKEN=<token> COMMAND='wc -l < /root/tick' node --experimental-strip-types experiments/thermal/scripts/attach.ts`
 */
if (!process.env.WORKER_URL || !process.env.COMMAND || !process.env.TOKEN) {
	console.error('usage: WORKER_URL=<url of the deployed worker> TOKEN=<token start.ts printed> COMMAND=<shell command> node --experimental-strip-types attach.ts');
	process.exit(2);
}
const base = process.env.WORKER_URL.replace(/\/$/, '');

function socket(kind: 'control' | 'warm', token: string): Promise<WebSocket> {
	const ws = new WebSocket(
		`${base.replace(/^http/, 'ws')}/_gmux/term/ws?kind=${kind}&token=${encodeURIComponent(token)}`
	);
	return new Promise((resolve, reject) => {
		ws.addEventListener('open', () => resolve(ws), { once: true });
		ws.addEventListener('error', () => reject(new Error(`${kind} socket failed`)), { once: true });
	});
}

const token = process.env.TOKEN!;

let output = '';
const control = await socket('control', token);
const warm = await socket('warm', token);
control.addEventListener('message', (event) => {
	const msg = JSON.parse(String(event.data)) as { t: string; d: string };
	if (msg.t === 'out') output += msg.d.replaceAll('\r', '');
});
const ticker = setInterval(() => control.send(JSON.stringify({ t: 'tick' })), 1000);
const until = async (pattern: RegExp, ms = 300_000) => {
	const started = Date.now();
	while (!pattern.test(output)) {
		if (Date.now() - started > ms) throw new Error(`no ${pattern} after ${ms} ms:\n${output.slice(-800)}`);
		await new Promise((r) => setTimeout(r, 200));
	}
};

control.send(JSON.stringify({ t: 'in', d: '\n' }));
await until(/# $/);
control.send(
	JSON.stringify({ t: 'in', d: `echo BEGIN-$((6*7)); ${process.env.COMMAND}; echo END-$((6*7))\n` })
);
await until(/\nEND-42\n/);
clearInterval(ticker);
control.close();
warm.close();
const body = /\nBEGIN-42\n([\s\S]*?)\nEND-42\n/.exec(output);
process.stdout.write(body ? `${body[1]}\n` : output);
