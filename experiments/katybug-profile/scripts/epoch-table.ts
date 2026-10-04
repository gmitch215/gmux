import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse, verdict, type Row } from '../../aot-oracle/scripts/regs-table.ts';

/**
 * Reads epoch-wasm.ts's logs and prints the table for `on` against `off` under regs-table.ts's rule, with
 * the build-noise floor (the `off` arm of each layout against layout 0) beside it. A run taken at a load
 * above `maxLoad` is dropped from its row (a smoke run) and counted.
 *
 * `epoch-table.ts <dir with epoch-*.log>`
 */
const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]!;

export function settle(rows: Row[], maxLoad = 4): { rows: Row[]; dropped: number } {
	let dropped = 0;
	const kept = rows.map((r) => {
		if (r.loads.length !== r.runs.length) return r;
		const runs = r.runs.filter((_, i) => r.loads[i]! <= maxLoad);
		dropped += r.runs.length - runs.length;
		if (!runs.length || runs.length === r.runs.length) return r;
		const median_ = median(runs);
		return { ...r, runs, median: median_, spread: (Math.max(...runs) - Math.min(...runs)) / median_, loads: r.loads.filter((l) => l <= maxLoad) };
	});
	return { rows: kept, dropped };
}

export function floor(rows: Row[], arm: string): { workload: string; layout: number; ratio: number }[] {
	return rows
		.filter((r) => r.arm === arm && r.layout > 0)
		.flatMap((r) => {
			const base = rows.find((b) => b.arm === arm && b.workload === r.workload && b.layout === 0);
			return base ? [{ workload: r.workload, layout: r.layout, ratio: r.median / base.median }] : [];
		});
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
	const dir = process.argv[2] ?? '.';
	const all = readdirSync(dir)
		.filter((f) => /^epoch-\d+-\w+\.log$/.test(f))
		.sort()
		.flatMap((f) => parse(readFileSync(join(dir, f), 'utf8')));
	const maxLoad = Number(process.env.MAXLOAD ?? 4);
	const { rows, dropped } = settle(
		all.filter((r) => r.arm !== 'native'),
		maxLoad
	);
	const native = all.filter((r) => r.arm === 'native');
	const pct = (r?: Row) => (r ? (100 * r.spread).toFixed(1) : '-');
	const lo = (r?: Row) => (r?.loads.length ? `${Math.min(...r.loads)}-${Math.max(...r.loads)}` : '-');
	console.log('| workload | layout | off ms | on ms | on / off | n | spread (off, on) % | load1 (off, on) | md5 equal native |');
	console.log('| --- | --- | --- | --- | --- | --- | --- | --- | --- |');
	for (const k of [...new Set(rows.map((r) => `${r.workload}\t${r.layout}`))]) {
		const [w, l] = k.split('\t') as [string, string];
		const at = (arm: string) => rows.find((r) => r.workload === w && r.layout === Number(l) && r.arm === arm);
		const [off, on] = [at('off'), at('on')];
		const nat = native.find((r) => r.workload === w && r.layout === Number(l));
		const same = nat && off && on && off.md5 === nat.md5 && on.md5 === nat.md5;
		console.log(`| ${w} | ${l} | ${off?.median ?? '-'} | ${on?.median ?? '-'} | ${off && on ? (on.median / off.median).toFixed(4) : '-'} | ${on?.runs.length ?? '-'} | ${pct(off)}, ${pct(on)} | ${lo(off)}, ${lo(on)} | ${same ? 'yes' : 'NO'} |`);
	}
	const v = verdict([...rows, ...native], 'on', 'off');
	console.log(`\non against off: exact ${v.exact}, geomean ${v.geomean.toFixed(4)} over ${new Set(rows.map((r) => r.workload)).size} workloads (mean spread ${(100 * v.meanSpread).toFixed(1)}%), slower beyond spread: ${v.slower.join(' ') || 'none'}; earns the default: ${v.earns}`);
	const f = floor(rows, 'off');
	if (f.length) {
		const rs = f.map((x) => x.ratio);
		console.log(`\nbuild-noise floor, off at layout n / off at layout 0: ${f.map((x) => `${x.workload}/${x.layout} ${x.ratio.toFixed(4)}`).join(', ')}; range ${Math.min(...rs).toFixed(4)}-${Math.max(...rs).toFixed(4)}`);
	}
	console.log(`\nruns dropped at load above ${maxLoad} (smoke): ${dropped}`);
}
