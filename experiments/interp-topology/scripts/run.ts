import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

/**
 * The interpreter topology arms on one integer guest module: V8 running it natively, burrow's wasm3
 * hosted as wasm32, Katybug's IR interpreter hosted as wasm32 (emcc), and both interpreters built
 * natively. Each arm runs every kernel at n and 2n and keeps the difference, so startup, module
 * loading and decode cancel; every checksum must equal V8's.
 *
 * `run.ts <guests.wasm> <burrow dist> <katybug native> <katybug-hosted.js> <wasm3-native> [rounds]`
 */
const [guests = '', burrowDist = '', kbNative = '', kbHosted = '', w3Native = '', roundsArg = '3'] = process.argv.slice(2);
const rounds = Number(roundsArg);
const bytes = readFileSync(guests);

// n per kernel, sized so V8 takes tens of milliseconds at 2n
const kernels: Record<string, number> = {
	chain: 100_000_000,
	crc32: 200,
	sha256: 200_000,
	sieve: 10,
	sort: 40,
	fib: 1_000,
	matmul: 400
};
const pick = (process.env.ONLY ?? '').split(',').filter(Boolean);
const names = Object.keys(kernels).filter((k) => !pick.length || pick.includes(k));

const { createInterpreter } = await import(`${burrowDist}/interpret.js`);
const wasm3 = await createInterpreter({ module: new WebAssembly.Module(readFileSync(`${burrowDist}/vendor/wasm3.wasm`)) });
const guest = wasm3.load(bytes);
const native = new WebAssembly.Instance(new WebAssembly.Module(bytes)).exports as Record<string, (n: number) => number>;

type Arm = (kernel: string, n: number) => { ms: number; sum: number };
const inProcess = (call: (k: string, n: number) => number): Arm => (k, n) => {
	const t = performance.now();
	const sum = call(k, n) >>> 0;
	return { ms: performance.now() - t, sum };
};
const spawn = (cmd: string, pre: string[]): Arm => (k, n) => {
	const t = performance.now();
	const out = execFileSync(cmd, [...pre, k, n.toString(16)], { encoding: 'utf8' });
	const ms = performance.now() - t;
	const m = out.match(/= ([0-9a-f]+)/);
	if (!m) throw new Error(`${cmd} ${k}: ${out}`);
	return { ms, sum: Number.parseInt(m[1]!, 16) >>> 0 };
};
const arms: Record<string, Arm> = {
	v8: inProcess((k, n) => native[k]!(n)),
	'wasm3 hosted': inProcess((k, n) => guest.call(k, n)),
	'katybug hosted': spawn(process.execPath, [kbHosted, '--wasm', guests]),
	'wasm3 native': spawn(w3Native, [guests]),
	'katybug native': spawn(kbNative, ['--wasm', guests])
};
const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]!;

const armNames = Object.keys(arms);
console.log(`| kernel | ${armNames.map((a) => `${a} ms`).join(' | ')} | wasm3 hosted/native | katybug hosted/native |`);
console.log(`| --- | ${armNames.map(() => '---').join(' | ')} | --- | --- |`);
for (const k of names) {
	const n = kernels[k]!;
	const reference = native[k]!(2 * n) >>> 0;
	const per: Record<string, number> = {};
	for (const a of armNames) {
		const diffs: number[] = [];
		try {
			for (let r = 0; r < rounds; r++) {
				const one = arms[a]!(k, n);
				const two = arms[a]!(k, 2 * n);
				if (two.sum !== reference) throw new Error(`${a} ${k}: ${two.sum.toString(16)} against v8 ${reference.toString(16)}`);
				diffs.push(two.ms - one.ms);
			}
			per[a] = median(diffs);
		} catch (e) {
			// an arm that cannot run a kernel (an unsupported instruction) is reported, never skipped
			if (!/trap unsupported/.test(String(e))) throw e;
			per[a] = Number.NaN;
		}
	}
	const v8 = per.v8!;
	const cell = (a: string) => (Number.isNaN(per[a]) ? 'unsupported' : `${per[a]!.toFixed(1)} (${(per[a]! / v8).toFixed(1)}x)`);
	const ratio = (x: string, y: string) => (Number.isNaN(per[x]! / per[y]!) ? 'n/a' : (per[x]! / per[y]!).toFixed(2));
	console.log(`| ${k} | ${armNames.map(cell).join(' | ')} | ${ratio('wasm3 hosted', 'wasm3 native')} | ${ratio('katybug hosted', 'katybug native')} |`);
}
