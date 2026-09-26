// deploy while a machine is live: deploy (warm socket open) | hib-deploy (warm socket closed first)
const B = 'wss://gmux-publication.gmitch215-free.workers.dev';
const [name, scenario, idle] = [process.argv[2], process.argv[3], Number(process.argv[4] ?? 90)];
const t0 = Date.now();
const FLAG = process.env.DEPLOYED_FLAG ?? '/tmp/gmux-publication/deployed';
const log = (...a) => console.log(`${((Date.now() - t0) / 1000).toFixed(1)}s`, ...a);
function open(kind) {
	const ws = new WebSocket(`${B}/ws?kind=${kind}&do=${name}`);
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
if (scenario === 'hib-deploy') {
	warm.ws.close(1000, 'lease released');
	log('warm closed; waiting for a deploy');
	const fs = await import('node:fs');
	while (!fs.existsSync(FLAG)) await sleep(1);
	await sleep(10);
	log('control after deploy', JSON.stringify(await control.ask('status')));
} else if (scenario === 'deploy') {
	log(`waiting for a deploy (touch ${FLAG} when done)`);
	const fs = await import('node:fs');
	while (!fs.existsSync(FLAG)) await sleep(1);
	await sleep(10);
	log('warm after deploy', JSON.stringify(await warm.ask('status')));
	log('control after deploy', JSON.stringify(await control.ask('status')));
}
process.exit(0);
