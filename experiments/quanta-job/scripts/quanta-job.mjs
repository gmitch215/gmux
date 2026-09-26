// pre-place the object past first-placement, boot, then run a CPU-bound job across many events
const B = 'https://gmux-boot.gmitch215-free.workers.dev';
const name = process.argv[2];
const expected = process.argv[3];
const get = async (path) =>
	(await fetch(`${B}${path}${path.includes('?') ? '&' : '?'}do=${name}`)).json();
const t0 = Date.now();
const log = (...a) => console.log(`${((Date.now() - t0) / 1000).toFixed(1)}s`, ...a);
const a = await get('/burn?iters=2.5e8');
const b = await get('/who');
log('pre-place burn', a.instance.slice(0, 8), '->', b.instance.slice(0, 8));
const boot = await get('/boot?pages=800&wall=20000');
log('boot', boot.instance.slice(0, 8), JSON.stringify(boot).slice(0, 300));
let inst = boot.instance;
const ex = await get(
	`/exec?cmd=${encodeURIComponent('yes | head -c 1073741824 | sha256sum')}&wall=4000`
);
log('exec', JSON.stringify(ex).slice(0, 400));
if (!ex.out) process.exit(1);
let out = ex.out;
for (let i = 0; i < 40 && !out.includes(expected.slice(0, 16)); i++) {
	const r = await get(`/run?until=${expected.slice(0, 16)}&wall=6000`);
	if (r.instance !== inst)
		log(
			`EVENT ${i}: INSTANCE CHANGED ${inst.slice(0, 8)} -> ${r.instance.slice(0, 8)} booted? ${JSON.stringify(r).slice(0, 80)}`
		);
	inst = r.instance;
	out += r.out ?? '';
	if (!r.out && r.ok === false) {
		log('not booted any more', JSON.stringify(r));
		break;
	}
	log(`event ${i}`, r.outcome, r.wallMs, JSON.stringify((r.out ?? '').slice(-70)));
}
log(
	out.includes(expected.slice(0, 16)) ? 'JOB COMPLETED WITH CORRECT SHA' : 'job did not complete'
);
process.exit(0);
