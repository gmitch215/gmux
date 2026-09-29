// SIMD kernels on a deployed lane: each kernel timed by the client, reps=R against reps=0 on the same warm lane
const B = process.env.WORKER_URL;
if (!B) throw new Error('set WORKER_URL to the deployed worker, e.g. https://<name>.<subdomain>.workers.dev');
const OPS = { sgemm: 2 * 256 ** 3, dot8: 2 * (1 << 24), conv3: 18 * 512 * 512 };
const name = `simd-${Date.now()}`;
const timed = async (q) => {
	const t0 = performance.now();
	const r = await (await fetch(`${B}/?do=${name}&${q}`)).json();
	return { ...r, rtt: performance.now() - t0 };
};
const median = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
const instances = new Set();
for (let i = 0; i < 3; i++) instances.add((await timed('k=sgemm&reps=1')).instance);
for (const [kernel, reps] of [['sgemm', 40], ['dot8', 20], ['conv3', 400]]) {
	const base = [], full = [];
	for (let i = 0; i < 5; i++) {
		const a = await timed(`k=${kernel}&reps=0`);
		const b = await timed(`k=${kernel}&reps=${reps}`);
		base.push(a.rtt), full.push(b.rtt);
		instances.add(a.instance).add(b.instance);
	}
	const ms = median(full) - median(base);
	console.log(JSON.stringify({ kernel, reps, ms: Math.round(ms), gops: +((OPS[kernel] * reps) / ms / 1e6).toFixed(2) }));
}
console.log('instances', instances.size);
