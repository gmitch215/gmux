import { readFileSync } from 'node:fs';

const [countsPath, reportPath] = process.argv.slice(2);
if (!countsPath || !reportPath) {
	console.error('usage: ceiling.ts <counts.txt from ret-counts.sh> <report.tsv from report.ts>');
	process.exit(2);
}

// ns a block-cache lookup costs from the frozen crossing table; sort shows none, so its upper bound stands in
const LOOKUP: Record<string, Record<string, number>> = {
	x86_64: { bash: 4.3, sqlite: 2.6, awk: 2.6, sort: 4.3 },
	aarch64: { bash: 2.3, sqlite: 3.1, awk: 1.8, sort: 3.1 }
};
// the table's chained block dispatch, and the top of the trace-build block cost it implied per workload
const DISPATCH: Record<string, number> = { x86_64: 9.29, aarch64: 5.26 };
const IMPLIED: Record<string, Record<string, number>> = {
	x86_64: { bash: 14.7, sqlite: 17.3, awk: 23.8, sort: 20.3 },
	aarch64: { bash: 5.5, sqlite: 4.0, awk: 10.3, sort: 11.4 }
};
const SPEC_TOP = 14;
const BAR = 2;

const num = (s: string, re: RegExp) => Number(s.match(re)?.[1]);
const pct = (x: number) => `${(x * 100).toFixed(2)}%`;
const off = new Map<string, number>();
for (const l of readFileSync(reportPath, 'utf8').split('\n').slice(1)) {
	const f = l.split('\t');
	if (f[2] === 'off') off.set(`${f[0]} ${f[1]}`, Number(f[3]));
}

const row = (cells: (string | number)[]) => `| ${cells.join(' | ')} |`;
const a = [
	row(['arch', 'workload', 'off s', 'returns', 'per 1,000 blocks', 'of all lookups', 'IC hit', '>95% one target', '>99%']),
	row(Array(9).fill('---'))
];
const b = [
	row(['arch', 'workload', 'lookup ns', 'IC (hits)', 'IC (every return)', 'trace, table price', 'trace, 14 ns', 'trace, implied top', 'ns per return for 2%']),
	row(Array(9).fill('---'))
];
const over: Record<string, Record<string, number>> = { table: {}, spec: {}, implied: {} };
for (const l of readFileSync(countsPath, 'utf8').split('\n')) {
	const m = l.match(/^(\S+) (\S+): (.*)$/);
	if (!m) continue;
	const [, arch, wl, s] = m;
	const R = num(s, /returns (\d+),/);
	const H = num(s, /last (\d+),/);
	const D = num(s, /in blocks run >= \d+ times (\d+),/);
	const D99 = num(s, /dominant>99% (\d+),/);
	const steps = num(s, /dispatches (\d+),/);
	const lookups = num(s, /lookups (\d+)/);
	const t = off.get(`${arch} ${wl}`)!;
	const k = wl.split('-')[0];
	const L = LOOKUP[arch][k];
	const saved = (n: number, ns: number) => (n * ns * 1e-9) / t;
	const table = saved(D, L + DISPATCH[arch]);
	const spec = saved(D, SPEC_TOP);
	const implied = saved(D, L + IMPLIED[arch][k]);
	a.push(
		row([
			arch,
			wl,
			t.toFixed(3),
			R,
			((R / steps) * 1000).toFixed(0),
			`${((R / lookups) * 100).toFixed(0)}%`,
			`${((H / R) * 100).toFixed(1)}%`,
			`${((D / R) * 100).toFixed(1)}%`,
			`${((D99 / R) * 100).toFixed(1)}%`
		])
	);
	b.push(
		row([
			arch,
			wl,
			L,
			pct(saved(H, L)),
			pct(saved(R, L)),
			pct(table),
			pct(spec),
			pct(implied),
			(((BAR / 100) * t * 1e9) / D).toFixed(1)
		])
	);
	for (const [name, v] of [['table', table], ['spec', spec], ['implied', implied]] as const)
		if (v * 100 >= BAR) over[name][arch] = (over[name][arch] ?? 0) + 1;
}
console.log(a.join('\n'));
console.log();
console.log(b.join('\n'));
console.log();
console.log(`cells with a trace ceiling of ${BAR}% or more, by price: ${JSON.stringify(over)}`);
