import { readFileSync } from 'node:fs';
import { parse } from './model.ts';
import { predictArch } from './predict-model.ts';

/**
 * Do the crossings add? The ws3 guests hold a lookup working set (B blocks held, H dispatched over)
 * and trace-long blocks (guard segments) in one program; each is predicted from the frozen table as
 * the sum of its crossing costs, its per-op cost read off its own base arm, as `predict.ts` does a
 * workload.
 *
 * `node --experimental-strip-types additive.ts <table.json> <ws3 dir> [bound %, default 5]` where the
 * dir holds `ws3-<arch>.tsv`. Exits 1 when a cell is outside the bound.
 */
const [tablePath = '', dir = '', boundArg = '5'] = process.argv.slice(2);
const bound = Number(boundArg) / 100;
const table = JSON.parse(readFileSync(tablePath, 'utf8'));
const pct = (x: number) => `${(100 * x).toFixed(1)}%`;
let outside = 0;
let cells = 0;
for (const arch of ['x86_64', 'aarch64']) {
	const rows = parse(readFileSync(`${dir}/ws3-${arch}.tsv`, 'utf8')).filter((r) => r.workload.endsWith('-31') && r.blocks);
	const hotOf = (w: string) => {
		const [, b, h] = w.split('-');
		return { held: Number(b), spread: parseInt(h!, 10) };
	};
	const out = predictArch(table.arch[arch], rows, () => 0, (w) => hotOf(w), 0);
	console.log(`\n${arch}: crossings summed from the table against the combined guests (bound ${pct(bound)})`);
	console.log('| guest | arm | measured ms | predicted ms | error | layout spread | blocks M | exits M | lookups M |');
	console.log('| --- | --- | --- | --- | --- | --- | --- | --- | --- |');
	for (const p of out) {
		const r = rows.find((r) => r.workload === p.workload && r.arm === p.arm)!;
		cells++;
		if (Math.abs(p.error) > bound) outside++;
		console.log(`| ${p.workload} | ${p.arm} | ${p.measured.toFixed(0)} | ${p.predicted.toFixed(0)} | ${pct(p.error)} | ${pct(p.spread)} | ${(r.blocks / 1e6).toFixed(1)} | ${(r.exits / 1e6).toFixed(2)} | ${(r.lookups / 1e6).toFixed(1)} |`);
	}
}
console.log(`\n${outside} of ${cells} cells outside ${pct(bound)}`);
process.exitCode = outside ? 1 : 0;
