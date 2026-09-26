// the whole-kernel checkpoint on a deployed Free object: checkpoint mid-pipeline, ctx.abort(), restore
const B = process.env.G08_URL ?? 'https://gmux-boot.gmitch215-free.workers.dev';
const name = process.argv[2] ?? `ck-${Date.now()}`;
// BIG=1 runs 1 GiB so the checkpoint always lands mid-job
const big = process.env.BIG === '1';
const BYTES = big ? 1073741824 : 100000000;
const EXPECTED = big ? 'd18e25082e4fcac81874c54428fad07ff6346942d33770fee2d806f5b8251940' : '504832ca4f576454c1e2393b2cab3942a54fcd26faf099128cf9c05cd11641b8';
const get = async (path) => {
	const res = await fetch(`${B}${path}${path.includes('?') ? '&' : '?'}do=${name}`);
	const text = await res.text();
	try {
		return JSON.parse(text);
	} catch {
		return { status: res.status, text: text.slice(0, 120) };
	}
};
const t0 = Date.now();
const log = (...a) => console.log(`${((Date.now() - t0) / 1000).toFixed(1)}s`, ...a);
const id = (r) => r.instance?.slice(0, 8);
const a = await get('/burn?iters=3e8');
const b = await get('/who');
log('pre-place', id(a), '->', id(b));
const boot = await get(`/boot?async=1&pages=${process.env.PAGES ?? 800}&wall=20000`);
log('boot', id(boot), boot.outcome, JSON.stringify(boot.tail?.slice(-12)));
// FOREGROUND=1 checkpoints a foreground pipeline mid-run instead of a background job
const fg = process.env.FOREGROUND === '1';
const ex = await get(`/exec?cmd=${encodeURIComponent(fg ? `yes | head -c ${BYTES} | sha256sum; echo ALIVE-$((6*7))` : `yes | head -c ${BYTES} | sha256sum > /sum &`)}&wall=3000`);
log('exec', id(ex), JSON.stringify(ex.out?.slice(-60)));
const run = await get('/run?wall=3000');
const before = (ex.out ?? '') + (run.out ?? '');
log('run', `job ${before.includes(EXPECTED) ? 'finished before' : 'mid-run at'} checkpoint`, run.outcome, JSON.stringify(run.out?.slice(-120)), JSON.stringify(run.stats));
const ck = await get('/checkpoint');
log('checkpoint', id(ck), JSON.stringify(ck));
const ab = await get('/abort');
log('abort', JSON.stringify(ab).slice(0, 100));
const w = await get('/who');
log('after abort', id(w), 'booted', w.booted, id(w) !== id(ck) ? 'NEW INSTANCE' : 'same instance');
const rs = await get(`/restore?reuse=${process.env.REUSE ?? 1}`);
log('restore', id(rs), JSON.stringify(rs));
let out = '';
if (fg) {
	const e3 = await get(`/exec?cmd=${encodeURIComponent('echo LIVE-$((6*7))')}&wall=8000`);
	out += e3.out ?? '';
} else {
	const e2 = await get(`/exec?cmd=${encodeURIComponent('wait; cat /sum; echo ALIVE-$((6*7))')}&wall=8000`);
	out += e2.out ?? '';
}
const live = fg ? 'LIVE-42' : 'ALIVE-42';
for (let i = 0; i < (big ? 40 : 20) && !out.includes(live); i++) {
	const r = await get(`/run?until=${live}&wall=8000`);
	if (r.instance && id(r) !== id(rs)) log(`event ${i}: instance changed to ${id(r)}`);
	out += r.out ?? '';
}
const sum = (fg ? before + out : out).match(/([0-9a-f]{64})/)?.[1];
log(sum === EXPECTED ? 'EXACT' : `MISMATCH ${sum}`, out.includes(live) ? 'shell alive' : 'shell dead');
log('tail of output', JSON.stringify(out.slice(-160)));
process.exit(sum === EXPECTED ? 0 : 1);
