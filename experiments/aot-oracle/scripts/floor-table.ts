import { readFileSync } from 'node:fs';

/**
 * region-time.sh's sample file as the floor table of one workload: each arm's whole-workload `r` against the
 * binary of the same rounds, and the share of the as-built excess each arm removes, with the spread over the
 * rounds. A round is kept for an arm when its first quiet attempt succeeded, and a ratio uses only the rounds where
 * both of its arms were kept. The first (warm) run of an arm is listed apart and never enters a ratio.
 *
 * `floor-table.ts <samples> <workload> [--quiet=0.5] [--form2=<name>] <name>=<arm label as sampled>...`
 * The names `binary` and `interp` are the controls (labels `binary` and `interp`); `a0` is the as-built arm
 * the shares are taken against and `a4` the combined one. `--form2` names the arm that changes only the form to 2,
 * for the sum of the single arms a4 is compared with.
 *
 * `floor-table.ts --perf <perf.csv> <guest instructions>` tables perf.sh's counters per guest instruction.
 */
export interface Sample {
	arm: string;
	round: string;
	attempt: number;
	ms: number;
	quiet: number | null;
	rc: number;
}

/** the rows of one workload on one host (`x86` or `v8`), and of one process when `proc` is given */
export function parseSamples(text: string, workload: string, host = 'x86', proc?: string): Sample[] {
	const out: Sample[] = [];
	for (const line of text.split('\n')) {
		const f = line.split('\t');
		if (f.length < 10 || f[0] !== host || f[1] !== workload || (proc !== undefined && f[3] !== proc)) continue;
		out.push({
			arm: f[2]!,
			round: f[4]!,
			attempt: Number(f[5]),
			ms: Number(f[6]),
			quiet: f[7] === '-' ? null : Number(f[7]),
			rc: Number(f[9])
		});
	}
	return out;
}

export const median = (v: number[]) => {
	const s = [...v].sort((a, b) => a - b);
	return s[Math.floor((s.length - 1) / 2)]!;
};

export interface Kept {
	ms: Map<number, number>;
	warm?: number;
	noisy: number;
	quiet: number[];
}

/** per arm: the kept time of each numbered round (first attempt at or under the quiet limit) */
export function keep(samples: Sample[], limit = 0.5): Map<string, Kept> {
	const arms = new Map<string, Kept>();
	for (const s of samples) {
		const k = arms.get(s.arm) ?? { ms: new Map(), noisy: 0, quiet: [] };
		arms.set(s.arm, k);
		if (s.rc !== 0) continue;
		const ok = s.quiet === null || s.quiet <= limit;
		if (!ok) {
			k.noisy++;
			continue;
		}
		if (s.round === 'warm' || s.round === 'first') k.warm ??= s.ms;
		else if (!k.ms.has(Number(s.round))) k.ms.set(Number(s.round), s.ms);
		else continue;
		if (s.quiet !== null) k.quiet.push(s.quiet);
	}
	return arms;
}

export interface Range {
	median: number;
	min: number;
	max: number;
	n: number;
}

const range = (v: number[]): Range => ({ median: median(v), min: Math.min(...v), max: Math.max(...v), n: v.length });

/** one value per round that both arms have, from the two times */
export function paired(a: Kept, b: Kept, f: (x: number, y: number) => number): Range | undefined {
	const v = [...a.ms].filter(([r]) => b.ms.has(r)).map(([r, x]) => f(x, b.ms.get(r)!));
	return v.length ? range(v) : undefined;
}

export const spread = (k: Kept) => {
	const v = [...k.ms.values()];
	return v.length ? (100 * (Math.max(...v) - Math.min(...v))) / median(v) : NaN;
};

const f2 = (v: number) => v.toFixed(2);
const f3 = (r: Range | undefined) => (r ? `${f2(r.median)} (${f2(r.min)} to ${f2(r.max)})` : 'n/a');
const pct = (r: Range | undefined) => (r ? `${(100 * r.median).toFixed(1)}% (${(100 * r.min).toFixed(1)} to ${(100 * r.max).toFixed(1)})` : 'n/a');

export function render(kept: Map<string, Kept>, names: Map<string, string>, form2?: string) {
	const get = (n: string) => {
		const label = names.get(n);
		const k = label === undefined ? undefined : kept.get(label);
		if (!k) throw new Error(`no samples for ${n}${label ? ` (${label})` : ''}`);
		return k;
	};
	const bin = get('binary');
	const lines: string[] = [];
	lines.push('| arm | rounds | median ms | spread | r (median of per-round ratios, min to max) | warm run ms | noisy attempts |');
	lines.push('| --- | --- | --- | --- | --- | --- | --- |');
	for (const [n] of names) {
		const k = get(n);
		const r = n === 'binary' ? undefined : paired(k, bin, (x, y) => x / y);
		lines.push(`| ${n} | ${k.ms.size} | ${median([...k.ms.values()])} | ${spread(k).toFixed(1)}% | ${n === 'binary' ? '1.00' : f3(r)} | ${k.warm ?? '-'} | ${k.noisy} |`);
	}
	const quiet = [...kept.values()].flatMap((k) => k.quiet);
	if (quiet.length) lines.push('', `quiet readings of the kept samples: min ${f2(Math.min(...quiet))}, median ${f2(median(quiet))}, max ${f2(Math.max(...quiet))}`);
	if (names.has('a0')) {
		const a0 = get('a0');
		const share = (n: string) => sharesOf(get(n), a0, bin);
		lines.push('', '| arm | share of the as-built excess it removes: (T(a0) - T(arm)) / (T(a0) - T(binary)) | T(arm) / T(binary) |', '| --- | --- | --- |');
		for (const [n] of names) {
			if (n === 'binary' || n === 'interp' || n === 'a0') continue;
			lines.push(`| ${n} | ${pct(share(n))} | ${f3(paired(get(n), bin, (x, y) => x / y))} |`);
		}
		if (names.has('a4')) {
			const a4 = get('a4');
			const rest = remainder(a4, a0, bin);
			const singles = ['a1', 'a2'].filter((n) => names.has(n)).map((n) => sharesOf(get(n), a0, bin));
			const sum = singles.reduce((s, r) => s + (r?.median ?? NaN), 0) + (form2 ? (sharesOf(get(form2), a0, bin)?.median ?? NaN) : 0);
			const mine = sharesOf(a4, a0, bin)?.median ?? NaN;
			lines.push(
				'',
				`a4 remainder (T(a4) - T(binary)) / (T(a0) - T(binary)): ${pct(rest)}`,
				`a4 removes ${(100 * mine).toFixed(1)}% against ${(100 * sum).toFixed(1)}% for the sum of its single arms (a1 + a2${form2 ? ` + ${form2}` : ''}); the difference, ${(100 * (mine - sum)).toFixed(1)} points, is interaction`,
				`a4 against the binary: ${f3(paired(a4, bin, (x, y) => x / y))}${(paired(a4, bin, (x, y) => x / y)?.median ?? 0) > 1.15 ? ' (above 1.15)' : ''}`
			);
		}
	}
	return lines.join('\n');
}

export function sharesOf(arm: Kept, a0: Kept, bin: Kept): Range | undefined {
	const v = [...arm.ms].filter(([r]) => a0.ms.has(r) && bin.ms.has(r)).map(([r, x]) => (a0.ms.get(r)! - x) / (a0.ms.get(r)! - bin.ms.get(r)!));
	return v.length ? range(v) : undefined;
}

export function remainder(arm: Kept, a0: Kept, bin: Kept): Range | undefined {
	const v = [...arm.ms].filter(([r]) => a0.ms.has(r) && bin.ms.has(r)).map(([r, x]) => (x - bin.ms.get(r)!) / (a0.ms.get(r)! - bin.ms.get(r)!));
	return v.length ? range(v) : undefined;
}

if (process.argv[1]?.endsWith('floor-table.ts') && process.argv[2] !== '--perf') {
	const [path, workload, ...rest] = process.argv.slice(2);
	if (!path || !workload) throw new Error('usage: floor-table.ts <samples> <workload> [--quiet=0.5] [--form2=<name>] <name>=<arm label>...');
	let limit = 0.5;
	let form2: string | undefined;
	let host = 'x86';
	let proc: string | undefined;
	const names = new Map<string, string>([['binary', 'binary'], ['interp', 'interp']]);
	for (const a of rest) {
		if (a.startsWith('--host=')) host = a.slice(7);
		else if (a.startsWith('--proc=')) proc = a.slice(7);
		else if (a.startsWith('--quiet=')) limit = Number(a.slice(8));
		else if (a.startsWith('--form2=')) form2 = a.slice(8);
		else names.set(a.slice(0, a.indexOf('=')), a.slice(a.indexOf('=') + 1));
	}
	console.log(render(keep(parseSamples(readFileSync(path, 'utf8'), workload, host, proc), limit), names, form2));
}

/** perf.sh's csv (arm, round, quiet, instructions, cycles, branches, branch-misses) as medians per arm, over the guest instructions the run executes */
export function perfTable(csv: string, guestInsns: number, limit = 0.5) {
	const arms = new Map<string, number[][]>();
	for (const line of csv.split('\n')) {
		const f = line.split(',');
		if (f.length !== 7 || !/^\d+$/.test(f[3]!)) continue;
		if (f[2] !== '-' && Number(f[2]) > limit) continue;
		const rows = arms.get(f[0]!) ?? [];
		rows.push(f.slice(3).map(Number));
		arms.set(f[0]!, rows);
	}
	const lines = ['| arm | samples | host instructions per guest instruction | cycles per guest instruction | IPC | branch miss rate |', '| --- | --- | --- | --- | --- | --- |'];
	for (const [arm, rows] of arms) {
		const [ins, cyc, br, miss] = [0, 1, 2, 3].map((i) => median(rows.map((r) => r[i]!)));
		lines.push(`| ${arm} | ${rows.length} | ${f2(ins! / guestInsns)} | ${f2(cyc! / guestInsns)} | ${f2(ins! / cyc!)} | ${((100 * miss!) / br!).toFixed(2)}% |`);
	}
	return lines.join('\n');
}

if (process.argv[1]?.endsWith('floor-table.ts') && process.argv[2] === '--perf') console.log(perfTable(readFileSync(process.argv[3]!, 'utf8'), Number(process.argv[4])));
