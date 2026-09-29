import { readFileSync, writeFileSync } from 'node:fs';
import { plan } from './planner.ts';

/**
 * `r` with the planner off and on: `time.ts <guest.wasm> <burrow dist> <out.json> [rounds] [repeats]`.
 *
 * Arms, interleaved a round at a time so drift lands on all of them: V8 on the original (the
 * denominator), V8 on the planned module, and wasm3 on the original twice (`off`, `off2`, the
 * control and its spread) and on the planned module (`on`). Every timing is run(2n) less run(1n),
 * median over the rounds; a repeat is a fresh interpreter per arm. The caller holds any bench lock.
 */
const [guest = '', dist = '', out = '', roundsArg = '5', repeatsArg = '2'] = process.argv.slice(2);
if (!guest || !dist || !out) throw new Error('usage: time.ts <guest.wasm> <burrow dist> <out.json> [rounds] [repeats]');
const rounds = Number(roundsArg);
const repeats = Number(repeatsArg);
const n = Number(process.env.N ?? 2);

const original = new Uint8Array(readFileSync(guest));
const planned = plan(original).bytes;
const { createInterpreter } = await import(`${dist}/interpret.js`);
const wasm3 = new WebAssembly.Module(readFileSync(`${dist}/vendor/wasm3.wasm`));
const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]!;
const v8 = (b: Uint8Array<ArrayBuffer>) => new WebAssembly.Instance(new WebAssembly.Module(b)).exports.run as (n: number) => number;

const reference = v8(original)(2 * n) >>> 0;
const time = (f: (n: number) => number) => {
	const t0 = performance.now();
	const v = f(n) >>> 0;
	const t1 = performance.now();
	const w = f(2 * n) >>> 0;
	const t2 = performance.now();
	if (w !== reference) throw new Error(`run(${2 * n}) gave ${w.toString(16)}, V8 on the original ${reference.toString(16)} (run(${n}) ${v.toString(16)})`);
	return t2 - t1 - (t1 - t0);
};

const rows: Record<string, number>[] = [];
for (let k = 0; k < repeats; k++) {
	const arms: Record<string, (n: number) => number> = { v8: v8(original), 'v8 planned': v8(planned) };
	for (const [label, b] of [['off', original], ['on', planned], ['off2', original]] as const) {
		const vm = await createInterpreter({ module: wasm3 });
		const guestVm = vm.load(b);
		arms[label] = (m: number) => guestVm.call('run', m) as number;
	}
	const samples: Record<string, number[]> = Object.fromEntries(Object.keys(arms).map((a) => [a, []]));
	for (let round = 0; round < rounds; round++) for (const a of Object.keys(arms)) samples[a]!.push(time(arms[a]!));
	const ms = Object.fromEntries(Object.entries(samples).map(([a, xs]) => [a, median(xs)]));
	rows.push({ ...ms, rOff: ms.off! / ms.v8!, rOn: ms.on! / ms.v8!, rOff2: ms.off2! / ms.v8!, v8Planned: ms['v8 planned']! / ms.v8! });
}
const spread = (key: string) => {
	const xs = rows.map((r) => r[key]!);
	return (Math.max(...xs) - Math.min(...xs)) / median(xs);
};
const summary = Object.fromEntries(['rOff', 'rOn', 'rOff2', 'v8Planned'].map((key) => [key, { median: median(rows.map((r) => r[key]!)), spread: spread(key) }]));
writeFileSync(out, JSON.stringify({ node: process.version, v8: process.versions.v8, n, rounds, repeats, rows, summary }, null, '\t'));
console.log(JSON.stringify(summary));
