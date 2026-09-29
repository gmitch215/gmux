import { readFileSync } from 'node:fs';
import { parse, type Row } from './model.ts';

/**
 * G28's arms predicted from the frozen crossing table, out of sample: nothing here is fitted to the
 * sweep. The one number taken from a workload is its per-op cost, read off the `base` arm
 * (base = F + op ops + block blocks + lookup lookups + refill refills, solved for op with the
 * table's other costs); every other arm is then predicted and set against its measurement.
 *
 * `node --experimental-strip-types predict.ts <table.json> <sweep dir> <refills.tsv> [bound %, default 5]`
 * where the sweep dir holds `g28-<arch>.tsv`; exits 1 when an arm is outside the bound.
 */
const [tablePath = '', dir = '', refillPath = '', boundArg = '5'] = process.argv.slice(2);
const bound = Number(boundArg) / 100;
const table = JSON.parse(readFileSync(tablePath, 'utf8'));
const refillRows = readFileSync(refillPath, 'utf8')
	.trim()
	.split('\n')
	.slice(1)
	.map((l) => l.split('\t'));
const refills = (arch: string, w: string, a: string) => Number(refillRows.find((r) => r[0] === arch && r[1] === w && r[2] === a)?.[3] ?? NaN);

const M = 1e6;
const pct = (x: number) => `${(100 * x).toFixed(1)}%`;
const traceArms = ['t2', 't4', 't8', 't16', 't32', 't64'];
let worst = 0;

for (const arch of ['x86_64', 'aarch64']) {
	const t = table.arch[arch];
	const rows: Row[] = parse(readFileSync(`${dir}/g28-${arch}.tsv`, 'utf8')).filter((r) => r.blocks);
	const block = (a: string) => (a === 'base' || a === 'chain' ? t.blockNs.chain.ns : a === 'fuse' ? t.blockNs.fuse.ns : t.blockNs.trace.ns);
	const exit = (a: string) => (traceArms.includes(a) ? t.exitNsByArm[a].ns : 0);
	const parts = (r: Row, refillNs: number) => {
		const rf = refills(arch, r.workload, r.arm);
		return {
			blocks: (block(r.arm) * r.blocks) / M,
			lookups: (t.lookupNs.ns * r.lookups) / M,
			exits: (exit(r.arm) * r.exits) / M,
			refills: (refillNs * rf) / M,
			rf
		};
	};
	const predict = (refillNs: number) => {
		const out: { workload: string; arm: string; measured: number; predicted: number; error: number; spread: number; parts: ReturnType<typeof parts> }[] = [];
		for (const w of [...new Set(rows.map((r) => r.workload))]) {
			const base = rows.find((r) => r.workload === w && r.arm === 'base')!;
			const pb = parts(base, refillNs);
			const opNs = (base.wall * 1e3 - t.fixedMs.base - pb.blocks - pb.lookups - pb.refills) / (base.ops / M);
			for (const r of rows.filter((r) => r.workload === w && r.arm !== 'base')) {
				const p = parts(r, refillNs);
				const predicted = t.fixedMs[r.arm] + (opNs * r.ops) / M + p.blocks + p.lookups + p.exits + p.refills;
				const measured = r.wall * 1e3;
				out.push({ workload: w, arm: r.arm, measured, predicted, error: (predicted - measured) / measured, spread: r.spread, parts: p });
			}
		}
		return out;
	};
	const main = predict(t.refillNs.extra0.ns);
	const far = predict(t.refillNs.extra32.ns);
	console.log(`\n${arch}: per-arm error of the frozen table against the sweep (bound ${pct(bound)}; refill cost at 0 extra mappings, at 32 in the last column)`);
	console.log('| workload | arm | measured ms | predicted ms | error | layout spread | crossing ms (block / lookup / exit / refill) | error, refill at 32 extra |');
	console.log('| --- | --- | --- | --- | --- | --- | --- | --- |');
	for (const [i, p] of main.entries())
		console.log(
			`| ${p.workload} | ${p.arm} | ${p.measured.toFixed(0)} | ${p.predicted.toFixed(0)} | ${pct(p.error)} | ${pct(p.spread)} | ${p.parts.blocks.toFixed(1)} / ${p.parts.lookups.toFixed(1)} / ${p.parts.exits.toFixed(1)} / ${p.parts.refills.toFixed(2)} | ${pct(far[i]!.error)} |`
		);
	console.log(`\n${arch} diagnostic, not part of the prediction: the block cost each arm would need for zero error (table: chain ${t.blockNs.chain.ns.toFixed(2)}, fuse ${t.blockNs.fuse.ns.toFixed(2)}, trace ${t.blockNs.trace.ns.toFixed(2)} ns), and the exit cost that would close the gap with the block cost as tabled`);
	console.log('| workload | arm | blocks M | exits M | implied block ns | implied exit ns |');
	console.log('| --- | --- | --- | --- | --- | --- |');
	for (const p of main.filter((p) => p.arm !== 'chain')) {
		const r = rows.find((r) => r.workload === p.workload && r.arm === p.arm)!;
		const gap = p.measured - p.predicted;
		const implBlock = block(p.arm) + (gap * M) / r.blocks;
		const implExit = r.exits ? exit(p.arm) + (gap * M) / r.exits : NaN;
		console.log(`| ${p.workload} | ${p.arm} | ${(r.blocks / M).toFixed(1)} | ${(r.exits / M).toFixed(2)} | ${implBlock.toFixed(2)} | ${Number.isNaN(implExit) ? '-' : implExit.toFixed(1)} |`);
	}
	console.log(`\n${arch} by arm (mean abs error, worst abs error, over the ${new Set(main.map((p) => p.workload)).size} workloads):`);
	for (const a of ['chain', 'fuse', ...traceArms]) {
		const g = main.filter((p) => p.arm === a);
		const mean = g.reduce((s, p) => s + Math.abs(p.error), 0) / g.length;
		const w = Math.max(...g.map((p) => Math.abs(p.error)));
		worst = Math.max(worst, w);
		console.log(`  ${a}: mean ${pct(mean)}, worst ${pct(w)} ${w <= bound ? 'within' : 'OUTSIDE'}`);
	}
}
console.log(`\nworst arm error ${pct(worst)} against ${pct(bound)}: ${worst <= bound ? 'within' : 'OUTSIDE'}`);
process.exitCode = worst <= bound ? 0 : 1;
