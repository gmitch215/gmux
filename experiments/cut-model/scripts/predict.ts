import { existsSync, readFileSync } from 'node:fs';
import { parse, type Row } from './model.ts';
import { blockFor, ownLookupNs, predictArch, traceArms, withCounters, type Hot } from './predict-model.ts';

/**
 * The sweep's arms predicted from a frozen crossing table, out of sample: nothing here is fitted to the
 * sweep (`predict-model.ts`). The one number taken from a workload is its per-op cost, read off the
 * `base` arm; every other arm is then predicted and set against its measurement.
 *
 * `node --experimental-strip-types predict.ts <table.json> <sweep dir> <refills.tsv> [hot sets.tsv] [bound %, default 5]`
 * where the sweep dir holds `g28-<arch>.tsv` and, for a program that closed katybug's stderr,
 * `sortstats-<arch>.tsv` (counters from a run that kept it); the hot sets are needed by a table with a
 * working-set lookup term (HOTCOL=hot50|hot90|hot99|hot999|perp picks the column its H comes from, default
 * hot99). LOOKUP=program prices a lookup at the program's own base-minus-chain saving instead (the chain
 * arm then matches by construction; read the other arms). Exits 1 when an arm is outside the bound.
 */
const [tablePath = '', dir = '', refillPath = '', hotPath = '', boundArg = '5'] = process.argv.slice(2);
const bound = Number(boundArg) / 100;
const table = JSON.parse(readFileSync(tablePath, 'utf8'));
const tsv = (p: string) =>
	readFileSync(p, 'utf8')
		.trim()
		.split('\n')
		.slice(1)
		.map((l) => l.split('\t'));
const refillRows = tsv(refillPath);
const refills = (arch: string, w: string, a: string) => Number(refillRows.find((r) => r[0] === arch && r[1] === w && r[2] === a)?.[3] ?? NaN);
const hotRows = hotPath ? tsv(hotPath) : [];
const hotCol = { hot50: 5, hot90: 6, hot99: 7, hot999: 8, perp: 9 }[process.env.HOTCOL ?? 'hot99'] ?? 7;
const hotOf = (arch: string, w: string, a: string): Hot | undefined => {
	const r = hotRows.find((h) => h[0] === arch && h[1] === w && h[2] === a);
	return r ? { held: Number(r[3]), spread: Number(r[hotCol]) } : undefined;
};

const pct = (x: number) => `${(100 * x).toFixed(1)}%`;
let worst = 0;

for (const arch of ['x86_64', 'aarch64']) {
	const t = table.arch[arch];
	const sweep = `${dir}/g28-${arch}.tsv`;
	const extra = `${dir}/sortstats-${arch}.tsv`;
	let rows: Row[] = parse(readFileSync(sweep, 'utf8'));
	if (existsSync(extra)) rows = withCounters(rows, parse(readFileSync(extra, 'utf8')));
	rows = rows.filter((r) => r.blocks);
	const at = (w: string, a: string) => hotOf(arch, w, a);
	const own = process.env.LOOKUP === 'program' ? ownLookupNs(rows) : undefined;
	const lookupOf = own && ((w: string) => own.get(w));
	const main = predictArch(t, rows, (w, a) => refills(arch, w, a), at, t.refillNs.extra0.ns, lookupOf);
	const far = predictArch(t, rows, (w, a) => refills(arch, w, a), at, t.refillNs.extra32.ns, lookupOf);
	console.log(`\n${arch}: per-arm error of the frozen table against the sweep (bound ${pct(bound)}; refill cost at 0 extra mappings, at 32 in the last column)`);
	console.log('| workload | arm | measured ms | predicted ms | error | layout spread | crossing ms (block / lookup / exit / refill) | ns a lookup | error, refill at 32 extra |');
	console.log('| --- | --- | --- | --- | --- | --- | --- | --- | --- |');
	for (const [i, p] of main.entries())
		console.log(
			`| ${p.workload} | ${p.arm} | ${p.measured.toFixed(0)} | ${p.predicted.toFixed(0)} | ${pct(p.error)} | ${pct(p.spread)} | ${p.parts.blocks.toFixed(1)} / ${p.parts.lookups.toFixed(1)} / ${p.parts.exits.toFixed(1)} / ${p.parts.refills.toFixed(2)} | ${p.lookupNs.toFixed(2)} | ${pct(far[i]!.error)} |`
		);
	console.log(`\n${arch} diagnostic, not part of the prediction: the block cost each arm would need for zero error, and the exit cost that would close the gap with the block cost as tabled`);
	console.log('| workload | arm | blocks M | exits M | implied block ns | implied exit ns |');
	console.log('| --- | --- | --- | --- | --- | --- |');
	for (const p of main.filter((p) => p.arm !== 'chain')) {
		const r = rows.find((r) => r.workload === p.workload && r.arm === p.arm)!;
		const gap = p.measured - p.predicted;
		const implBlock = blockFor(t, r) + (gap * 1e6) / r.blocks;
		const exitNs = traceArms.includes(r.arm) ? t.exitNsByArm[r.arm].ns : 0;
		const implExit = r.exits ? exitNs + (gap * 1e6) / r.exits : NaN;
		console.log(`| ${p.workload} | ${p.arm} | ${(r.blocks / 1e6).toFixed(1)} | ${(r.exits / 1e6).toFixed(2)} | ${implBlock.toFixed(2)} | ${Number.isNaN(implExit) ? '-' : implExit.toFixed(1)} |`);
	}
	console.log(`\n${arch} by arm (mean abs error, worst abs error, over the ${new Set(main.map((p) => p.workload)).size} workloads):`);
	let outside = 0;
	for (const a of ['chain', 'fuse', ...traceArms]) {
		const g = main.filter((p) => p.arm === a);
		const mean = g.reduce((s, p) => s + Math.abs(p.error), 0) / g.length;
		const w = Math.max(...g.map((p) => Math.abs(p.error)));
		worst = Math.max(worst, w);
		outside += g.filter((p) => Math.abs(p.error) > bound).length;
		console.log(`  ${a}: mean ${pct(mean)}, worst ${pct(w)} ${w <= bound ? 'within' : 'OUTSIDE'}`);
	}
	const worstCell = main.reduce((a, b) => (Math.abs(b.error) > Math.abs(a.error) ? b : a));
	console.log(`${arch}: ${outside} of ${main.length} cells outside ${pct(bound)}; worst ${worstCell.workload} ${worstCell.arm} ${pct(worstCell.error)}`);
}
console.log(`\nworst arm error ${pct(worst)} against ${pct(bound)}: ${worst <= bound ? 'within' : 'OUTSIDE'}`);
process.exitCode = worst <= bound ? 0 : 1;
