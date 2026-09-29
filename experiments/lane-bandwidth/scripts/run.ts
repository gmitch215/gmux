// sequential read bandwidth on a deployed lane. The deployed clock stands still while the object computes, so the client
// times each request: passes=P against passes=0 on the same warm lane, medians of five
const B = process.env.WORKER_URL;
if (!B) throw new Error('set WORKER_URL to the deployed worker, e.g. https://<name>.<subdomain>.workers.dev');
const name = `bandwidth-${Date.now()}`;
const timed = async (q) => {
	const t0 = performance.now();
	const r = await (await fetch(`${B}/?do=${name}&${q}`)).json();
	return { ...r, rtt: performance.now() - t0 };
};
const median = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
const instances = new Set();
for (const mb of [16, 64, 128]) {
	// fill, warm the kernel, and let a first placement's replacement happen before measuring
	for (let i = 0; i < 3; i++) instances.add((await timed(`mb=${mb}&passes=1`)).instance);
	for (const kind of ['simd', 'scalar']) {
		const passes = Math.round((kind === 'simd' ? 8192 : 4096) / mb);
		const base = [], full = [];
		for (let i = 0; i < 5; i++) {
			const a = await timed(`mb=${mb}&kind=${kind}&passes=0`);
			const b = await timed(`mb=${mb}&kind=${kind}&passes=${passes}`);
			base.push(a.rtt);
			full.push(b.rtt);
			instances.add(a.instance).add(b.instance);
		}
		const ms = median(full) - median(base);
		const gbps = (mb * 2 ** 20 * passes) / ms / 1e6;
		console.log(
			JSON.stringify({ kind, mb, passes, base: Math.round(median(base)), full: Math.round(median(full)), ms: Math.round(ms), gbps: +gbps.toFixed(2) })
		);
	}
}
console.log('instances', instances.size, '(break-even 3.7 GB/s)');
