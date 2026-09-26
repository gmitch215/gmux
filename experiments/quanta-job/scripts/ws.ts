const base = 'wss://gmux-boot.gmitch215-free.workers.dev';
const name = process.argv[2] ?? `g10ws-${Date.now()}`;
const job = process.argv[3] ?? 'yes | head -c 268435456 | sha256sum; echo JOB$((1+1))DONE';
const ws = new WebSocket(`${base}/term?do=${name}`);
const queue: any[] = [];
let waiter: ((m: any) => void) | null = null;
ws.addEventListener('message', (e) => {
	const m = JSON.parse(String(e.data));
	if (waiter) {
		const w = waiter;
		waiter = null;
		w(m);
	} else queue.push(m);
});
ws.addEventListener('close', (e) => {
	console.log('closed', e.code, e.reason);
	process.exit(1);
});
const next = () => new Promise<any>((r) => (queue.length ? r(queue.shift()) : (waiter = r)));
await new Promise((r) => ws.addEventListener('open', r));
const send = async (m: object) => {
	ws.send(JSON.stringify(m));
	return next();
};
const t0 = Date.now();
let r = await send({ op: 'boot', pages: 800, wall: 15000 });
console.log('boot', r.instance?.slice(0, 8), r.outcome, r.wallMs, r.error ?? '');
r = await send({ op: 'run', type: `${job}\n`, until: 'JOB2DONE', wall: 20000 });
let ticks = 1;
const instances = new Set([r.instance]);
while (!String(r.out).includes('JOB2DONE') && ticks < 60) {
	console.log(
		'tick',
		ticks,
		r.instance?.slice(0, 8),
		r.outcome,
		r.wallMs,
		'fuel',
		r.stats?.fuelYields,
		r.error ?? '',
		r.reason ?? ''
	);
	if (r.reason === 'not booted') break;
	r = await send({ op: 'run', until: 'JOB2DONE', wall: 20000 });
	instances.add(r.instance);
	ticks++;
}
console.log('final out:', JSON.stringify(String(r.out).slice(-200)));
console.log(
	JSON.stringify({
		name,
		ticks,
		instances: [...instances].map((i) => i?.slice(0, 8)),
		totalWallMs: Date.now() - t0,
		stats: r.stats
	})
);
process.exit(0);
