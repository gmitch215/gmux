/**
 * The shipped site, durable: claims the machine, runs the write job for QUANTA warm ticks, syncs a
 * marker file with fsync and another with an O_SYNC-free `sync`, stops the job and leaves. After
 * IDLE_S seconds with no socket (alarms only) it asks /_gmux/status whether the object still holds
 * its machine, reconnects and reads both files back: a machine that came back from storage says
 * "restored" and has them.
 * `node --experimental-strip-types experiments/write-back/scripts/site-drive.ts <base url>`
 */
const base = (process.argv[2] ?? 'http://localhost:8787').replace(/\/$/, '');
const QUANTA = Number(process.env.QUANTA ?? 8);
const IDLE_S = Number(process.env.IDLE_S ?? 180);
const log = (event: string, data: object = {}) =>
	console.log(JSON.stringify({ at: new Date().toISOString(), event, ...data }));

async function retrying(path: string, init?: RequestInit) {
	for (let i = 0; ; i++) {
		const response = await fetch(`${base}${path}`, init);
		if (response.status !== 503 || i > 8) return response;
		await new Promise((r) => setTimeout(r, 1500));
	}
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

let output = '';
const statuses: string[] = [];
const drops: string[] = [];
async function attach(owner: string) {
	let closing = false;
	let control = await socket('control', owner);
	let warm = await socket('warm', owner);
	// a reset object drops its sockets; the terminal page reconnects, and so does this
	const watch = (kind: 'control' | 'warm', ws: WebSocket) =>
		ws.addEventListener('close', async () => {
			if (closing) return;
			drops.push(`${kind} ${new Date().toISOString()}`);
			await new Promise((r) => setTimeout(r, 1000));
			const again = await socket(kind, owner);
			if (kind === 'control') {
				control = again;
				listen(again);
			} else warm = again;
			watch(kind, again);
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
	const until = async (text: string, ms = 180_000) => {
		const started = Date.now();
		while (!output.includes(text)) {
			if (Date.now() - started > ms)
				throw new Error(`no "${text}" after ${ms} ms:\n${output.slice(-1500)}`);
			await new Promise((r) => setTimeout(r, 200));
		}
	};
	const close = () => {
		closing = true;
		clearInterval(ticker);
		control.close();
		warm.close();
	};
	return { type, until, close };
}
const status = async () => (await retrying('/_gmux/status')).json();

const claimed = await retrying('/_gmux/claim', { method: 'POST' });
const { token } = (await claimed.json()) as { token: string };
if (!token) throw new Error(`claim: ${claimed.status}`);
let t = await attach(token);
const started = Date.now();
await t.type('\n');
await t.until('# ');
log('prompt', { ms: Date.now() - started, statuses });
await t.type(
	'mkdir -p /data; x=$(seq 1 8000); i=0; while :; do f=/data/f$((i % 16)); echo "$i $x" > $f; ' +
		'[ $((i % 256)) = 0 ] && fsync $f; i=$((i + 1)); [ $((i % 64)) = 0 ] && echo W$i; done &\n'
);
await new Promise((r) => setTimeout(r, QUANTA * 5000));
const progress = Number([...output.matchAll(/W(\d+)/g)].at(-1)?.[1] ?? 0);
// input an object lost to a reset before it ran is typed again
const command = async (text: string, marker: string) => {
	for (let tries = 1; ; tries++) {
		await t.type(text);
		try {
			return await t.until(marker, 60_000);
		} catch (error) {
			if (tries === 3) throw error;
			log('retype', { marker, drops });
		}
	}
};
await command(
	'kill %1; echo fsynced > /data/a; fsync /data/a; echo walked > /data/b; sync; echo @@M$((1+1))@@\n',
	'@@M2@@'
);
const before = await status();
log('job', { progress, durable: before.durable, stats: before.stats && { fileSyncs: before.stats.fileSyncs, syncWalks: before.stats.syncWalks } });
t.close();
await new Promise((r) => setTimeout(r, IDLE_S * 1000));
const idle = await status();
log('idle', { running: idle.running, durable: idle.durable });
output = '';
t = await attach(token);
await command('cat /data/a /data/b; echo @@B$((1+1))@@\n', '@@B2@@');
const after = await status();
const result = {
	progress,
	replaced: !idle.running || idle.durable.restores > 0,
	// the instance that answers now came from storage (an alarm may have restored it unwatched)
	restored: statuses.includes('restored') || after.durable.restores > 0,
	fsyncedKept: output.includes('\nfsynced\n'),
	walkedKept: output.includes('\nwalked\n'),
	statuses,
	drops,
	durableAfter: after.durable,
	tail: output.slice(-300)
};
log('result', result);
t.close();
const pass = result.replaced && result.restored && result.fsyncedKept && result.walkedKept;
console.log(pass ? 'PASS site restores' : 'FAIL site restores');
process.exit(pass ? 0 : 1);
