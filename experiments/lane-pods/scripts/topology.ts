// aggregate bandwidth and isolate packing at 1..256 simultaneous lanes, each lane warm
// first; POD=n dispatches through pods of n lanes instead of one flat fan-out
const B = process.env.WORKER_URL;
if (!B) throw new Error('set WORKER_URL to the deployed worker, e.g. https://<name>.<subdomain>.workers.dev');
const passes = Number(process.env.PASSES ?? 16);
const bytes = (16 << 20) * passes;
const pod = Number(process.env.POD ?? 0);
const t = Date.now();
let single = null;
for (const n of [1, 2, 4, 8, 16, 32, 64, 128, 256]) {
	const run = `${t}-${n}`;
	await (await fetch(`${B}/bw?n=${n}&passes=1&run=${run}&pod=${pod}`)).json();
	const r = await (await fetch(`${B}/bw?n=${n}&passes=${passes}&run=${run}&pod=${pod}`)).json();
	const ok = r.lanes.filter((l) => !l.error);
	const isolates = new Set(ok.map((l) => l.isolate)).size;
	const median = [...ok.map((l) => l.ms)].sort((a, b) => a - b)[Math.floor(ok.length / 2)];
	if (n === 1) single = r.wallMs;
	console.log(
		JSON.stringify({
			lanes: n,
			pod,
			ok: ok.length,
			isolates,
			wallMs: r.wallMs,
			medianLaneMs: median,
			aggregateGBps: +((ok.length * bytes) / r.wallMs / 1e6).toFixed(1),
			concurrency: single ? +((ok.length * single) / r.wallMs).toFixed(1) : null
		})
	);
}
