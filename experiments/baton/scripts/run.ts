// a headless job driven by its partner's requests, both ways, then by alarms; polled until done
const B = process.env.WORKER_URL;
if (!B) throw new Error('set WORKER_URL to the deployed worker, e.g. https://<name>.<subdomain>.workers.dev');
const quanta = Number(process.argv[2] ?? 60);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const arms = [
	['request 8', 'baton', 'a', 'b', 8],
	['socket A<-B', 'socket', 's', 't'],
	['socket B<-A', 'socket', 't2', 's2'],
	['alarm', 'alarm', 'c', 'c']
];
for (const [label, mode, me, partner, cap] of arms) {
	const id = `${me}-${Date.now()}`;
	const pid = `${partner}-${Date.now()}`;
	for (const o of [id, pid]) for (let i = 0; i < 3; i++) await (await fetch(`${B}/burn?do=${o}`)).text();
	await (await fetch(`${B}/start?do=${id}&me=${id}&partner=${pid}&mode=${mode}&quanta=${cap ?? quanta}`)).text();
	let status;
	for (let i = 0; i < 600; i++) {
		await sleep(1000);
		status = await (await fetch(`${B}/status?do=${id}`)).json().catch(() => ({}));
		if (status.finished) break;
	}
	console.log(label.padEnd(12), JSON.stringify(status.finished ?? status));
}
