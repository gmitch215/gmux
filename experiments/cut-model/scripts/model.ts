import { readFileSync } from 'node:fs';

/**
 * The cut model: time is work inside each execution mode plus every boundary crossing times its
 * transition cost. Checked two ways, each by leave-one-out (a point's prediction comes from a fit
 * without it):
 *
 * - burrow's promotion ladder (B20: zlib deflate, a native fraction f of its dynamic instructions,
 *   V8 on Node 26): r(f) = (1 - f) s_interp + f s_native + crossings tau / t_v8, with tau fitted;
 * - Katybug's trace-length sweep (`experiments/trace-length/scripts/sweep.sh` TSV): a per-op cost
 *   for each workload and one cost a block, a lookup and a side exit shared by all of them, and the
 *   trace length the model would choose against the measured best.
 *
 * `node --experimental-strip-types model.ts <sweep.tsv> [max error %, default 5]`
 */

/** B20's rungs, from the roadmap's measurement (Node 26.10, V8 14.6, paisley-park, solo) */
export const B20 = {
	tV8: 31.6e-3,
	rungs: [
		{ f: 0, r: 13.24, crossings: 0 },
		{ f: 0.74, r: 7.1, crossings: 91105 },
		{ f: 0.77, r: 6.29, crossings: 91105 },
		{ f: 0.8, r: 5.97, crossings: 91105 },
		{ f: 0.815, r: 5.85, crossings: 91105 },
		{ f: 0.867, r: 5.18, crossings: 91105 },
		{ f: 1, r: 1.08, crossings: 14 }
	]
};

/** least squares for x in A x = b, by the normal equations */
export function solve(a: number[][], b: number[]): number[] {
	const n = a[0]!.length;
	const m = Array.from({ length: n }, (_, i) =>
		Array.from({ length: n + 1 }, (_, j) =>
			a.reduce((s, row, k) => s + row[i]! * (j < n ? row[j]! : b[k]!), 0)
		)
	);
	for (let c = 0; c < n; c++) {
		let p = c;
		for (let r = c + 1; r < n; r++) if (Math.abs(m[r]![c]!) > Math.abs(m[p]![c]!)) p = r;
		[m[c], m[p]] = [m[p]!, m[c]!];
		const d = m[c]![c]!;
		if (Math.abs(d) < 1e-300) continue;
		for (let r = 0; r < n; r++) {
			if (r === c) continue;
			const k = m[r]![c]! / d;
			for (let j = c; j <= n; j++) m[r]![j]! -= k * m[c]![j]!;
		}
	}
	return m.map((row, i) => (Math.abs(row[i]!) < 1e-300 ? 0 : row[n]! / row[i]!));
}

/** B20: the two ends measure the modes (all interpreted, all native with 14 crossings), tau is
 * fitted on the mixed rungs, and each mixed rung is predicted from a fit without it */
export function b20(data = B20) {
	const sI = data.rungs.find((r) => r.f === 0)!.r;
	const sN = data.rungs.find((r) => r.f === 1)!.r;
	const mixed = data.rungs.filter((r) => r.f > 0 && r.f < 1);
	// r - (1 - f) sI - f sN = (crossings / tV8) tau
	const fit = (rows: typeof mixed) =>
		solve(
			rows.map((r) => [r.crossings / data.tV8]),
			rows.map((r) => r.r - (1 - r.f) * sI - r.f * sN)
		)[0]!;
	const tau = fit(mixed);
	const loo = mixed.map((r) => {
		const t = fit(mixed.filter((o) => o !== r));
		const want = (1 - r.f) * sI + r.f * sN + (r.crossings / data.tV8) * t;
		return { f: r.f, r: r.r, predicted: want, error: (want - r.r) / r.r };
	});
	return { sInterp: sI, sNative: sN, tauSeconds: tau, loo };
}

export interface Row {
	arch: string;
	workload: string;
	arm: string;
	blocks: number;
	exits: number;
	ops: number;
	lookups: number;
	held: number;
	/** CPU seconds when the TSV has them, else wall */
	seconds: number;
	wall: number;
	/** (slowest - fastest link order) / mean, 0 when the TSV has one layout */
	spread: number;
}

export function parse(tsv: string): Row[] {
	const lines = tsv.trim().split('\n');
	const head = lines[0]!.split('\t');
	return lines.slice(1).map((l) => {
		const f = l.split('\t');
		const get = (k: string) => f[head.indexOf(k)]!;
		const num = (k: string) => Number(get(k));
		return {
			arch: get('arch'),
			workload: get('workload'),
			arm: get('arm'),
			blocks: num('blocks'),
			exits: num('exits'),
			ops: num('ops'),
			lookups: num('lookups'),
			held: num('held'),
			seconds: head.includes('cpu') ? num('cpu') : num('seconds'),
			wall: num('seconds'),
			spread: head.includes('spread') ? num('spread') : 0
		};
	});
}

/** arms built like the default and differing only in dispatch (the others change per-op cost) */
const dispatch = (arm: string) => /^(base|chain|fuse|t\d+)$/.test(arm);

/**
 * One set of crossing costs for every workload: seconds = ops c_op[workload] + blocks c_block +
 * lookups c_lookup + exits c_exit, over the dispatch arms. `base` (the only arm with a lookup per
 * block) is an anchor, always in the fit; every other arm is predicted from a fit without it. The
 * model then picks each workload's arm among fuse (a trace of one block) and the traces, and the
 * pick's measured time is set against the fastest's. Other builds get the per-op cost the shared
 * crossing costs imply
 */
export function sweep(rows: Row[]) {
	const counted = rows.filter((r) => r.blocks); // none when the program closed katybug's stderr
	const names = [...new Set(counted.map((r) => `${r.arch} ${r.workload}`))];
	const name = (r: Row) => `${r.arch} ${r.workload}`;
	const features = (r: Row) => [
		...names.map((n) => (n === name(r) ? r.ops : 0)),
		r.blocks,
		r.lookups,
		r.exits
	];
	const fit = (g: Row[]) =>
		solve(
			g.map(features),
			g.map((r) => r.seconds)
		);
	const predict = (c: number[], r: Row) => features(r).reduce((s, x, i) => s + x * c[i]!, 0);
	const arms = counted.filter((r) => dispatch(r.arm));
	const coef = fit(arms);
	const loo = arms
		.filter((r) => r.arm !== 'base')
		.map((r) => {
			const want = predict(
				fit(arms.filter((o) => o !== r)),
				r
			);
			return { name: name(r), arm: r.arm, seconds: r.seconds, predicted: want, error: (want - r.seconds) / r.seconds };
		});
	const [block, lookup, exit] = coef.slice(names.length);
	const workloads = names.map((n, w) => {
		const g = arms.filter((r) => name(r) === n && (r.arm === 'fuse' || /^t\d+$/.test(r.arm)));
		const chosen = g.reduce((a, b) => (predict(coef, b) < predict(coef, a) ? b : a));
		const best = g.reduce((a, b) => (b.seconds < a.seconds ? b : a));
		const builds = counted
			.filter((r) => name(r) === n && !dispatch(r.arm))
			.map((r) => ({
				arm: r.arm,
				seconds: r.seconds,
				nsPerOp: ((r.seconds - r.blocks * block! - r.lookups * lookup! - r.exits * exit!) / r.ops) * 1e9
			}));
		const spreads = arms
			.filter((r) => name(r) === n)
			.map((r) => r.spread)
			.sort((a, b) => a - b);
		return {
			name: n,
			nsPerOp: coef[w]! * 1e9,
			spread: spreads[spreads.length >> 1] ?? 0,
			chosen: chosen.arm,
			chosenSeconds: chosen.seconds,
			best: best.arm,
			bestSeconds: best.seconds,
			regret: (chosen.seconds - best.seconds) / best.seconds,
			builds
		};
	});
	return { block: block! * 1e9, lookup: lookup! * 1e9, exit: exit! * 1e9, loo, workloads };
}

if (import.meta.main ?? process.argv[1]?.endsWith('model.ts')) {
	const path = process.argv[2];
	const bound = Number(process.argv[3] ?? 5) / 100;
	const pct = (x: number) => `${(100 * x).toFixed(1)}%`;
	const b = b20();
	console.log(`B20: s_interp ${b.sInterp}, s_native ${b.sNative.toFixed(3)}, tau ${(b.tauSeconds * 1e6).toFixed(3)} us a crossing`);
	for (const l of b.loo) console.log(`  f ${l.f}: r ${l.r}, predicted ${l.predicted.toFixed(2)} (${pct(l.error)})`);
	let worst = Math.max(...b.loo.map((l) => Math.abs(l.error)));
	if (path) {
		const s = sweep(parse(readFileSync(path, 'utf8')));
		console.log(`sweep: ns a block ${s.block.toFixed(2)}, a lookup ${s.lookup.toFixed(2)}, a side exit ${s.exit.toFixed(2)}`);
		for (const w of s.workloads) {
			console.log(
				`${w.name}: ns per op ${w.nsPerOp.toFixed(3)}; chosen ${w.chosen} (${w.chosenSeconds} s), fastest ${w.best} (${w.bestSeconds} s), regret ${pct(w.regret)}; median layout spread ${pct(w.spread)}`
			);
			for (const l of s.loo.filter((l) => l.name === w.name))
				console.log(`  ${l.arm}: ${l.seconds} s, predicted ${l.predicted.toFixed(3)} (${pct(l.error)})`);
			for (const b of w.builds) console.log(`  build ${b.arm}: ${b.seconds} s, ns per op ${b.nsPerOp.toFixed(3)}`);
		}
		worst = Math.max(worst, ...s.loo.map((l) => Math.abs(l.error)));
	}
	console.log(`worst leave-one-out error ${pct(worst)} against ${pct(bound)}: ${worst <= bound ? 'within' : 'OUTSIDE'}`);
	process.exitCode = worst <= bound ? 0 : 1;
}
