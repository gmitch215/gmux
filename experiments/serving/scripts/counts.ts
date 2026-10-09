import { readFileSync } from 'node:fs';

/**
 * Tables from the lines of serve.ts MODE=count: the net imports' calls and bytes per crossing, and the
 * guest's syscalls for file and socket traffic, per workload over the runs (min-max where they differ).
 * `node --no-warnings --experimental-strip-types experiments/serving/scripts/counts.ts <count.jsonl>`
 */
const path = process.argv[2];
if (!path) throw new Error('usage: counts.ts <count.jsonl>');
const rows = readFileSync(path, 'utf8')
	.split('\n')
	.filter((line) => line.startsWith('{'))
	.map((line) => JSON.parse(line))
	.filter((row) => row.out);
const NAMES: Record<number, string> = {
	63: 'read',
	64: 'write',
	65: 'readv',
	66: 'writev',
	67: 'pread64',
	71: 'sendfile',
	76: 'splice',
	77: 'tee',
	206: 'sendto',
	207: 'recvfrom',
	211: 'sendmsg',
	212: 'recvmsg',
	285: 'copy_file_range'
};
const span = (v: number[]) => {
	const lo = Math.min(...v);
	const hi = Math.max(...v);
	return lo === hi ? `${lo}` : `${lo}-${hi}`;
};
const workloads = [...new Set(rows.map((r) => r.workload as string))];
const of = (w: string) => rows.filter((r) => r.workload === w);
const out: string[] = [
	'| workload | runs | reply bytes | wasm_net_next calls (events) | wasm_net_send calls (zero) | wasm_net_end calls | bytes per send | bytes per next event | pump steps | idle waits |',
	'| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |'
];
for (const w of workloads) {
	const r = of(w).map((x) => x.out);
	const p = (k: string) => span(r.map((x) => x.perRequest[k]));
	out.push(
		`| ${w} | ${r.length} | ${span(r.map((x) => x.bytes))} | ${p('nextCalls')} (${p('nextEvents')}) | ${p('sendCalls')} (${p('sendZero')}) | ${p('endCalls')} | ${span(r.map((x) => Math.round(x.bytesPerSend)))} | ${span(r.map((x) => Math.round(x.bytesPerNextEvent)))} | ${span(r.map((x) => x.steps.mean))} | ${p('idles')} |`
	);
}
out.push(
	'',
	'Guest syscalls over one request of the whole machine (calls, and bytes the calls returned):',
	'',
	'| workload | ' + Object.values(NAMES).join(' | ') + ' |',
	'| --- | ' + Object.values(NAMES).map(() => '---').join(' | ') + ' |'
);
for (const w of workloads) {
	const r = of(w).map((x) => x.out.syscalls);
	const cells = Object.keys(NAMES).map((nr) => {
		const calls = r.map((s) => s.calls[nr] ?? 0);
		const bytes = r.map((s) => s.bytes[nr] ?? 0);
		return calls.every((c) => !c) ? '0' : `${span(calls)} (${span(bytes)} B)`;
	});
	out.push(`| ${w} | ${cells.join(' | ')} |`);
}
console.log(out.join('\n'));
