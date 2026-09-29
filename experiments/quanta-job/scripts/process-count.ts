const B = process.env.WORKER_URL;
if (!B) throw new Error('set WORKER_URL to the deployed worker, e.g. https://<name>.<subdomain>.workers.dev');
const [name, cmd, events] = [process.argv[2], process.argv[3], Number(process.argv[4] ?? 5)];
const get = async (path) =>
	(await fetch(`${B}${path}${path.includes('?') ? '&' : '?'}do=${name}`)).json();
const id = (r) => r.instance.slice(0, 8);
const burn = await get('/burn?iters=3e8');
const placed = await get('/who');
const boot = await get('/boot?pages=800&wall=20000');
const steps = [`burn:${id(burn)}->${id(placed)}`, `boot:${id(boot)}`];
for (let i = 0; i < events; i++) {
	const r = await get(`/exec?cmd=${encodeURIComponent(cmd)}&wall=3000`);
	await new Promise((res) => setTimeout(res, 1500));
	const w = await get('/who');
	steps.push(`e${i}:${id(r)}:inst=${r.stats?.instances}->${id(w)}${w.booted ? '' : '(RESET)'}`);
	if (!w.booted) break;
}
console.log(name, JSON.stringify(cmd), steps.join(' '));
process.exit(0);
