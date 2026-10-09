import { readFileSync } from 'node:fs';
import { keep, median, paired, parseSamples, remainder, sharesOf, type Kept, type Range } from './floor-table.ts';

/**
 * One workload's x86 and V8 samples (k42b-sweep.sh's file) as the floor under V8: `r` per arm on both hosts, the share
 * of V8's as-built excess each arm holds, and the V8 minus x86 gap of the as-built arm (a0) and of the plain-access arm
 * (a1: x86 identity / native window against the V8 window) split into the engine's bounds checks, tier-up and the rest.
 * The default V8 processes are `1` and `2`; the diagnostics are `nb` (no bounds checks), `eb` (explicit bounds checks) and
 * `nl` (no Liftoff). Each r is paired with the binary of its own process and round.
 *
 * `gap-split.ts <samples> <workload> a0=<arm> a1=<arm> [a2=<arm>] [a4=<arm>] [forms=<arm>,<arm>] [x1=<x86 identity arm>] [xw=<x86 window arm>]`
 * Arms are labels without the `:0`; V8 arm labels are `<arm>:0`, x86 ones too.
 */
export interface Pooled {
	r: number;
	min: number;
	max: number;
	/** the per-process medians, in process order */
	procs: number[];
}

const f2 = (v: number | undefined) => (v === undefined ? "n/a" : v.toFixed(2));
const show = (p: Pooled | undefined) => (p ? `${f2(p.r)} (${f2(p.min)} to ${f2(p.max)})` : 'n/a');

/** each process's arm against its own binary, pooled over processes and rounds */
export function pool(procs: Map<string, Kept>[], arm: string, bin = 'binary'): Pooled | undefined {
	const all: number[] = [];
	const meds: number[] = [];
	for (const p of procs) {
		const a = p.get(arm);
		const b = p.get(bin);
		const r = a && b ? paired(a, b, (x, y) => x / y) : undefined;
		if (!r) continue;
		meds.push(r.median);
		for (const [n, x] of a!.ms) if (b!.ms.has(n)) all.push(x / b!.ms.get(n)!);
	}
	return all.length ? { r: median(all), min: Math.min(...all), max: Math.max(...all), procs: meds } : undefined;
}

/** share of a0's excess an arm removes, pooled over processes (each against its own a0 and binary) */
export function poolShare(procs: Map<string, Kept>[], arm: string, a0: string, remain = false): Range | undefined {
	const v: number[] = [];
	for (const p of procs) {
		const [a, z, b] = [p.get(arm), p.get(a0), p.get('binary')];
		const r = a && z && b ? (remain ? remainder(a, z, b) : sharesOf(a, z, b)) : undefined;
		if (!r) continue;
		for (const [n, x] of a!.ms)
			if (z!.ms.has(n) && b!.ms.has(n)) v.push(remain ? (x - b!.ms.get(n)!) / (z!.ms.get(n)! - b!.ms.get(n)!) : (z!.ms.get(n)! - x) / (z!.ms.get(n)! - b!.ms.get(n)!));
	}
	return v.length ? { median: median(v), min: Math.min(...v), max: Math.max(...v), n: v.length } : undefined;
}

const pct = (r: Range | undefined) => (r ? `${(100 * r.median).toFixed(1)}% (${(100 * r.min).toFixed(1)} to ${(100 * r.max).toFixed(1)})` : 'n/a');

export interface Arms {
	a0: string;
	a1: string;
	a2?: string;
	a4?: string;
	forms: string[];
	x1?: string;
	xw?: string;
}

export function render(samples: string, workload: string, arms: Arms, limit = 0.5) {
	const x86 = [keep(parseSamples(samples, workload, 'x86'), limit)];
	const v8 = (p: string) => keep(parseSamples(samples, workload, 'v8', p), limit);
	const def = [v8('1'), v8('2')].filter((m) => m.has('binary'));
	const diag = (p: string) => {
		const m = v8(p);
		return m.has('binary') ? [m] : [];
	};
	const lab = (a: string) => `${a}:0`;
	const rows: string[] = [];
	const out: string[] = [];
	out.push(
		`| arm | x86 r | V8 r (both processes, min to max) | V8 r over x86 r | what the arms are |`,
		'| --- | --- | --- | --- | --- |'
	);
	const line = (name: string, v8arm: string | undefined, x86arm: string | undefined, what: string) => {
		const v = v8arm ? pool(def, lab(v8arm)) : undefined;
		const x = x86arm ? pool(x86, lab(x86arm)) : undefined;
		const ratio = v && x ? `${f2(v.r / x.r)} (${f2(v.min / x.r)} to ${f2(v.max / x.r)})` : 'n/a';
		out.push(`| ${name} | ${show(x)} | ${show(v)} | ${ratio} | ${what} |`);
	};
	out.push(`| binary (ms) | ${f2(median([...(x86[0]!.get('binary')?.ms.values() ?? [])]))} | ${f2(median(def.flatMap((p) => [...(p.get('binary')?.ms.values() ?? [])])))} | | native |`);
	out.push(`| interpreter | ${show(pool(x86, 'interp'))} | ${show(pool(def, 'int'))} | | x86 interp, V8 int |`);
	line('a0', arms.a0, arms.a0, 'as built, same lifted C');
	line("a1 / a1'", arms.a1, arms.xw, "x86: identity window runtime; V8: window runtime, same C");
	if (arms.x1) out.push(`| a1 identity (x86 only) | ${show(pool(x86, lab(arms.x1)))} | | | host-address identity |`);
	if (arms.a2) line('a2 live', arms.a2, arms.a2, '--flags=live');
	for (const f of arms.forms) line(`form ${f.slice(f.lastIndexOf('+o'))}`, f, f, 'other form, same region');
	if (arms.a4) line("a4 / a4'", arms.a4, arms.a4 && arms.xw ? `${arms.a4}+w` : arms.a4, "identity + live + form 2; V8 with the window");
	rows.push('');
	out.push('', '| share of V8 as-built excess an arm holds: (T(a0) - T(arm)) / (T(a0) - T(binary)) | V8 (both processes) | x86 (floor-table definition) |', '| --- | --- | --- |');
	const share = (name: string, v8arm: string, x86arm?: string) =>
		out.push(`| ${name} | ${pct(poolShare(def, lab(v8arm), lab(arms.a0)))} | ${x86arm ? pct(poolShare(x86, lab(x86arm), lab(arms.a0))) : 'n/a'} |`);
	share("a1'", arms.a1, arms.x1);
	if (arms.a2) share('a2 live', arms.a2, arms.a2);
	for (const f of arms.forms) share(`form ${f.slice(f.lastIndexOf('+o'))}`, f, f);
	if (arms.a4) {
		share("a4'", arms.a4, arms.a4);
		out.push(`| a4' remainder (T(a4') - T(binary)) / (T(a0) - T(binary)) | ${pct(poolShare(def, lab(arms.a4), lab(arms.a0), true))} | ${pct(poolShare(x86, lab(arms.a4), lab(arms.a0), true))} |`);
	}
	// the gap: V8 r minus x86 r of the same lifted C
	const med = (ps: Map<string, Kept>[], a: string) => pool(ps, lab(a));
	const diffRange = (hi: Pooled | undefined, lo: Pooled | undefined) => {
		if (!hi || !lo) return undefined;
		const v = hi.procs.flatMap((h) => lo.procs.map((l) => h - l));
		return { r: median(v), min: Math.min(...v), max: Math.max(...v) };
	};
	const fmt = (d: { r: number; min: number; max: number } | undefined, base?: number) =>
		d ? `${f2(d.r)} (${f2(d.min)} to ${f2(d.max)})${base ? `, ${((100 * d.r) / base).toFixed(0)}% of the gap` : ''}` : 'n/a';
	out.push('', '| V8 minus x86 gap, in r | a0 | a1 (window on both hosts) |', '| --- | --- | --- |');
	const gap = (v: Pooled | undefined, x: Pooled | undefined) => diffRange(v, x ? { ...x, procs: [x.r] } : undefined);
	const g0 = gap(med(def, arms.a0), med(x86, arms.a0));
	const g1 = gap(med(def, arms.a1), arms.xw ? med(x86, arms.xw) : undefined);
	out.push(`| gap | ${fmt(g0)} | ${fmt(g1)} |`);
	const parts = (a: string) => ({
		bounds: diffRange(med(def, a), med(diag('nb'), a)),
		explicit: diffRange(med(diag('eb'), a), med(def, a)),
		tier: diffRange(med(def, a), med(diag('nl'), a))
	});
	const [p0, p1] = [parts(arms.a0), parts(arms.a1)];
	out.push(
		`| bounds checks (default minus no checks; the default is the engine's own choice) | ${fmt(p0.bounds, g0?.r)} | ${fmt(p1.bounds, g1?.r)} |`,
		`| explicit checks (enforced minus default; not the default) | ${fmt(p0.explicit)} | ${fmt(p1.explicit)} |`,
		`| tier-up (default minus --no-liftoff) | ${fmt(p0.tier, g0?.r)} | ${fmt(p1.tier, g1?.r)} |`
	);
	if (g0 && g1) {
		const rest = (g: typeof g0, p: typeof p0) => g.r - (p.bounds?.r ?? 0) - (p.tier?.r ?? 0);
		const codegen = rest(g1, p1);
		out.push(
			`| rest (gap less bounds and tier-up): codegen for the plain-access arm | | ${f2(codegen)}, ${((100 * codegen) / g1.r).toFixed(0)}% of the gap |`,
			`| the part of a0's rest that the plain-access arm does not have (address handling on V8) | ${f2(rest(g0, p0) - codegen)}, ${((100 * (rest(g0, p0) - codegen)) / g0.r).toFixed(0)}% of the gap | |`
		);
	}
	return out.join('\n');
}

if (process.argv[1]?.endsWith('gap-split.ts')) {
	const [path, workload, ...rest] = process.argv.slice(2);
	if (!path || !workload) throw new Error('usage: gap-split.ts <samples> <workload> a0=<arm> a1=<arm> [a2=] [a4=] [forms=a,b] [x1=] [xw=]');
	const kv = Object.fromEntries(rest.map((a) => [a.slice(0, a.indexOf('=')), a.slice(a.indexOf('=') + 1)]));
	if (!kv.a0 || !kv.a1) throw new Error('a0= and a1= are required');
	console.log(render(readFileSync(path, 'utf8'), workload, { a0: kv.a0, a1: kv.a1, a2: kv.a2, a4: kv.a4, forms: kv.forms ? kv.forms.split(",") : [], x1: kv.x1, xw: kv.xw }, Number(kv.quiet ?? 0.5)));
}
