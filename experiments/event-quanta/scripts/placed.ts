// keep-alive client: the site's placement step on fresh objects, then a burn past a second; a placed
// object should keep its instance through the burn
const B = process.env.WORKER_URL;
if (!B) throw new Error('set WORKER_URL to the deployed worker, e.g. https://<name>.<subdomain>.workers.dev');
const [prefix, count] = [process.argv[2], Number(process.argv[3] ?? 5)];
const get = async (path) => (await fetch(`${B}${path}`)).json();
const pause = () => new Promise((r) => setTimeout(r, 1500));
for (let i = 0; i < count; i++) {
	const name = `${prefix}-${i}`;
	const states = [];
	let last;
	for (let tries = 0; tries < 4; tries++) {
		last = await get(`/place?do=${name}`);
		states.push(last.state);
		if (last.state === 'placed') break;
		await pause();
	}
	const burn = await get(`/burn?iters=2.8e8&do=${name}`);
	await pause();
	const after = await get(`/who?do=${name}`);
	console.log(
		name,
		states.join(','),
		burn.instance === last.instance && after.instance === last.instance
			? 'kept through a 1.5 s burn'
			: 'REPLACED after placement'
	);
}
