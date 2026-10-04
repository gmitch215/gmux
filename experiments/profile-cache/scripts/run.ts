import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import type { Calibration } from '../../promotion-cut/scripts/calibration.ts';
import { load, loadRungs, save, saveRungs, type ProfileRecord } from './cache.ts';
import { graphTs, ladder, node, planTs, prepareRungs, provenanceOf, repo, tauTs } from './pipeline.ts';

/**
 * Time to a ready profile for each guest, cold against from the cache: what a fresh process spends
 * getting the weighted call graph, the timing of the ladder's two ends, the plan and target sets and the
 * mined fusion catalog, against what one spends loading them. Each cold run saves its record; the cached
 * run loads it back, and the plan derived again from the cached graph and ends must equal the cached plan.
 *
 * `BURROW_ROOT=<burrow tree> BURROW_DIST=<burrow dist> run.ts <cache dir> <out dir> <tau ns | auto> <budget
 * fractions, comma separated> <repeats> <guest.wasm>...` (needs wasm-tools, bun for burrow's miner)
 */
const [cacheDir = '', outDir = '', tau = '', fractions = '', repeatsArg = '', ...guests] = process.argv.slice(2);
const root = process.env.BURROW_ROOT;
const dist = process.env.BURROW_DIST;
if (!root || !dist || !cacheDir || !outDir || !tau || !fractions || !repeatsArg || !guests.length)
	throw new Error('usage: BURROW_ROOT=<dir> BURROW_DIST=<dir> run.ts <cache dir> <out dir> <tau ns> <fractions> <repeats> <guest.wasm>...');
const repeats = Number(repeatsArg);

const lock = process.env.BENCH_LOCK ?? join(repo, 'build/batch/mac-bench.lock');
const mine = join(root, 'tools/interp/mine-catalog.sh');

const run = (cmd: string, args: string[], env: Record<string, string> = {}) =>
	execFileSync(cmd, args, { env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'inherit'] }).toString();
const nodeRun = (script: string, args: string[], env?: Record<string, string>) => run(node[0]!, [...node.slice(1), script, ...args], env);
const time = <T>(f: () => T) => {
	const t = performance.now();
	const v = f();
	return { ms: performance.now() - t, v };
};
const read = (...p: string[]) => readFileSync(join(...p), 'utf8');

const { record: current, rungs: currentRungs } = await provenanceOf(root, tau, fractions);

const fresh = (guest: string, dir: string): { ms: Record<string, number>; record: ProfileRecord; rungs: Record<string, Uint8Array> } => {
	mkdirSync(dir, { recursive: true });
	const ms: Record<string, number> = {};
	ms.graph = time(() => nodeRun(graphTs, [guest, join(dir, 'graph.json')])).ms;
	writeFileSync(join(dir, 'empty.json'), '{}');
	ms.prepare = time(() => nodeRun(ladder, ['prepare', guest, join(dir, 'ends'), join(dir, 'empty.json')])).ms;
	ms.ends = time(() => nodeRun(ladder, ['run', join(dir, 'ends'), dist, '5'], { LADDER_JSON: join(dir, 'ends.json') })).ms;
	let tauArg = tau;
	let calibration: Calibration | undefined;
	if (tau === 'auto') {
		ms.calibrate = time(() => nodeRun(tauTs, ['calibrate', guest, join(dir, 'graph.json'), join(dir, 'cal'), dist])).ms;
		calibration = JSON.parse(read(dir, 'cal/calibration.json')) as Calibration;
		tauArg = `auto:${join(dir, 'cal/calibration.json')}`;
	}
	ms.plan = time(() => nodeRun(planTs, [join(dir, 'graph.json'), join(dir, 'ends.json'), join(dir, 'plan'), tauArg, ...fractions.split(',')])).ms;
	ms.catalog = time(() => run('bash', [mine, join(dir, 'catalog.json'), `${guest}:run:1`])).ms;
	let rungs: Record<string, Uint8Array> = {};
	ms.rungs = time(() => (rungs = prepareRungs(guest, read(dir, 'plan/sets.json'), join(dir, 'rungs')))).ms;
	return {
		ms,
		rungs,
		record: { graph: read(dir, 'graph.json'), ends: read(dir, 'ends.json'), plan: read(dir, 'plan/plan.json'), sets: read(dir, 'plan/sets.json'), catalog: read(dir, 'catalog.json'), ...(calibration ? { calibration } : {}) }
	};
};

const cached = (guest: string, dir: string) => {
	mkdirSync(dir, { recursive: true });
	return time(() => {
		const got = load(cacheDir, readFileSync(guest), current());
		if ('refused' in got) throw new Error(`refused: ${got.refused}`);
		const r = got.record;
		mkdirSync(join(dir, 'plan'), { recursive: true });
		writeFileSync(join(dir, 'graph.json'), r.graph);
		writeFileSync(join(dir, 'ends.json'), r.ends);
		writeFileSync(join(dir, 'plan/plan.json'), r.plan);
		writeFileSync(join(dir, 'plan/sets.json'), r.sets);
		writeFileSync(join(dir, 'catalog.json'), r.catalog!);
		if (r.calibration) {
			mkdirSync(join(dir, 'cal'), { recursive: true });
			writeFileSync(join(dir, 'cal/calibration.json'), JSON.stringify(r.calibration));
		}
		return r;
	});
};

const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]!;
const spread = (xs: number[]) => (Math.max(...xs) - Math.min(...xs)) / median(xs);
const rows: string[] = [];
mkdirSync(outDir, { recursive: true });

for (const guest of guests) {
	const name = basename(guest, '.wasm');
	const bytes = readFileSync(guest);
	const cold: Record<string, number[]> = { graph: [], prepare: [], ends: [], calibrate: [], plan: [], catalog: [], rungs: [], total: [] };
	const warm: number[] = [];
	const rungsWarm: number[] = [];
	let rungBytes = 0;
	const mismatches: string[] = [];
	for (let k = 0; k < repeats; k++) {
		const dir = join(outDir, `${name}.cold${k}`);
		let f: ReturnType<typeof fresh>;
		mkdirSync(lock.replace(/[^/]+$/, ''), { recursive: true });
		for (;;) {
			try {
				mkdirSync(lock);
				break;
			} catch {
				run('sleep', ['20']);
			}
		}
		try {
			f = fresh(guest, dir);
		} finally {
			rmSync(lock, { recursive: true });
		}
		for (const [p, v] of Object.entries(f.ms)) cold[p]!.push(v);
		cold.total!.push(Object.values(f.ms).reduce((s, x) => s + x, 0));
		save(cacheDir, bytes, f.record, current());
		saveRungs(cacheDir, bytes, f.record.sets, f.rungs, currentRungs());

		const c = cached(guest, join(outDir, `${name}.warm${k}`));
		warm.push(c.ms);
		const rw = time(() => loadRungs(cacheDir, bytes, f.record.sets, currentRungs()));
		if (!('files' in rw.v)) mismatches.push(`${name} run ${k}: rungs refused: ${rw.v.refused}`);
		else {
			rungsWarm.push(rw.ms);
			rungBytes = Object.values(rw.v.files).reduce((s, b) => s + b.length, 0);
			for (const [file, b] of Object.entries(f.rungs)) if (!Buffer.from(b).equals(rw.v.files[file] ?? new Uint8Array())) mismatches.push(`${name} run ${k}: cached ${file} differs from the cold run's`);
		}
		for (const key of ['graph', 'ends', 'plan', 'sets', 'catalog'] as const) if (c.v[key] !== f.record[key]) mismatches.push(`${name} run ${k}: cached ${key} differs from the cold run's`);
		const again = mkdtempSync(join(tmpdir(), 'profile-cache-plan-'));
		const warmDir = join(outDir, `${name}.warm${k}`);
		nodeRun(planTs, [join(warmDir, 'graph.json'), join(warmDir, 'ends.json'), again, tau === 'auto' ? `auto:${join(warmDir, 'cal/calibration.json')}` : tau, ...fractions.split(',')]);
		if (read(again, 'plan.json') !== c.v.plan || read(again, 'sets.json') !== c.v.sets) mismatches.push(`${name} run ${k}: plan derived again from the cached graph and ends differs`);
		rmSync(again, { recursive: true });
	}
	const m = (xs: number[]) => `${median(xs).toFixed(1)} [${(100 * spread(xs)).toFixed(0)}%]`;
	rows.push(
		`| ${name} | ${m(cold.graph!)} | ${m(cold.prepare!)} | ${m(cold.ends!)} | ${m(cold.calibrate!)} | ${m(cold.plan!)} | ${m(cold.catalog!)} | ${m(cold.rungs!)} | ${m(cold.total!)} | ${m(warm)} | ${m(rungsWarm)} | ${(rungBytes / 1024).toFixed(0)} KB |`
	);
	for (const x of mismatches) console.error(`MISMATCH ${x}`);
	writeFileSync(join(outDir, `${name}.json`), JSON.stringify({ cold, warm, rungsWarm, rungBytes, mismatches }, null, '\t'));
}
console.log('| guest | graph | prepare | ends | calibrate | plan | catalog | planned rungs | cold total | cached record | cached rungs | rung bytes |');
console.log('| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |');
for (const r of rows) console.log(r);
