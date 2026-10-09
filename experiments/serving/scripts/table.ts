import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Turns bench.sh's sample files into the tables: per workload the CPU and crossings per request
 * (one row per run, then the median of the run means), and per transfer kind and size the CPU per
 * transfer natively and in the machine. Samples read quiet above 0.5 are listed apart, never dropped.
 * `node --no-warnings --experimental-strip-types experiments/serving/scripts/table.ts <samples dir>`
 */
const dir = process.argv[2];
if (!dir) throw new Error('usage: table.ts <samples dir>');
const read = (name: string) =>
	existsSync(join(dir, name))
		? readFileSync(join(dir, name), 'utf8')
				.split('\n')
				.filter((line) => line.startsWith('{'))
				.map((line) => JSON.parse(line))
		: [];
const median = (v: number[]) => {
	const s = [...v].sort((a, b) => a - b);
	return s.length ? (s[Math.floor((s.length - 1) / 2)]! + s[Math.floor(s.length / 2)]!) / 2 : NaN;
};
const noisy = (row: { quiet: string }) => Number(row.quiet.split(' ')[1] ?? 0) > 0.5;
const f = (n: number, digits = 3) => (Number.isFinite(n) ? n.toFixed(digits) : 'n/a');
const out: string[] = [];

const serve = read('serve.jsonl');
if (serve.length) {
	out.push(
		'## Per request',
		'',
		'Per run: mean (min, median, max) over the run\'s rounds; `quiet` is the quiet.sh reading before the sample.',
		'',
		'| workload | run | quiet | bytes | CPU ms | steps | idle waits | next calls (events) | send calls (zero) | bytes per send | time in send ms (% of CPU) | sha256 |',
		'| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |'
	);
	for (const row of serve) {
		const o = row.out;
		if (!o) {
			out.push(`| ${row.workload} | ${row.run} | ${row.quiet} | FAILED rc ${row.rc} | | | | | | | | |`);
			continue;
		}
		const p = o.perRequest;
		const [min, med, max] = o.cpuMs.minMedianMax;
		out.push(
			`| ${row.workload} | ${row.run} | ${row.quiet.split(' ')[1] ?? '?'} | ${o.bytes} | ${f(o.cpuMs.mean)} (${f(min)}, ${f(med)}, ${f(max)}) | ${f(o.steps.mean, 1)} | ${p.idles} | ${p.nextCalls} (${p.nextEvents}) | ${p.sendCalls} (${p.sendZero}) | ${o.bytesPerSend} | ${f(p.sendUs / 1000)} (${((100 * p.sendUs) / 1000 / o.cpuMs.mean).toFixed(1)}%) | ${String(o.sha256).slice(0, 8)} |`
		);
	}
	out.push(
		'',
		'Median of the run means (all samples, then the quiet ones only):',
		'',
		'| workload | runs | CPU ms median (min-max of the run means) | quiet runs | CPU ms median, quiet only |',
		'| --- | --- | --- | --- | --- |'
	);
	for (const w of [...new Set(serve.map((r) => r.workload))]) {
		const rows = serve.filter((r) => r.workload === w && r.out);
		const cpu = rows.map((r) => r.out.cpuMs.mean as number);
		const quiet = rows.filter((r) => !noisy(r)).map((r) => r.out.cpuMs.mean as number);
		out.push(
			`| ${w} | ${rows.length} | ${f(median(cpu))} (${f(Math.min(...cpu))}-${f(Math.max(...cpu))}) | ${quiet.length} | ${f(median(quiet))} |`
		);
	}
}

const timed = serve.filter((r) => r.out?.importsPerRequest);
if (timed.length) {
	out.push(
		'',
		'Host time inside each kernel import per request (microseconds, calls), the bigimports samples:',
		'',
		'| run | CPU ms | wasm_net_send | wasm_net_next | clock | other imports |',
		'| --- | --- | --- | --- | --- | --- |'
	);
	for (const row of timed) {
		const i = row.out.importsPerRequest as Record<string, { us: number; calls: number }>;
		const cell = (name: string) => (i[name] ? `${i[name].us} us, ${i[name].calls}` : '0');
		const rest = Object.entries(i)
			.filter(([k]) => !['wasm_net_send', 'wasm_net_next', 'wasm_cpu_clock_get_monotonic'].includes(k))
			.reduce((n, [, v]) => n + v.us, 0);
		out.push(
			`| ${row.run} | ${f(row.out.cpuMs.mean)} | ${cell('wasm_net_send')} | ${cell('wasm_net_next')} | ${cell('wasm_cpu_clock_get_monotonic')} | ${rest.toFixed(1)} us (top 14 only) |`
		);
	}
}

const sendfile = read('sendfile.jsonl');
if (sendfile.length) {
	out.push(
		'',
		'## CPU per transfer of the sendfile probe',
		'',
		'Microseconds per transfer (the run with transfers less the run with none), the median over the runs with the min-max in brackets; `quiet` counts the samples read above 0.5.',
		'',
		'| size | kind | native us | machine us | machine / native | machine kind / machine rw | quiet samples (native, machine) |',
		'| --- | --- | --- | --- | --- | --- | --- |'
	);
	const cell = (host: string, kind: string, size: number) =>
		sendfile.filter((r) => r.host === host && r.kind === kind && r.size === size && r.out?.ok);
	for (const size of [4096, 65536, 1048576]) {
		for (const kind of ['sendfile', 'splice', 'rw']) {
			const n = cell('native', kind, size);
			const m = cell('machine', kind, size);
			const rw = cell('machine', 'rw', size);
			const nv = n.map((r) => r.out.cpuUsPerCall as number);
			const mv = m.map((r) => r.out.cpuUsPerCall as number);
			const range = (v: number[]) => (v.length ? `${f(Math.min(...v))}-${f(Math.max(...v))}` : 'n/a');
			out.push(
				`| ${size} | ${kind} | ${f(median(nv))} (${range(nv)}) | ${f(median(mv))} (${range(mv)}) | ${f(median(mv) / median(nv), 1)} | ${f(median(mv) / median(rw.map((r) => r.out.cpuUsPerCall as number)), 2)} | ${n.filter(noisy).length} of ${n.length}, ${m.filter(noisy).length} of ${m.length} |`
			);
		}
	}
}
console.log(out.join('\n'));
