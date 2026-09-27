// keep-alive client: ramps retained memory on one object and reports instance changes
const B = 'https://gmux-object-memory.gmitch215-free.workers.dev';
const [name, step, max, pause] = [
	process.argv[2],
	Number(process.argv[3] ?? 8),
	Number(process.argv[4] ?? 256),
	Number(process.argv[5] ?? 1000)
];
let last = '';
const trace = [];
for (let held = 0, i = 0; held < max && i < 60; i++) {
	const t0 = Date.now();
	const res = await fetch(`${B}/${process.env.OP ?? 'hold'}?mb=${step}&do=${name}`);
	const body = await res.text();
	let r;
	try {
		r = JSON.parse(body);
	} catch {
		trace.push(`HTTP${res.status}:${body.match(/<title>([^<]*)/)?.[1] ?? body.slice(0, 60)}`);
		process.stdout.write(`HTTP${res.status}@${held} `);
		break;
	}
	const ms = Date.now() - t0;
	const inst = r.instance.slice(0, 8);
	if (last && inst !== last) {
		trace.push(`RESET(after ${held}MiB, ${ms}ms)`);
		process.stdout.write(`RESET@${held} `);
	}
	last = inst;
	held = r.heldMb;
	trace.push(r.error ? `${held}!${r.error.slice(0, 40)}` : `${held}`);
	if (r.error) break;
	await new Promise((r) => setTimeout(r, pause));
}
await fetch(`${B}/drop?do=${name}`);
console.log(name, trace.join(' '));
