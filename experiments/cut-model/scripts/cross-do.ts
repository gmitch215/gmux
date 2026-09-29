import { mkdirSync, rmdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * A MachineDO calling a LaneDO: the crossing is one awaited RPC. Timed from here, n and 2n calls in
 * one request and the difference over n, arms interleaved, so the request's own cost cancels. Run it
 * against `wrangler dev --config experiments/cut-model/wrangler.jsonc` (workerd's local runtime, no
 * network between the two objects), which gives the floor of the crossing, the runtime's own
 * dispatch; a deployed pair also crosses isolates or colos (`experiments/lane-pods/results`).
 *
 * `WORKER_URL=<full worker url> node --experimental-strip-types cross-do.ts [rounds, default 11]`,
 * prints JSON.
 */
const base = process.env.WORKER_URL;
if (!base) {
	console.error('usage: WORKER_URL=<full worker url> node --experimental-strip-types cross-do.ts [rounds]');
	process.exit(2);
}
const rounds = Number(process.argv[2] ?? 11);
const lock = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'build', 'batch', 'mac-bench.lock');

const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[xs.length >> 1]!;
const summary = (xs: number[]) => ({ median: median(xs), min: Math.min(...xs), max: Math.max(...xs), spread: (Math.max(...xs) - Math.min(...xs)) / median(xs) });

const call = async (path: string, n: number) => {
	const t = performance.now();
	const r = await fetch(`${base}${path}${path.includes('?') ? '&' : '?'}n=${n}`);
	await r.text();
	return performance.now() - t;
};
const arms = [
	{ name: 'loop', path: '/loop', n: 50000 },
	{ name: 'rpc-nop', path: '/cross', n: 5000 },
	{ name: 'rpc-1KiB', path: '/cross?size=1024', n: 5000 },
	{ name: 'rpc-64KiB', path: '/cross?size=65536', n: 2000 }
];
const perIter = async (a: (typeof arms)[number]) => (((await call(a.path, 2 * a.n)) - (await call(a.path, a.n))) * 1e3) / a.n;

for (const a of arms) for (let k = 0; k < 3; k++) await perIter(a);
for (;;) {
	try {
		mkdirSync(lock);
		break;
	} catch {
		await new Promise((r) => setTimeout(r, 15000));
	}
}
const got = new Map(arms.map((a) => [a.name, [] as number[]]));
try {
	for (let r = 0; r < rounds; r++)
		for (let k = 0; k < arms.length; k++) {
			const a = arms[(k + r) % arms.length]!;
			got.get(a.name)!.push(await perIter(a));
		}
} finally {
	rmdirSync(lock);
}
const arm = Object.fromEntries([...got].map(([k, v]) => [k, { ...summary(v), samples: v }]));
const kinds = ['rpc-nop', 'rpc-1KiB', 'rpc-64KiB'].map((k) => {
	const d = arm[k]!.samples.map((x, i) => x - arm.loop!.samples[i]!);
	return { kind: k, control: 'loop', ...summary(d) };
});
console.log(JSON.stringify({ unit: 'us per call (crossing = kinds[])', runtime: 'wrangler dev (workerd, local)', rounds, arms: arm, kinds }, null, '\t'));
