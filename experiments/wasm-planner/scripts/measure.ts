import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { plan } from './planner.ts';

/**
 * Ops removed and exactness for one guest: `measure.ts <name> <guest.wasm> <out dir> <burrow dist>`.
 *
 * Plans the guest, validates the result, counts dynamic instructions of both with the promotion-cut
 * graph (a unit is run(2) less run(1), so setup cancels), and compares `run(n)` of the two under V8
 * and under burrow's wasm3 for n = 1, 2, 3, and every pass alone. Nothing here is timed.
 */
const [name = '', guest = '', out = '', dist = ''] = process.argv.slice(2);
if (!name || !guest || !out || !dist) throw new Error('usage: measure.ts <name> <guest.wasm> <out dir> <burrow dist>');
mkdirSync(out, { recursive: true });

const original = new Uint8Array(readFileSync(guest));
const { bytes, stats } = plan(original);
const plannedPath = join(out, `${name}.planned.wasm`);
writeFileSync(plannedPath, bytes);
execFileSync('wasm-tools', ['validate', plannedPath]);

const graph = join(dirname(new URL(import.meta.url).pathname), '../../promotion-cut/scripts/graph.ts');
const dynamic = (path: string, tag: string) => {
	const file = join(out, `${name}.${tag}.graph.json`);
	execFileSync('node', ['--no-warnings', '--experimental-strip-types', graph, path, file], { maxBuffer: 1 << 28, timeout: 1_200_000 });
	return JSON.parse(readFileSync(file, 'utf8')) as { total: number; checksum: number };
};
const before = dynamic(guest, 'orig');
const after = dynamic(plannedPath, 'planned');

const run = (b: Uint8Array<ArrayBuffer>, n: number) => ((new WebAssembly.Instance(new WebAssembly.Module(b)).exports.run as (n: number) => number)(n) >>> 0).toString(16);
const { createInterpreter } = await import(`${dist}/interpret.js`);
const wasm3 = new WebAssembly.Module(readFileSync(`${dist}/vendor/wasm3.wasm`));
const interp = async (b: Uint8Array<ArrayBuffer>, n: number) => {
	const vm = await createInterpreter({ module: wasm3 });
	return ((vm.load(b).call('run', n) as number) >>> 0).toString(16);
};

const exact: Record<string, string> = {};
const mismatches: string[] = [];
const alone = Object.fromEntries(['unreachable', 'prune', 'propagate', 'drops', 'deadlocals', 'unwrap', 'deadfunc'].map((p) => [p, plan(original, new Set([p])).bytes]));
for (const n of [1, 2, 3]) {
	const want = run(original, n);
	const got = [['v8 planned', run(bytes, n)], ['wasm3 original', await interp(original, n)], ['wasm3 planned', await interp(bytes, n)]];
	for (const [p, b] of Object.entries(alone)) got.push([`v8 ${p} alone`, run(b, n)]);
	exact[`run(${n})`] = want;
	for (const [label, v] of got) if (v !== want) mismatches.push(`run(${n}) ${label}: ${v} against ${want}`);
}

const result = { name, guest, bytesIn: original.length, bytesOut: bytes.length, stats, dynamicBefore: before.total, dynamicAfter: after.total, checksums: exact, mismatches };
writeFileSync(join(out, `${name}.measure.json`), JSON.stringify(result, null, '\t'));
console.log(JSON.stringify(result));
if (mismatches.length) process.exit(1);
