// boots one arm per fresh object and reports whether the machine survives a pipeline: the checkpoint rig's Free-only fault
const B = process.env.WORKER_URL;
if (!B) throw new Error('set WORKER_URL to the deployed worker, e.g. https://<name>.<subdomain>.workers.dev');
const arms = process.argv.slice(2);
for (const arm of arms) {
	const name = `arm-${arm}-${Date.now()}`;
	const get = async (path) => {
		const res = await fetch(`${B}${path}${path.includes('?') ? '&' : '?'}do=${name}`);
		const text = await res.text();
		try {
			return JSON.parse(text);
		} catch {
			return { status: res.status };
		}
	};
	await get('/burn?iters=3e8');
	const boot = await get(`/boot?${arm}&pages=800&wall=20000`);
	const ex = await get(`/exec?cmd=${encodeURIComponent(process.env.CMD ?? 'yes | head -c 20000000 | sha256sum; echo DONE-$((1+1))')}&wall=3000`);
	let out = ex.out ?? '';
	let outcome = ex.outcome ?? '';
	for (let i = 0; i < 12 && !out.includes('DONE-2') && outcome !== 'crashed'; i++) {
		const r = await get('/run?until=DONE-2&wall=5000');
		out += r.out ?? '';
		outcome = r.outcome;
	}
	console.log(arm.padEnd(34), 'boot', boot.outcome, '->', out.includes('DONE-2') ? 'job finished' : `no finish (${outcome})`, out.includes('DONE-2') ? '' : JSON.stringify(out.slice(-120)));
}
process.exit(0);
