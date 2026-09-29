// hibernatable control socket beside a standard warm socket holding parked JSPI tasks: close-warm | keep-warm
const B = process.env.WORKER_URL;
if (!B) throw new Error('set WORKER_URL to the deployed worker, e.g. https://<name>.<subdomain>.workers.dev');
const [name, scenario, idle] = [process.argv[2], process.argv[3], Number(process.argv[4] ?? 90)];
const t0 = Date.now();
const log = (...a) => console.log(`${((Date.now() - t0) / 1000).toFixed(1)}s`, ...a);
function open(kind) {
	const ws = new WebSocket(`${B.replace(/^http/, 'ws')}/ws?kind=${kind}&do=${name}`);
	const inbox = [];
	let waiter = null;
	ws.addEventListener('message', (e) =>
		waiter ? (waiter(JSON.parse(e.data)), (waiter = null)) : inbox.push(JSON.parse(e.data))
	);
	ws.addEventListener('close', (e) => log(`${kind} closed code=${e.code} reason=${e.reason}`));
	const ask = (text) =>
		new Promise((r) => {
			waiter = r;
			ws.send(text);
			setTimeout(() => {
				if (waiter === r) {
					waiter = null;
					r({ timeout: true });
				}
			}, 20000);
		});
	return new Promise((r) => ws.addEventListener('open', () => r({ ws, ask })));
}
const sleep = (s) => new Promise((r) => setTimeout(r, s * 1000));
const control = await open('control');
const warm = await open('warm');
log('warm park', JSON.stringify(await warm.ask('park')));
log('control mark', JSON.stringify(await control.ask('mark')));
if (scenario === 'close-warm') {
	warm.ws.close(1000, 'lease released');
	log(`idle ${idle}s with only the control socket`);
	await sleep(idle);
	log('control after idle', JSON.stringify(await control.ask('status')));
} else if (scenario === 'keep-warm') {
	await sleep(idle);
	log('warm after idle', JSON.stringify(await warm.ask('status')));
	log('control after idle', JSON.stringify(await control.ask('status')));
}
process.exit(0);
