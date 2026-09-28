import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { jsLoop } from '../src/js.ts';

/**
 * Times each feature's arms, the same kernels under node and deployed.
 * - `drive.ts local`: instantiates src/*.bin in this node (V8), rounds interleaved, the minimum of
 *   each arm's ns per op (a warm-up call first).
 * - `drive.ts deployed <url> <tail.jsonl>`: with the Worker deployed and `wrangler tail --format
 *   json > tail.jsonl` running, burns the object's first placement, reads /features, then runs every
 *   arm at two sizes per round through one keep-alive client; after the run, ns per op =
 *   (cpu at the large size - cpu at the small) / (difference in ops), from tail's cpuTime.
 * Arms of one row compute the same value (relaxed madd rounds once, so it may differ in the last
 * bits); a mismatch is reported.
 */
const here = new URL('..', import.meta.url).pathname;
const ROUNDS = Number(process.env.ROUNDS ?? 5);

// [module, export, ops per unit of n]; n is sized so the large arm runs ~150-300 ms under node
export const rows: { name: string; arms: [string, string][]; n: number; per: number }[] = [
	{ name: 'host (JavaScript loop, no wasm)', arms: [['js', 'loop']], n: 3e8, per: 1 },
	{ name: 'tail calls (dispatch)', arms: [['tail', 'tail'], ['tail', 'calls'], ['tail', 'switch']], n: 1e8, per: 1 },
	{ name: 'branch hints (loop)', arms: [['hint', 'plain'], ['hint', 'right'], ['hint', 'wrong']], n: 3e8, per: 1 },
	{ name: 'memory64 (gather)', arms: [['mem32', 'gather'], ['mem64', 'gather']], n: 2e8, per: 1 },
	{ name: 'multiple memories (gather + meta)', arms: [['single', 'gather'], ['multi', 'gather']], n: 1.5e8, per: 1 },
	{ name: 'relaxed SIMD (dot, per vector)', arms: [['relaxed', 'muladd'], ['relaxed', 'madd']], n: 2e5, per: 256 },
	{ name: 'typed function refs (dispatch)', arms: [['funcref', 'indirect'], ['funcref', 'ref']], n: 1e8, per: 1 }
];

function local() {
	const inst = new Map<string, WebAssembly.Exports>([['js', { loop: jsLoop } as WebAssembly.Exports]]);
	const get = (m: string) => {
		let e = inst.get(m);
		if (!e) {
			e = new WebAssembly.Instance(new WebAssembly.Module(readFileSync(join(here, 'src', `${m}.bin`)))).exports;
			(e.init as (() => void) | undefined)?.();
			inst.set(m, e);
		}
		return e;
	};
	for (const row of rows) {
		const best = row.arms.map(() => Infinity);
		const results = row.arms.map(([m, f]) => String((get(m)[f] as (n: number) => unknown)(row.n / 10)));
		for (let r = 0; r < ROUNDS; r++)
			row.arms.forEach(([m, f], i) => {
				const t = performance.now();
				(get(m)[f] as (n: number) => unknown)(row.n);
				best[i] = Math.min(best[i]!, performance.now() - t);
			});
		const same = new Set(results).size === 1 ? '' : ` (results differ: ${results.join(' / ')})`;
		console.log(
			`${row.name}: ` +
				row.arms.map(([, f], i) => `${f} ${((best[i]! * 1e6) / (row.n * row.per)).toFixed(3)} ns`).join(', ') +
				same
		);
	}
}

/** the object's events only: the forwarding Worker's own event is ~1 ms and ends "canceled" */
function tailEvents(path: string): { url: string; cpu: number; outcome: string }[] {
	const text = readFileSync(path, 'utf8');
	const out: { url: string; cpu: number; outcome: string }[] = [];
	let depth = 0;
	let start = -1;
	let str = false;
	for (let i = 0; i < text.length; i++) {
		const ch = text[i];
		if (str) {
			if (ch === '\\') i++;
			else if (ch === '"') str = false;
			continue;
		}
		if (ch === '"') str = true;
		else if (ch === '{') {
			if (depth++ === 0) start = i;
		} else if (ch === '}' && --depth === 0) {
			const e = JSON.parse(text.slice(start, i + 1));
			if (e.event?.request?.url && e.executionModel === 'durableObject')
				out.push({ url: e.event.request.url, cpu: e.cpuTime, outcome: e.outcome });
		}
	}
	return out;
}

async function deployed(base: string, tailPath: string) {
	const get = async (path: string) => {
		const r = await fetch(new URL(path, base));
		if (!r.ok) throw new Error(`${path}: ${r.status} ${await r.text()}`);
		return r.json() as Promise<Record<string, unknown>>;
	};
	const first = await get('/burn?n=6e8');
	const second = await get('/burn?n=6e8');
	console.log(`placement: instance ${first.instance === second.instance ? 'kept' : 'replaced'} after the first burn`);
	console.log(JSON.stringify(await get('/features'), null, 1));
	const results = new Map<string, Set<string>>();
	for (let r = 0; r < ROUNDS; r++)
		for (const row of rows)
			for (const [m, f] of row.arms)
				for (const n of [row.n / 10, row.n]) {
					const body = await get(`/run?m=${m}&f=${f}&n=${n}&round=${r}`);
					if (n === row.n) results.set(`${m}.${f}`, (results.get(`${m}.${f}`) ?? new Set()).add(String(body.result)));
				}
	console.log('waiting 20 s for tail to flush');
	await new Promise((ok) => setTimeout(ok, 20_000));
	report(tailPath, results);
}

/** ns per op from a tail file; `results` (each arm's return values) when this run sent the requests */
function report(tailPath: string, results = new Map<string, Set<string>>()) {
	const events = tailEvents(tailPath).filter((e) => e.url.includes('/run?'));
	const cpu = (m: string, f: string, n: number, r: number) =>
		events.find((e) => e.url.includes(`m=${m}&f=${f}&n=${n}&round=${r}`))?.cpu;
	// round 0 instantiates and first compiles each module inside its small call, so it is left out;
	// co-tenants move single events by +-20%, so each size is its median over the other rounds
	const median = (v: number[]) => [...v].sort((a, b) => a - b)[v.length >> 1]!;
	for (const row of rows) {
		const per = row.arms.map(([m, f]) => {
			const big: number[] = [];
			const small: number[] = [];
			for (let r = 1; r < ROUNDS; r++) {
				const b = cpu(m, f, row.n, r);
				const s = cpu(m, f, row.n / 10, r);
				if (b !== undefined && s !== undefined) big.push(b), small.push(s);
			}
			if (!big.length) return `${f} no tail events`;
			const ns = (b: number, s: number) => ((b - s) * 1e6) / (row.n * 0.9 * row.per);
			const each = big.map((b, i) => ns(b, small[i]!));
			return (
				`${f} ${ns(median(big), median(small)).toFixed(3)} ns ` +
				`(${Math.min(...each).toFixed(2)}-${Math.max(...each).toFixed(2)}, ${big.length} rounds)`
			);
		});
		const res = row.arms.map(([m, f]) => [...(results.get(`${m}.${f}`) ?? [])].join('|'));
		const differ = results.size && new Set(res).size > 1 ? ` (results differ: ${res.join(' / ')})` : '';
		console.log(`${row.name}: ${per.join(', ')}${differ}`);
	}
	const bad = events.filter((e) => e.outcome !== 'ok');
	if (bad.length) console.log(`${bad.length} events not ok: ${bad.map((e) => e.outcome).join(', ')}`);
}

const [mode, ...rest] = process.argv.slice(2);
if (mode === 'local') local();
else if (mode === 'deployed') await deployed(rest[0]!, rest[1]!);
else if (mode === 'report') report(rest[0]!);
else console.log('usage: drive.ts local | deployed <url> <tail.jsonl> | report <tail.jsonl>');
