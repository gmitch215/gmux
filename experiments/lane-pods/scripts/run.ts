// flat against pods of 32 at 32..256 lanes, each lane's first call (cold) then a warm one; then lane-to-lane
const B = process.env.WORKER_URL;
if (!B) throw new Error('set WORKER_URL to the deployed worker, e.g. https://<name>.<subdomain>.workers.dev');
const t = Date.now();
for (const n of [32, 64, 128, 256]) {
	for (const pod of [0, 32]) {
		const run = `${t}-${n}-${pod}`;
		for (const phase of ['cold', 'warm']) {
			const r = await (await fetch(`${B}/run?n=${n}&pod=${pod}&run=${run}`)).json().catch((e) => ({ error: String(e) }));
			console.log(JSON.stringify({ phase, ...r }));
		}
	}
}
for (let i = 0; i < 3; i++)
	console.log('lane-to-lane', await (await fetch(`${B}/peer?lane=${t}-p${i}&peer=${t}-q${i}`)).text());
