import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { loadavg } from 'node:os';
import { join } from 'node:path';
import { dispatchWat, entriesOf, openRung, type Rung } from './link.ts';

/**
 * The promotion ladder with rungs whose promoted set is not closed under calls (ladder.ts prepare with LADDER_OPEN=1),
 * run over the re-entry interpreter. Whole workload against V8 on the same module, every rung's checksum checked.
 *
 * - `sets <rungs dir> <out sets.json> <share>...`: the hottest functions first, as many as it takes to reach each share of
 *   the guest's instructions (a function with a wide signature never goes native); labels `open<share in permille>`
 * - `assemble <rungs dir>` (needs wasm-tools): one dispatcher module per rung that has thunks, for `direct`
 * - `run <rungs dir> <re-entry wasm3.wasm> <rounds> [glued | direct] [out.json]`: run(2n) less run(n) per rung, median over the
 *   rounds, against V8's; the caller holds the lock
 */
const [mode = '', ...args] = process.argv.slice(2);
type Manifest = { total: number; counts: Record<string, number>; rungs: (Rung & { label: string; target: number; share: number; promoted: string[] })[] };
const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]!;

if (mode === 'sets') {
	const [dir = '', out = '', ...shares] = args;
	const m = JSON.parse(readFileSync(join(dir, 'rungs.json'), 'utf8')) as Manifest;
	const eligible = new Set(m.rungs.at(-1)!.promoted);
	const order = Object.entries(m.counts)
		.filter(([name, c]) => eligible.has(name) && c > 0)
		.sort((a, b) => b[1] - a[1]);
	const sets: Record<string, string[]> = {};
	for (const share of shares.map(Number)) {
		const set: string[] = [];
		let sum = 0;
		for (const [name, c] of order) {
			if (sum / m.total >= share) break;
			set.push(name);
			sum += c;
		}
		// two shares can land on the same set; keep the first label
		if (!Object.values(sets).some((s) => s.join() === set.join())) sets[`open${Math.round(share * 1000)}`] = set;
	}
	writeFileSync(out, JSON.stringify(sets, null, '\t'));
	for (const [label, set] of Object.entries(sets)) console.log(`${label}: ${set.length} functions: ${set.join(' ')}`);
}

if (mode === 'assemble') {
	const [dir = ''] = args;
	const m = JSON.parse(readFileSync(join(dir, 'rungs.json'), 'utf8')) as Manifest;
	for (const r of m.rungs) {
		// host_direct carries eight arguments, so a rung with a wider thunk runs over JavaScript
		if (!Object.keys(r.imports).length || entriesOf(r).some((e) => e.arity > 8)) continue;
		writeFileSync(join(dir, `rung${r.rung}.dispatch.wasm`), execFileSync('wasm-tools', ['parse', '-o', '/dev/stdout'], { input: dispatchWat(entriesOf(r), true), maxBuffer: 1 << 28 }));
	}
}

if (mode === 'run') {
	const [dir = '', wasm3 = '', roundsArg = '5', how = 'glued', out = ''] = args;
	if (how !== 'glued' && how !== 'direct') throw new Error('usage: mixed.ts run <rungs dir> <re-entry wasm3.wasm> <rounds> [glued | direct] [out.json]');
	const rounds = Number(roundsArg);
	const m = JSON.parse(readFileSync(join(dir, 'rungs.json'), 'utf8')) as Manifest;
	const n = Number(process.env.N ?? 2);
	const time = (f: () => number) => {
		const t = performance.now();
		const v = f() >>> 0;
		return { ms: performance.now() - t, v };
	};
	const v8 = new WebAssembly.Instance(new WebAssembly.Module(readFileSync(join(dir, 'guest.wasm')))).exports as Record<string, (n: number) => number>;
	const reference = v8.run!(2 * n) >>> 0;
	const v8ms = median(Array.from({ length: rounds }, () => time(() => v8.run!(2 * n)).ms - time(() => v8.run!(n)).ms));
	const loadBefore = loadavg()[0];
	const rows: { rung: number; label: string; target: number; share: number; ms: number; down: number; up: number; cold: number }[] = [];
	for (const r of m.rungs) {
		// a rung with no assembled dispatcher (no thunks, or one wider than host_direct) runs over JavaScript
		const file = join(dir, `rung${r.rung}.dispatch.wasm`);
		const dispatcher = how === 'direct' && existsSync(file) ? new Uint8Array(readFileSync(file)) : undefined;
		const { vm, linked } = await (how === 'direct' && !dispatcher ? openRung(wasm3, dir, r, 'glued') : openRung(wasm3, dir, r, how, dispatcher));
		const guest = linked.guest;
		const diffs: number[] = [];
		let down = 0;
		let up = 0;
		for (let k = 0; k < rounds; k++) {
			linked.counts.down = 0;
			linked.counts.up = 0;
			const one = time(() => guest.call('run', n));
			const d1 = linked.counts.down;
			const u1 = linked.counts.up;
			const two = time(() => guest.call('run', 2 * n));
			if (two.v !== reference) throw new Error(`rung ${r.rung} (${r.label}): ${two.v.toString(16)} against v8 ${reference.toString(16)}`);
			diffs.push(two.ms - one.ms);
			down = linked.counts.down - 2 * d1;
			up = linked.counts.up - 2 * u1;
		}
		void vm;
		rows.push({ rung: r.rung, label: r.label, target: r.target, share: r.share, ms: median(diffs), down: Math.max(down, 0), up: Math.max(up, 0), cold: r.cold?.length ?? 0 });
	}
	if (out) writeFileSync(out, JSON.stringify({ node: process.version, v8: process.versions.v8, how, n, rounds, v8ms, loadBefore, loadAfter: loadavg()[0], rows }, null, '\t'));
	const rI = rows[0]!.ms / v8ms;
	const rN = rows.at(-1)!.ms / v8ms;
	console.log(`V8 ${process.versions.v8} (node ${process.version}): ${v8ms.toFixed(1)} ms per ${n} units; all interpreted r ${rI.toFixed(2)}, all native through one crossing r ${rN.toFixed(2)}; ${how}`);
	console.log('| rung | label | closed share | ms | r | Amdahl r | down a unit | up a unit |');
	console.log('| --- | --- | --- | --- | --- | --- | --- | --- |');
	for (const row of rows) console.log(`| ${row.rung} | ${row.label} | ${(100 * row.share).toFixed(3)}% | ${row.ms.toFixed(1)} | ${(row.ms / v8ms).toFixed(2)} | ${((1 - row.share) * rI + row.share * rN).toFixed(2)} | ${(row.down / n).toFixed(0)} | ${(row.up / n).toFixed(0)} |`);
}
