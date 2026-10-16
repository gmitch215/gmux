import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * The tables for the re-entry item's sweep: `table.ts <sweep out dir>`. Reads the sample files sweep.sh wrote and prints
 * markdown: the rebased module's whole-workload tax (part 0), the crossing per direction and arity (rt), and the ladder's
 * rungs (c). A sample is noisy when a quiet reading is above 0.5 (paisley-park) or a load above 4 (the Mac).
 */
const dir = process.argv[2] ?? '';
if (!dir) throw new Error('usage: table.ts <sweep out dir>');
const files = readdirSync(dir);
const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]!;
const span = (xs: number[]) => `${median(xs).toFixed(2)} [${Math.min(...xs).toFixed(2)}-${Math.max(...xs).toFixed(2)}]`;
const spread = (xs: number[]) => `${((100 * (Math.max(...xs) - Math.min(...xs))) / median(xs)).toFixed(0)}%`;
const read = (name: string) => JSON.parse(readFileSync(join(dir, name), 'utf8'));

const quiet = new Map<string, { noisy: boolean; before: string; after: string; rc: string }>();
const tsv = join(dir, 'samples.tsv');
if (existsSync(tsv))
	for (const line of readFileSync(tsv, 'utf8').split('\n').slice(1).filter(Boolean)) {
		const [name = '', , q0 = '', q1 = '', , rc = ''] = line.split('\t');
		const num = (q: string) => Number(q.replace('load ', ''));
		const mac = q0.startsWith('load');
		const limit = mac ? 4 : 0.5;
		quiet.set(name, { noisy: num(q0) > limit || num(q1) > limit, before: q0, after: q1, rc });
	}
const tally = (names: string[]) => {
	const q = names.map((n) => quiet.get(n)).filter(Boolean) as { noisy: boolean; before: string; after: string; rc: string }[];
	const nums = q.flatMap((x) => [Number(x.before.replace('load ', '')), Number(x.after.replace('load ', ''))]);
	return `${names.length} kept, ${q.filter((x) => x.noisy).length} noisy, ${q.filter((x) => x.rc !== '0').length} failed; reading min ${nums.length ? Math.min(...nums).toFixed(2) : '-'} median ${nums.length ? median(nums).toFixed(2) : '-'} max ${nums.length ? Math.max(...nums).toFixed(2) : '-'}`;
};
const good = (names: string[]) => names.filter((n) => quiet.get(n)?.rc === '0' || !quiet.size);

// #region part 0
for (const [prefix, title] of [
	['p0', 'Part 0'],
	['e', 'Endpoint (guest memory build)']
] as const)
	for (const g of ['zlib', 'zstd']) {
	const names = good(files.filter((f) => f.startsWith(`${prefix}-${g}-`) && f.endsWith('.json')).map((f) => f.slice(0, -5)));
	if (!names.length) continue;
	const samples = names.map((n) => read(`${n}.json`) as { node: string; rows: { variant: string; ms: number; ratioToOrig: number }[] });
	console.log(`\n### ${title}: ${g}, whole workload, ratio to the original guest in V8 (node ${samples[0]!.node})\n`);
	console.log(`${tally(names)}\n`);
	console.log('| variant | ms a sample (median [min-max]) | ratio to orig (median [min-max]) | spread of the ratio |');
	console.log('| --- | --- | --- | --- |');
	for (const v of samples[0]!.rows.map((r) => r.variant)) {
		const rows = samples.map((s) => s.rows.find((r) => r.variant === v)!);
		console.log(`| ${v} | ${span(rows.map((r) => r.ms))} | ${span(rows.map((r) => r.ratioToOrig)).replace(/(\d+\.\d+)/g, (x) => Number(x).toFixed(3))} | ${spread(rows.map((r) => r.ratioToOrig))} |`);
	}
}
// #endregion

// #region rt
{
	const names = good(files.filter((f) => /^rt-\d+\.json$/.test(f)).map((f) => f.slice(0, -5)));
	if (names.length) {
		const samples = names.map((n) => read(`${n}.json`) as { node: string; rows: { dir: string; impl: string; arity: number; ns: number }[] });
		console.log(`\n### Crossing, ns per crossing (cross loop less the same loop without it), ${samples.length} paired rounds, node ${samples[0]!.node}\n`);
		console.log(`${tally(names)}\n`);
		console.log('| direction | implementation | arity | ns (median [min-max]) | spread | ratio to the glued thunk (down, glued-default) |');
		console.log('| --- | --- | --- | --- | --- | --- |');
		const cells = [...new Set(samples[0]!.rows.map((r) => `${r.dir}/${r.impl}/${r.arity}`))];
		const med = (key: string) => median(samples.map((s) => s.rows.find((r) => `${r.dir}/${r.impl}/${r.arity}` === key)!.ns));
		for (const key of cells) {
			const [d, impl, k] = key.split('/') as [string, string, string];
			const xs = samples.map((s) => s.rows.find((r) => `${r.dir}/${r.impl}/${r.arity}` === key)!.ns);
			console.log(`| ${d} | ${impl} | ${k} | ${span(xs).replace(/(\d+\.\d+)/g, (x) => Number(x).toFixed(1))} | ${spread(xs)} | ${(med(key) / med(`down/glued-default/${k}`)).toFixed(3)} |`);
		}
	}
}
// #endregion

// #region c
{
	const groups = new Map<string, string[]>();
	for (const f of files.filter((x) => /^(c|o|i)-.*-\d+\.json$/.test(x))) {
		const name = f.slice(0, -5);
		const cell = name.replace(/-\d+$/, '');
		if (good([name]).length) groups.set(cell, [...(groups.get(cell) ?? []), name]);
	}
	for (const [cell, names] of [...groups].sort()) {
		const samples = names.map((n) => read(`${n}.json`) as { node: string; how: string; n: number; v8ms: number; rows: { rung: number; label: string; share: number; ms: number; down: number; up: number }[] });
		const rI = samples.map((s) => s.rows[0]!.ms / s.v8ms);
		const rN = samples.map((s) => s.rows.at(-1)!.ms / s.v8ms);
		console.log(`\n### Ladder ${cell}: r against V8 on the same module, node ${samples[0]!.node}, ${samples.length} samples of 5 rounds\n`);
		console.log(`${tally(names)}; V8 ms per unit pair: ${span(samples.map((s) => s.v8ms))}\n`);
		console.log('| rung | label | closed share | r (median [min-max]) | spread | Amdahl r (from the same samples\' ends) | down a unit | up a unit |');
		console.log('| --- | --- | --- | --- | --- | --- | --- | --- |');
		for (const row of samples[0]!.rows) {
			const rs = samples.map((s) => s.rows.find((r) => r.rung === row.rung)!.ms / s.v8ms);
			const am = samples.map((s, i) => (1 - row.share) * rI[i]! + row.share * rN[i]!);
			const crossings = samples.map((s) => s.rows.find((r) => r.rung === row.rung)!);
			console.log(`| ${row.rung} | ${row.label} | ${(100 * row.share).toFixed(3)}% | ${span(rs)} | ${spread(rs)} | ${median(am).toFixed(2)} | ${(median(crossings.map((c) => c.down)) / samples[0]!.n).toFixed(0)} | ${(median(crossings.map((c) => c.up)) / samples[0]!.n).toFixed(0)} |`);
		}
	}
}
// #endregion

// #region native controls
for (const g of ['zlib', 'zstd']) {
	const names = good(files.filter((f) => f.startsWith(`en-${g}-`) && f.endsWith('.json')).map((f) => f.slice(0, -5)));
	if (!names.length) continue;
	const ratios = new Map<string, number[]>();
	const mss = new Map<string, number[]>();
	for (const n of names) {
		const i = n.slice(`en-${g}-`.length);
		const orig = existsSync(join(dir, `e-${g}-${i}.json`)) ? (read(`e-${g}-${i}.json`) as { rows: { variant: string; ms: number }[] }).rows.find((r) => r.variant === 'orig')?.ms : undefined;
		for (const line of readFileSync(join(dir, `${n}.json`), 'utf8').split('\n').filter(Boolean)) {
			const row = JSON.parse(line) as { variant: string; ms: number; checksum: number };
			mss.set(row.variant, [...(mss.get(row.variant) ?? []), row.ms]);
			if (orig) ratios.set(row.variant, [...(ratios.get(row.variant) ?? []), row.ms / orig]);
		}
	}
	console.log(`\n### Native controls: ${g} (x86-64 binaries, libc mem*), ratio to the untouched wasm in V8 of the same sample index\n`);
	console.log(`${tally(names)}\n`);
	console.log('| arm | ms a sample (median [min-max]) | ratio to the untouched wasm in V8 (median [min-max]) | spread |');
	console.log('| --- | --- | --- | --- |');
	for (const [arm, xs] of mss) console.log(`| ${arm} | ${span(xs)} | ${ratios.get(arm) ? span(ratios.get(arm)!).replace(/(\d+\.\d+)/g, (x) => Number(x).toFixed(3)) : '-'} | ${ratios.get(arm) ? spread(ratios.get(arm)!) : '-'} |`);
}
// #endregion

// #region all interpreted, re-entry build against guest memory build
for (const g of ['zlib', 'zstd']) {
	const re = good(files.filter((f) => f.startsWith(`i-${g}-re-`) && f.endsWith('.json')).map((f) => f.slice(0, -5)));
	const gm = good(files.filter((f) => f.startsWith(`i-${g}-gm-`) && f.endsWith('.json')).map((f) => f.slice(0, -5)));
	if (!re.length || !gm.length) continue;
	type Run = { v8ms: number; rows: { rung: number; ms: number }[] };
	const ratios: number[] = [];
	for (const n of re) {
		const m = n.replace('-re-', '-gm-');
		if (!gm.includes(m)) continue;
		ratios.push((read(`${m}.json`) as Run).rows[0]!.ms / (read(`${n}.json`) as Run).rows[0]!.ms);
	}
	console.log(`\n### All interpreted (rung 0), ${g}: guest memory build time over re-entry build time, the same sample index (one session each)\n`);
	console.log(`${ratios.length} pairs; ${span(ratios).replace(/(\d+\.\d+)/g, (x) => Number(x).toFixed(3))}, spread ${ratios.length ? spread(ratios) : '-'}\n`);
}
// #endregion

// #region memory
{
	const names = good(files.filter((f) => /^m-.*-\d+\.json$/.test(f)).map((f) => f.slice(0, -5)));
	if (names.length) {
		type Row = { arm: string; rssBefore: number; rssAfterInstantiate: number; rssAfterRun: number; maxRssRaw: number; wasm3MemoryBytes: number; sharedMemoryBytes: number; nativeModuleBytes: number };
		const cells = [...new Set(names.map((n) => n.replace(/-\d+$/, '')))].sort();
		console.log('\n### Memory, one fresh process per arm (MiB; RSS is the process, so the combined peak is one number)\n');
		console.log('| cell | samples | RSS before | RSS after instantiate | RSS after run(1) | max RSS | wasm3 Memory | shared Memory | native module (KiB) |');
		console.log('| --- | --- | --- | --- | --- | --- | --- | --- | --- |');
		const mib = (b: number) => (b / 1048576).toFixed(1);
		for (const c of cells) {
			const rows = names.filter((n) => n.replace(/-\d+$/, '') === c).map((n) => read(`${n}.json`) as Row);
			const med = (f: (r: Row) => number) => median(rows.map(f));
			const raw = med((r) => r.maxRssRaw);
			console.log(`| ${c} | ${rows.length} | ${mib(med((r) => r.rssBefore))} | ${mib(med((r) => r.rssAfterInstantiate))} | ${mib(med((r) => r.rssAfterRun))} | ${(raw / 1024).toFixed(1)} (raw ${raw}) | ${mib(med((r) => r.wasm3MemoryBytes))} | ${mib(med((r) => r.sharedMemoryBytes))} | ${(med((r) => r.nativeModuleBytes) / 1024).toFixed(1)} |`);
		}
	}
}
// #endregion

// #region x86-64 code counts
{
	const names = files.filter((f) => /^x-.*\.json$/.test(f)).sort();
	if (names.length) {
		console.log('\n### Machine code, V8 optimising tier, one hot function per guest\n');
		console.log('| guest | variant | function | arch | instructions | bytes | loads | stores | frame | adds | leas |');
		console.log('| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |');
		for (const n of names) {
			const r = JSON.parse(readFileSync(join(dir, n), 'utf8').trim().split('\n').at(-1)!) as Record<string, string | number>;
			console.log(`| ${n.split('-')[1]} | ${r.variant} | ${r.function} | ${r.arch} | ${r.instructions} | ${r.bytes} | ${r.loads} | ${r.stores} | ${r.frame} | ${r.adds} | ${r.leas} |`);
		}
	}
}
// #endregion
