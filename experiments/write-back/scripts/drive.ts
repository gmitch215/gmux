/**
 * Drives the deployed rig: each arm on a fresh object, first placement spent, the job started,
 * then 5 s quanta for the window. Prints one line per quantum and a summary per arm; CPU comes
 * from `wrangler tail --format json` read by scripts/tail.ts afterwards (label `do=<arm name>`).
 * `node --experimental-strip-types experiments/write-back/scripts/drive.ts <base url> <minutes> [job:arm ...]`
 */
const [base, minutesArg = '5', ...armArgs] = process.argv.slice(2);
if (!base) throw new Error('usage: drive.ts <base url> <minutes> [job:arm ...]');
const arms = armArgs.length
	? armArgs
	: ['write:quantum', 'write:writeback', 'cpu:quantum', 'cpu:writeback'];
const stamp = Date.now();
const get = async (path: string, params: Record<string, string>) => {
	const url = new URL(path, base);
	for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
	const r = await fetch(url);
	const text = await r.text();
	try {
		return JSON.parse(text) as Record<string, any>;
	} catch {
		return { error: `${r.status} ${text.slice(0, 120)}` };
	}
};

for (const spec of arms) {
	const [job, arm] = spec.split(':') as [string, string];
	const name = `e1-${job}-${arm}-${stamp}`;
	const params = { do: name };
	for (let i = 0; i < 2; i++) await get('/burn', { ...params, iters: '3e8' });
	const start = await get('/start', { ...params, arm, job, pages: process.env.PAGES ?? '800' });
	const instance = start.instance;
	console.log(JSON.stringify({ spec, name, start: start.op ?? start.error, instance, at: Date.now() }));
	const began = Date.now();
	let quanta = 0;
	let rows = 0;
	let checkpoints = 0;
	let restores = 0;
	let failed = 0;
	let lostInARow = 0;
	let firstProgress: number | null = null;
	let last: Record<string, any> = {};
	// per-instance counters restart when an instance is replaced and restores
	const fsyncs = new Map<string, number>();
	while (Date.now() - began < Number(minutesArg) * 60_000) {
		const q = await get('/quantum', { ...params, wall: '5000' });
		// a lost instance comes back from storage on the next request; only a run of losses stops the arm
		if (q.reason === 'not booted' || q.error) {
			failed++;
			console.log(JSON.stringify({ spec, failed, q: String(q.reason ?? q.error).slice(0, 60) }));
			if (++lostInARow >= 3 || q.reason === 'not booted') break;
			continue;
		}
		lostInARow = 0;
		quanta++;
		rows += q.rows;
		if (q.checkpoint) checkpoints++;
		if (q.restored) restores++;
		fsyncs.set(q.instance, q.fsyncs);
		firstProgress ??= q.progress;
		last = q;
		console.log(
			JSON.stringify({
				spec,
				quanta,
				rows: q.rows,
				checkpoint: q.checkpoint,
				restored: q.restored,
				restoredFiles: q.restoredFiles,
				progress: q.progress,
				fsyncs: q.fsyncs,
				interval: q.interval,
				instance: q.instance
			})
		);
	}
	const wallMs = Date.now() - began;
	await get('/stop', params);
	console.log(
		JSON.stringify({
			summary: spec,
			name,
			quanta,
			wallMs,
			rows,
			rowsPerHour: Math.round((rows * 3_600_000) / wallMs),
			checkpoints,
			fsyncs: [...fsyncs.values()].reduce((a, b) => a + b, 0),
			progress: (last.progress ?? 0) - (firstProgress ?? 0),
			restores,
			failed,
			firstInstance: instance
		})
	);
}
