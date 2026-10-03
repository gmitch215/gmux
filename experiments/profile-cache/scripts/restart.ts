import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { loadavg, tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { load, rungsOrPrepare } from './cache.ts';
import { node, prepareRungs, provenanceOf, repo } from './pipeline.ts';

/**
 * Process start to the first promoted call after a restart, for a guest whose record is already cached.
 * Arm `cache` takes the planned sets' rungs from the cache; arm `prepare` rebuilds them with ladder.ts
 * prepare, as a restart that cached only the record would. Each sample is a fresh node process; every
 * cached rung is then run against V8 outside the timed part.
 *
 * `BURROW_ROOT=<burrow tree> BURROW_DIST=<burrow dist> restart.ts <cache dir> <tau ns> <fractions>
 * <repeats> <guest.wasm>...` (the cache dir filled by run.ts with the same tau and fractions)
 */
const [first = '', ...rest] = process.argv.slice(2);
const root = process.env.BURROW_ROOT;
const dist = process.env.BURROW_DIST;
if (!root || !dist) throw new Error('usage: BURROW_ROOT=<dir> BURROW_DIST=<dir> restart.ts <cache dir> <tau ns> <fractions> <repeats> <guest.wasm>...');

if (first === 'child') {
	const [arm = '', cacheDir = '', tau = '', fractions = '', guest = ''] = rest;
	const bytes = readFileSync(guest);
	const mark: Record<string, number> = {};
	const { record, rungs } = await provenanceOf(root, tau, fractions);
	mark.imports = performance.now();
	const got = load(cacheDir, bytes, record());
	if ('refused' in got) throw new Error(`record refused: ${got.refused}`);
	mark.record = performance.now();
	const sets = got.record.sets;
	const tmp = mkdtempSync(join(tmpdir(), 'profile-cache-restart-'));
	const from =
		arm === 'cache'
			? rungsOrPrepare(cacheDir, bytes, sets, rungs(), () => prepareRungs(guest, sets, tmp))
			: { files: prepareRungs(guest, sets, tmp), source: 'prepare' as const, refused: undefined };
	if (arm === 'cache' && from.source !== 'cache') throw new Error(`rungs refused: ${from.refused}`);
	mark.rungs = performance.now();

	const { createInterpreter } = await import(`${dist}/interpret.js`);
	const wasm3Module = new WebAssembly.Module(readFileSync(`${dist}/vendor/wasm3.wasm`));
	const manifest = JSON.parse(Buffer.from(from.files['rungs.json']!).toString()) as { rungs: { rung: number; imports: Record<string, string> }[] };
	const numbers = manifest.rungs.map((r) => r.rung).filter((k) => from.files[`rung${k}.interp.wasm`]);
	const call = async (k: number, n: number) => {
		const vm = await createInterpreter({ module: wasm3Module });
		let native: Record<string, (...a: number[]) => number> = {};
		const imports = Object.fromEntries(
			Object.entries(manifest.rungs.find((r) => r.rung === k)!.imports).map(([name, signature]) => [name, { signature, fn: (...args: number[]) => native[`f_${name}`]!(...args) }])
		);
		const g = vm.load(new Uint8Array(from.files[`rung${k}.interp.wasm`]!), { imports: { native: imports } });
		const memory = (vm as unknown as { shim: { memory: WebAssembly.Memory } }).shim.memory;
		const base = new WebAssembly.Global({ value: 'i32', mutable: false }, g.memory().byteOffset);
		native = new WebAssembly.Instance(new WebAssembly.Module(from.files[`rung${k}.native.wasm`]!), { env: { memory, base } }).exports as typeof native;
		mark.instance ??= performance.now();
		return g.call('run', n) >>> 0;
	};
	const firstValue = await call(numbers[0]!, 1);
	mark.call = performance.now();

	const v8 = new WebAssembly.Instance(new WebAssembly.Module(bytes)).exports as Record<string, (n: number) => number>;
	if (firstValue !== v8.run!(1) >>> 0) throw new Error(`rung ${numbers[0]}: first call differs from v8`);
	const reference = v8.run!(2) >>> 0;
	for (const k of numbers) if ((await call(k, 2)) !== reference) throw new Error(`rung ${k}: differs from v8`);
	console.log(JSON.stringify({ ...mark, rungsCount: numbers.length, source: from.source }));
	rmSync(tmp, { recursive: true });
} else {
	const [cacheDir = '', tau = '', fractions = '', repeatsArg = '', ...guests] = [first, ...rest];
	if (!cacheDir || !tau || !fractions || !repeatsArg || !guests.length) throw new Error('usage: BURROW_ROOT=<dir> BURROW_DIST=<dir> restart.ts <cache dir> <tau ns> <fractions> <repeats> <guest.wasm>...');
	const repeats = Number(repeatsArg);
	const lock = process.env.BENCH_LOCK ?? join(repo, 'build/batch/mac-bench.lock');
	const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]!;
	const spread = (xs: number[]) => (Math.max(...xs) - Math.min(...xs)) / median(xs);
	const m = (xs: number[]) => `${median(xs).toFixed(1)} [${(100 * spread(xs)).toFixed(0)}%]`;
	mkdirSync(lock.replace(/[^/]+$/, ''), { recursive: true });
	for (;;) {
		try {
			mkdirSync(lock);
			break;
		} catch {
			spawnSync('sleep', ['10']);
		}
	}
	const out: string[] = [];
	const failures: string[] = [];
	try {
		const phaseNames = ['imports', 'record', 'rungs', 'instance', 'call'];
		const samples: Record<string, { wall: number[]; call: number[]; phases: Record<string, number[]>; load: number[] }> = {};
		for (const guest of guests)
			for (const arm of ['cache', 'prepare']) samples[`${guest} ${arm}`] = { wall: [], call: [], phases: Object.fromEntries(phaseNames.map((p) => [p, []])), load: [] };
		// guests and arms are interleaved per repeat so a drift in the machine's load hits all of them alike
		for (let k = 0; k < repeats; k++) {
			for (const guest of guests) {
				for (const arm of k % 2 ? ['prepare', 'cache'] : ['cache', 'prepare']) {
					const s = samples[`${guest} ${arm}`]!;
					const t = performance.now();
					const r = spawnSync(node[0]!, [...node.slice(1), new URL(import.meta.url).pathname, 'child', arm, cacheDir, tau, fractions, guest], { env: process.env, encoding: 'utf8' });
					const wall = performance.now() - t;
					if (r.status !== 0) {
						failures.push(`${basename(guest)} ${arm} run ${k}: ${r.stderr.trim().split('\n').at(-1)}`);
						continue;
					}
					const c = JSON.parse(r.stdout.trim().split('\n').at(-1)!) as Record<string, number>;
					s.wall.push(wall);
					s.call.push(c.call!);
					s.load.push(loadavg()[0]!);
					let prev = 0;
					for (const p of phaseNames) {
						s.phases[p]!.push(c[p]! - prev);
						prev = c[p]!;
					}
				}
			}
		}
		for (const guest of guests)
			for (const arm of ['cache', 'prepare']) {
				const s = samples[`${guest} ${arm}`]!;
				if (!s.call.length) continue;
				const ph = s.phases;
				out.push(
					`| ${basename(guest, '.wasm')} | ${arm} | ${s.call.length} | ${m(s.call)} | ${m(ph.imports!)} | ${m(ph.record!)} | ${m(ph.rungs!)} | ${m(ph.instance!)} | ${m(ph.call!)} | ${m(s.wall)} | ${median(s.load).toFixed(2)} |`
				);
			}
	} finally {
		rmSync(lock, { recursive: true });
	}
	console.log('| guest | rungs from | n | process start to first promoted call (ms) | boot, imports, provenance | record load | rungs | interpreter and instances | first call | spawn to exit with the exactness check | load avg |');
	console.log('| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |');
	for (const r of out) console.log(r);
	for (const f of failures) console.error(`FAILED ${f}`);
	if (failures.length) process.exit(1);
}
