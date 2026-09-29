import { readFileSync } from 'node:fs';

/**
 * `report.ts <plan.json> <run.json>...`: one markdown table of every planned set against what
 * `ladder.ts run` measured (LADDER_JSON of each repeat; the median rung is used, the spread is
 * (max - min) / median over the repeats). Measured boundary CPU is the residual after the
 * interpreted and native shares priced at the ends' per-instruction costs, so it carries every
 * error of that split; the predicted one is crossings x tau.
 */
const [planPath, ...runPaths] = process.argv.slice(2);
if (!planPath || !runPaths.length) throw new Error('usage: report.ts <plan.json> <run.json>...');
const plan = JSON.parse(readFileSync(planPath, 'utf8')) as {
	params: { sI: number; sN: number; tau: number };
	total: number;
	bytes: number;
	plans: {
		policy: string;
		budget: number;
		set: string[];
		rung: string;
		predicted: { interp: number; native: number; crossings: number; boundary: number; crossingBytes: number; bytes: number; seconds: number };
	}[];
};
interface Run {
	n: number;
	v8ms: number;
	rows: { label: string; ms: number; crossings: number }[];
}
const runs = runPaths.map((p) => JSON.parse(readFileSync(p, 'utf8')) as Run);
const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]!;
const spread = (xs: number[]) => (Math.max(...xs) - Math.min(...xs)) / median(xs);
const { n } = runs[0]!;
const v8 = median(runs.map((r) => r.v8ms));
const { tau } = plan.params;
const row = (r: Run, label: string) => r.rows.find((x) => x.label === label)!;
// every repeat carries its own ends, so each is priced with the interpreted and native cost per instruction read beside it
const perRepeat = (r: Run) => ({ sI: row(r, 'interpreted').ms / 1e3 / n / plan.total, sN: row(r, 'native').ms / 1e3 / n / plan.total });
const measured = (label: string) => {
	const rs = runs.map((r) => row(r, label));
	const rr = rs.map((x, i) => x.ms / runs[i]!.v8ms);
	return { r: median(rr), spread: spread(rr), crossings: median(rs.map((x) => x.crossings)) / n, ms: median(rs.map((x) => x.ms)) / n };
};
const seen = new Set<string>();
const lines: string[] = [];
const fits: { residual: number; crossings: number }[] = [];
for (const pl of plan.plans) {
	const m = measured(pl.rung);
	const shares = runs.map((r) => {
		const { sI, sN } = perRepeat(r);
		return pl.predicted.interp * sI + pl.predicted.native * sN;
	});
	const pr = median(runs.map((r, i) => ((shares[i]! + pl.predicted.boundary) * 1e3 * n) / r.v8ms));
	const boundaryMeasured = median(runs.map((r, i) => (row(r, pl.rung).ms / n - shares[i]! * 1e3)));
	if (!seen.has(pl.rung) && m.crossings >= 1000) fits.push({ residual: boundaryMeasured, crossings: m.crossings });
	seen.add(pl.rung);
	lines.push(
		`| ${pl.policy} | ${pl.budget} | ${pl.set.length} | ${pl.predicted.bytes} | ${pr.toFixed(2)} | ${m.r.toFixed(2)} (${(100 * m.spread).toFixed(0)}%) | ${((100 * (pr - m.r)) / m.r).toFixed(1)}% | ${pl.predicted.crossings} | ${m.crossings.toFixed(0)} | ${(pl.predicted.boundary * 1e3).toFixed(2)} | ${boundaryMeasured.toFixed(2)} | ${pl.predicted.crossingBytes} | ${pl.rung} |`
	);
}
const fit = fits.reduce((s, f) => s + f.residual * f.crossings, 0) / fits.reduce((s, f) => s + f.crossings ** 2, 0) / 1e3;
console.log(`V8 ${v8.toFixed(2)} ms per ${n} units; plan-time sI ${(plan.params.sI * 1e9).toFixed(3)} ns, sN ${(plan.params.sN * 1e9).toFixed(3)} ns per instruction (each repeat is priced with its own ends), tau ${(tau * 1e9).toFixed(1)} ns; ${runs.length} repeats`);
console.log('| policy | budget | functions | code bytes | predicted r | measured r (spread) | error | predicted crossings | measured crossings | predicted boundary ms | measured boundary ms | crossing bytes | rung |');
console.log('| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |');
for (const l of lines) console.log(l);
console.log(`\nends: interpreted r ${measured('interpreted').r.toFixed(2)} (${(100 * measured('interpreted').spread).toFixed(0)}%), native r ${measured('native').r.toFixed(2)} (${(100 * measured('native').spread).toFixed(0)}%)`);
console.log(fits.length ? `tau fitted on the measured boundary residuals of the ${fits.length} sets with 1,000 or more crossings a unit: ${(fit * 1e9).toFixed(1)} ns` : 'no set has 1,000 crossings a unit, so no tau is fitted');
