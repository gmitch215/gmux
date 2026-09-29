/**
 * The isolated crossing on the deployed worker (`worker/`): per arity, the loop with the thunk and the loop
 * without it, n and 2n iterations, client wall of each request; a round's cost is
 * ((cross 2n - cross n) - (empty 2n - empty n)) / n. The worker's clock does not move while code runs, so
 * the request wall is the only clock; a pair of requests can land in different isolates, which is counted.
 * `WORKER_URL=<url> node --experimental-strip-types tau-deployed.ts [rounds] [n] [arities]` prints JSON.
 */
const base = process.env.WORKER_URL;
if (!base) {
	console.error('usage: WORKER_URL=<deployed worker url> tau-deployed.ts [rounds] [n] [arities, default 2,3,5,7]');
	process.exit(2);
}
const [roundsArg = '10', nArg = '1000000', arityArg = '2,3,5,7'] = process.argv.slice(2);
const rounds = Number(roundsArg);
const n = Number(nArg);
const ks = arityArg.split(',').map(Number);
const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]!;
const summary = (xs: number[]) => ({ median: median(xs), min: Math.min(...xs), max: Math.max(...xs), spread: (Math.max(...xs) - Math.min(...xs)) / median(xs) });

let failures = 0;
const errors: string[] = [];
const isolates = new Set<string>();
async function run(arm: string, count: number) {
	for (let attempt = 0; attempt < 8; attempt++) {
		const t = performance.now();
		const res = await fetch(`${base}/run?arm=${arm}&n=${count}`);
		if (res.ok) {
			const body = (await res.json()) as { isolate: string; crossings: number };
			isolates.add(body.isolate);
			return performance.now() - t;
		}
		failures++;
		errors.push(`${arm} ${count}: ${res.status} ${(await res.text()).slice(0, 80)}`);
	}
	throw new Error(`${arm} ${count} failed eight times: ${errors.slice(-3).join('; ')}`);
}

const rows: { arity: number; ns: number; crossN: number; cross2N: number; emptyN: number; empty2N: number }[] = [];
await run('empty3', 1000);
for (let r = 0; r < rounds; r++)
	for (let i = 0; i < ks.length; i++) {
		const k = ks[(i + r) % ks.length]!;
		const crossN = await run(`cross${k}`, n);
		const emptyN = await run(`empty${k}`, n);
		const cross2N = await run(`cross${k}`, 2 * n);
		const empty2N = await run(`empty${k}`, 2 * n);
		rows.push({ arity: k, ns: ((cross2N - crossN - (empty2N - emptyN)) * 1e6) / n, crossN, cross2N, emptyN, empty2N });
	}
const byArity = Object.fromEntries(ks.map((k) => [k, summary(rows.filter((x) => x.arity === k).map((x) => x.ns))]));
console.log(JSON.stringify({ base: 'WORKER_URL', rounds, n, unit: 'ns per crossing from client wall', failures, errors, isolates: isolates.size, byArity, rows }, null, '\t'));
