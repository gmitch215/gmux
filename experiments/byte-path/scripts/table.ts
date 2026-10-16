import { readFileSync } from 'node:fs';

/**
 * tables from split.ts's files: `table.ts <time.tsv> <count.json> <native.json> <profile.json>...`
 * a missing file is skipped; the profile files are merged, passes of one cell averaged
 */
const [timeFile, countFile, nativeFile, ...profileFiles] = process.argv.slice(2);
const load = (f?: string) => {
	try {
		return JSON.parse(readFileSync(f!, 'utf8'));
	} catch {
		return null;
	}
};
const median = (v: number[]) => {
	const s = [...v].sort((a, b) => a - b);
	return s.length ? (s.length % 2 ? s[(s.length - 1) / 2]! : (s[s.length / 2 - 1]! + s[s.length / 2]!) / 2) : NaN;
};
const range = (v: number[]) => (v.length ? `${Math.min(...v).toFixed(1)}-${Math.max(...v).toFixed(1)}` : '-');
const control = (id: string) => (['hc', 'pp4k', 'pp32k', 'pp1m'].includes(id) ? 'hc0' : ['hm', 'cm'].includes(id) ? 'hm0' : 'dd0');

// samples: arm, cell, mib, rep, ms, q0, q1, ok, digest, status, stats...
const rows = readFileSync(timeFile!, 'utf8').trim().split('\n');
const head = rows[0]!.split('\t');
const samples = rows.slice(1).map((l) => Object.fromEntries(l.split('\t').map((v, i) => [head[i]!, v])));
const cellIds = [...new Set(samples.map((s) => s.cell!))];
const by = (arm: string, cell: string) => samples.filter((s) => s.arm === arm && s.cell === cell);
const ms = (arm: string, cell: string, keep = true) =>
	by(arm, cell)
		.filter((s) => s.ok === '1' && (!keep || !(Number(s.quiet_before) > 0.5)))
		.map((s) => Number(s.ms));

console.log('### Wall time per cell (ms; median, min-max over kept samples)\n');
console.log('| cell | MiB | native n | native ms | guest n | guest ms | r | guest MB/s | guest net of start-up ms | native net ms | noisy (native/guest) | failed |');
console.log('| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |');
for (const id of cellIds) {
	const mib = Number(by('guest', id)[0]?.mib ?? by('native', id)[0]?.mib);
	const n = ms('native', id);
	const g = ms('guest', id);
	const gc = median(ms('guest', control(id)));
	const nc = median(ms('native', control(id)));
	const noisy = (arm: string) => by(arm, id).filter((s) => Number(s.quiet_before) > 0.5).length;
	const failed = samples.filter((s) => s.cell === id && s.ok !== '1').length;
	console.log(
		`| ${id} | ${mib} | ${n.length} | ${median(n).toFixed(1)} (${range(n)}) | ${g.length} | ${median(g).toFixed(1)} (${range(g)}) | ${(median(g) / median(n)).toFixed(2)} | ${mib ? ((mib * 1.048576) / (median(g) / 1000)).toFixed(0) : '-'} | ${mib ? (median(g) - gc).toFixed(1) : '-'} | ${mib ? (median(n) - nc).toFixed(1) : '-'} | ${noisy('native')}/${noisy('guest')} | ${failed} |`
	);
}

// the dd rows fit time = calls * c + bytes * b over the three buffer sizes (512 MiB each)
const fit = (arm: string, calls: Record<string, number>) => {
	const pts = ['dd4k', 'dd32k', 'dd1m'].map((id) => ({ t: median(ms(arm, id)), x: calls[id]! }));
	if (pts.some((p) => Number.isNaN(p.t) || !p.x)) return null;
	const n = pts.length;
	const sx = pts.reduce((a, p) => a + p.x, 0);
	const sy = pts.reduce((a, p) => a + p.t, 0);
	const sxx = pts.reduce((a, p) => a + p.x * p.x, 0);
	const sxy = pts.reduce((a, p) => a + p.x * p.t, 0);
	const c = (n * sxy - sx * sy) / (n * sxx - sx * sx);
	const a = (sy - c * sx) / n;
	return { perCallNs: c * 1e6, fixedMs: a, residual: pts.map((p) => +(p.t - (a + c * p.x)).toFixed(2)) };
};

const count = load(countFile);
if (count) {
	console.log('\n### Machine counts per cell (one counted run each; the run pays a host crossing per call)\n');
	console.log('| cell | MiB | syscalls | net of control | per MiB | top calls by number | switches | idles | relaxes | fuel yields | pump steps | host sleeps | user copies | digests | top sizes |');
	console.log('| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |');
	for (const [id, v] of Object.entries<any>(count)) {
		const c = count[control(id)];
		const net = v.syscalls - (v.mib && c ? c.syscalls : 0);
		const st = v.stats;
		console.log(
			`| ${id} | ${v.mib} | ${v.syscalls} | ${v.mib ? net : '-'} | ${v.mib ? (net / v.mib).toFixed(0) : '-'} | ${JSON.stringify(v.byNr).slice(0, 80)} | ${st.switches} | ${st.idles} | ${st.relaxes} | ${st.fuelYields} | ${st.pumpSteps} | ${st.hostSleeps} | ${st.userCopies} | ${st.digests} | ${Object.entries(v.ioSizes).slice(0, 3).map(([k, n]) => `${k}:${n}`).join(' ')} |`
		);
	}
	const calls = Object.fromEntries(Object.entries<any>(count).map(([id, v]) => [id, v.syscalls]));
	console.log('\n### Per-call cost fit (dd 4 KiB, 32 KiB, 1 MiB from /dev/zero to /dev/null: time = fixed + calls x per-call; the byte cost is the 1 MiB row)\n');
	console.log('| arm | per call ns | fixed ms | residuals ms (4k, 32k, 1m) | 1 MiB dd ms | 512 MiB at that rate GB/s |');
	console.log('| --- | --- | --- | --- | --- | --- |');
	for (const arm of ['guest', 'native']) {
		const f = fit(arm, arm === 'guest' ? calls : Object.fromEntries(['dd4k', 'dd32k', 'dd1m'].map((id) => [id, (load(nativeFile) ?? {})[id]?.syscalls])));
		const t = median(ms(arm, 'dd1m'));
		if (f) console.log(`| ${arm} | ${f.perCallNs.toFixed(0)} | ${f.fixedMs.toFixed(2)} | ${f.residual.join(', ')} | ${t.toFixed(1)} | ${(536870912 / 1e9 / (t / 1000)).toFixed(1)} |`);
	}
}

const native = load(nativeFile);
if (native) {
	console.log('\n### Native counts per cell (strace -c -f, perf stat; each run pinned to one core)\n');
	console.log('| cell | MiB | syscalls | per MiB | top calls | task-clock ms | user ms | system ms | context switches | page faults |');
	console.log('| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |');
	for (const [id, v] of Object.entries<any>(native)) {
		const e = v.events;
		const top = Object.entries<number>(v.byName).sort((a, b) => b[1] - a[1]).slice(0, 4).map(([k, n]) => `${k}:${n}`).join(' ');
		console.log(`| ${id} | ${v.mib} | ${v.syscalls} | ${v.mib ? (v.syscalls / v.mib).toFixed(0) : '-'} | ${top} | ${(e['task-clock'] ?? NaN).toFixed(1)} | ${((e['user_time'] ?? NaN) / 1e6).toFixed(1)} | ${((e['system_time'] ?? NaN) / 1e6).toFixed(1)} | ${e['context-switches'] ?? '-'} | ${e['page-faults'] ?? '-'} |`);
	}
}

const merged = new Map<string, any[]>();
for (const f of profileFiles) for (const [k, v] of Object.entries<any>(load(f) ?? {})) merged.set(k.replace(/#\d+$/, ''), [...(merged.get(k.replace(/#\d+$/, '')) ?? []), v]);
if (merged.size) {
	const cats = ['programs (wasm)', 'kernel clear (memory.fill)', 'kernel copy (memory.copy)', 'kernel (other)', 'host JS', 'host (program)', 'host JS (gc)', 'idle'];
	console.log('\n### Machine split (profiler leaf frames, share of samples per pass, mean over passes; ms = share x the profiled pass wall)\n');
	console.log(`| cell | passes | pass wall ms | timed median ms | ${cats.join(' | ')} | sum % | samples x interval vs wall |`);
	console.log(`| --- | --- | --- | --- | ${cats.map(() => '---').join(' | ')} | --- | --- |`);
	for (const [id, vs] of merged) {
		const wall = vs.reduce((a, v) => a + v.ms, 0) / vs.length;
		const share = (c: string) => vs.reduce((a, v) => a + (v.categories[c] ?? 0), 0) / vs.length;
		const sum = cats.reduce((a, c) => a + share(c), 0);
		const cov = vs.reduce((a, v) => a + v.samples, 0) / vs.length;
		console.log(`| ${id} | ${vs.length} | ${wall.toFixed(0)} | ${median(ms('guest', id)).toFixed(0)} | ${cats.map((c) => `${share(c).toFixed(1)}% (${((share(c) * wall) / 100).toFixed(0)} ms)`).join(' | ')} | ${sum.toFixed(1)} | ${(cov * 0.1 / wall).toFixed(2)} |`);
	}
	console.log('\nTop leaf frames (share of samples, first pass):\n');
	for (const [id, vs] of merged) console.log(`- ${id}: ${Object.entries(vs[0].topLeaves).slice(0, 6).map(([k, v]) => `${k} ${v}%`).join('; ')}`);
}
