import { existsSync, readFileSync } from 'node:fs';
import { choose, split, type Graph, type Params, type Policy } from '../../promotion-cut/scripts/plan.ts';

/**
 * What a cheaper crossing buys the planner: `plan5.ts [--pure <ns>]...` predicts r for zlib and zstd at tau 270 (the
 * calibration's fallback), at each guest's own calibration and at every `--pure` figure given (measured by
 * rt.ts), at budgets 1, 0.1, 0.03 and 0.015, beside the r those plans measured in earlier runs where a report has the
 * row. The sets still obey the closure rule (plan.ts); only tau moves.
 */
const root = new URL('../../..', import.meta.url).pathname;
const pure = process.argv.slice(2).flatMap((a, i, all) => (all[i - 1] === '--pure' ? [Number(a)] : []));
const budgets = [1, 0.1, 0.03, 0.015];
const policies: Policy[] = ['hottest', 'mincut'];
const guests = {
	zlib: { dir: 'build/batch/run3/B31/acc/zlib-auto', reports: ['build/batch/run3/B31/acc/zlib-auto/zlib.report.md'] },
	zstd: { dir: 'build/batch/run3/B31/acc/zstd-auto', reports: ['build/batch/run2/B30/zstd-t292/zstd.report.md', 'build/batch/run3/B31/acc/zstd-auto/zstd.report.md'] }
};

const measured = (path: string) => {
	const rows = new Map<string, string>();
	if (!existsSync(join(path))) return rows;
	for (const line of readFileSync(join(path), 'utf8').split('\n')) {
		const c = line.split('|').map((s) => s.trim());
		if (c.length > 7 && (policies as string[]).includes(c[1]!)) rows.set(`${c[1]}|${c[2]}`, c[6]!);
	}
	return rows;
};
function join(p: string) {
	return p.startsWith('/') ? p : `${root}${p}`;
}

console.log('| guest | tau source | tau ns | budget | policy | functions | predicted crossings | predicted r (predicted) | measured r, earlier runs (their own tau) |');
console.log('| --- | --- | --- | --- | --- | --- | --- | --- | --- |');
for (const [name, g] of Object.entries(guests)) {
	const graph = JSON.parse(readFileSync(join(`${g.dir}/${name}.graph.json`), 'utf8')) as Graph & { total: number; bytes: number };
	const ends = JSON.parse(readFileSync(join(`${g.dir}/${name}.ends.json`), 'utf8')) as { n: number; v8ms: number; rows: { ms: number }[] };
	const cal = JSON.parse(readFileSync(join(`${g.dir}/calibration/calibration.json`), 'utf8')) as { tau_ns?: number };
	const reports = g.reports.map(measured);
	const perUnit = (ms: number) => ms / 1e3 / ends.n;
	const taus = [
		{ label: 'fallback', ns: 270 },
		...(cal.tau_ns ? [{ label: 'guest calibration', ns: Math.round(cal.tau_ns * 10) / 10 }] : []),
		...pure.map((ns) => ({ label: 'measured pure wasm', ns }))
	];
	for (const t of taus)
		for (const f of budgets)
			for (const policy of policies) {
				const p: Params = { sI: perUnit(ends.rows[0]!.ms) / graph.total, sN: perUnit(ends.rows.at(-1)!.ms) / graph.total, tau: t.ns * 1e-9, lambda: 0 };
				const set = choose(policy, graph, p, f * graph.bytes);
				const s = split(graph, set, p);
				const r = (s.seconds * 1e3 * ends.n) / ends.v8ms;
				const got = reports.map((m) => m.get(`${policy}|${f}`) ?? '-').join(' / ');
				console.log(`| ${name} | ${t.label} | ${t.ns} | ${f} | ${policy} | ${set.size} | ${s.crossings} | ${r.toFixed(2)} | ${got} |`);
			}
}
