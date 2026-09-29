// parks N stacks on a fresh object, then polls who for `polls` requests on one keep-alive client
const B = process.env.WORKER_URL;
if (!B) throw new Error('set WORKER_URL to the deployed worker, e.g. https://<name>.<subdomain>.workers.dev');
const [name, tasks, depth, polls] = [
	process.argv[2],
	process.argv[3],
	process.argv[4],
	Number(process.argv[5] ?? 15)
];
const p = await (await fetch(`${B}/park?tasks=${tasks}&depth=${depth}&do=${name}`)).json();
const first = p.instance.slice(0, 8);
let out = `${name} tasks=${tasks} depth=${depth} parked=${p.parked ?? p.error}`;
for (let i = 0; i < polls; i++) {
	await new Promise((r) => setTimeout(r, 1000));
	const w = await (await fetch(`${B}/who?do=${name}`)).json();
	if (w.instance.slice(0, 8) !== first) {
		out += ` RESET@poll${i + 1}`;
		break;
	}
}
console.log(out);
