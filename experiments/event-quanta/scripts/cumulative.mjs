// keep-alive client: several burns per fresh object, one event each, and the event after which each
// object's instance changed (first placement counted per event or across events)
const B = 'https://gmux-event-quanta.gmitch215-free.workers.dev';
const [prefix, iters, events, count] = [
	process.argv[2],
	process.argv[3],
	Number(process.argv[4] ?? 3),
	Number(process.argv[5] ?? 5)
];
for (let i = 0; i < count; i++) {
	const name = `${prefix}-${i}`;
	const seen = [];
	for (let e = 0; e < events; e++) {
		seen.push((await (await fetch(`${B}/burn?iters=${iters}&do=${name}`)).json()).instance);
		await new Promise((r) => setTimeout(r, 1500));
	}
	seen.push((await (await fetch(`${B}/who?do=${name}`)).json()).instance);
	const changed = seen.findIndex((x, k) => k > 0 && x !== seen[k - 1]);
	console.log(name, changed < 0 ? 'kept through every event' : `replaced after event ${changed}`);
}
