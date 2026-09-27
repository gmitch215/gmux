const B = 'https://gmux-object-memory.gmitch215-free.workers.dev';
const [name, kind, step, max] = [
	process.argv[2],
	process.argv[3],
	Number(process.argv[4]),
	Number(process.argv[5])
];
let first = null,
	out = [];
for (let total = 0; total < max;) {
	const r = await (await fetch(`${B}/instances?kind=${kind}&n=${step}&keep=1&do=${name}`)).json();
	await new Promise((res) => setTimeout(res, 1000));
	const w = await (await fetch(`${B}/who?do=${name}`)).json();
	first ??= r.instance;
	total = r.total ?? -1;
	out.push(
		`${total}${w.instance !== r.instance ? '(RESET)' : ''}${r.error ? '!' + r.error.slice(0, 50) : ''}`
	);
	if (w.instance !== r.instance || r.error) break;
}
console.log(name, kind, out.join(' '));
