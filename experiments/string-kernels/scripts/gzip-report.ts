import { readFileSync } from 'node:fs';

/**
 * Prints the table of a gzip-wasm.ts samples file: per input and arm the median wall time, its spread, the paired ratio to the
 * native cell of the same round (median, min-max, rounds at or under 1.0), the host streams per sample and the samples with
 * a quiet reading above 0.5 or a failed check
 * `node --experimental-strip-types experiments/string-kernels/scripts/gzip-report.ts <samples.tsv>`
 */
const path = process.argv[2];
if (!path) {
	console.error('usage: gzip-report.ts <samples.tsv>');
	process.exit(2);
}
const [header, ...lines] = readFileSync(path, 'utf8').trim().split('\n');
const names = header!.split('\t');
const rows = lines.map((l) => Object.fromEntries(l.split('\t').map((v, i) => [names[i]!, v])) as Record<string, string>);
const median = (v: number[]) => [...v].sort((a, b) => a - b)[Math.floor(v.length / 2)]!;
const fix = (n: number) => n.toFixed(3);
const out: string[] = [];
out.push('| input | arm | n | median s | min-max s | paired r median | r min-max | rounds <= 1.0 | host streams | noisy | failed |');
out.push('| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |');
for (const input of [...new Set(rows.map((r) => r.input!))]) {
	const control = new Map(rows.filter((r) => r.input === input && r.arm === 'native').map((r) => [r.rep, Number(r.ms)]));
	for (const arm of [...new Set(rows.filter((r) => r.input === input).map((r) => r.arm!))]) {
		const mine = rows.filter((r) => r.input === input && r.arm === arm);
		const ms = mine.map((r) => Number(r.ms) / 1000);
		const pairs = mine.filter((r) => control.has(r.rep!)).map((r) => Number(r.ms) / control.get(r.rep!)!);
		const noisy = mine.filter((r) => Number(r.quiet_before) > 0.5 || Number(r.quiet_after) > 0.5).length;
		const failed = mine.filter((r) => r.ok !== '1').length;
		const streams = mine.map((r) => Number(r.host_streams));
		out.push(
			`| ${input} | ${arm} | ${mine.length} | ${fix(median(ms))} | ${fix(Math.min(...ms))}-${fix(Math.max(...ms))} | ${pairs.length ? median(pairs).toFixed(2) : '-'} | ${pairs.length ? `${Math.min(...pairs).toFixed(2)}-${Math.max(...pairs).toFixed(2)}` : '-'} | ${pairs.length ? `${pairs.filter((p) => p <= 1).length} of ${pairs.length}` : '-'} | ${median(streams)} | ${noisy} | ${failed} |`
		);
	}
}
console.log(out.join('\n'));
