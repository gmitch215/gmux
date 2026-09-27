// keep-alive client: burns on fresh objects and reports whether each kept its instance afterwards
const B = 'https://gmux-event-quanta.gmitch215-free.workers.dev';
const [prefix, iters, count] = [process.argv[2], process.argv[3], Number(process.argv[4] ?? 10)];
const results = [];
for (let i = 0; i < count; i++) {
	const name = `${prefix}-${i}`;
	const a = await (await fetch(`${B}/burn?iters=${iters}&do=${name}`)).json();
	await new Promise((r) => setTimeout(r, 1500));
	const b = await (await fetch(`${B}/who?do=${name}`)).json();
	results.push(a.instance === b.instance ? 'kept' : 'REPLACED');
}
console.log(prefix, iters, results.join(' '));
