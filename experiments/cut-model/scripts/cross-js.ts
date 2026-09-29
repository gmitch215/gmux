import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * The crossings between JS and wasm, each priced alone: the same loop with the crossing in it and
 * out of it, n and 2n iterations (the fixed part cancels), arms interleaved in a rotating order.
 *
 * - `js-wasm`: a JS loop calling a wasm export, against the same loop calling a JS function;
 * - `wasm-js`: V8 wasm calling a JS import, against the loop with no call;
 * - `burrow-host`: a wasm3 guest calling a host import that returns, against the empty loop;
 * - `burrow-native`: a wasm3 guest calling a promoted function's thunk (import, then JS, then a V8
 *   export that sets the stack pointer), against the empty loop (B20's crossing);
 * - `burrow-local`: a wasm3 guest calling a function of its own, against the empty loop.
 *
 * `node --experimental-strip-types cross-js.ts <burrow dist> [rounds, default 15]`, prints JSON.
 */
const here = dirname(fileURLToPath(import.meta.url));
const src = join(here, '..', 'src');
const [burrowDist = '', roundsArg = '15'] = process.argv.slice(2);
const rounds = Number(roundsArg);
const wat = (f: string) => execFileSync('wasm-tools', ['parse', join(src, f), '-o', '/dev/stdout'], { maxBuffer: 1 << 24 });

const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[xs.length >> 1]!;
const summary = (xs: number[]) => ({ median: median(xs), min: Math.min(...xs), max: Math.max(...xs), spread: (Math.max(...xs) - Math.min(...xs)) / median(xs) });

const lock = join(dirname(dirname(dirname(here))), 'build', 'batch', 'mac-bench.lock');
async function locked<T>(f: () => Promise<T>): Promise<T> {
	for (;;) {
		try {
			mkdirSync(lock);
			break;
		} catch {
			await new Promise((r) => setTimeout(r, 15000));
		}
	}
	try {
		return await f();
	} finally {
		rmdirSync(lock);
	}
}

const crossBytes = wat('cross.wat');
const nativeBytes = wat('native.wat');
const nativeExports = new WebAssembly.Instance(new WebAssembly.Module(nativeBytes)).exports as { f_nop: (sp: number, a: number) => number };
const jsHost = (a: number) => (a + 1) | 0;
const jsThunk = (sp: number, a: number) => nativeExports.f_nop(sp, a);
const v8 = new WebAssembly.Instance(new WebAssembly.Module(crossBytes), { native: { host: jsHost, thunk: jsThunk } }).exports as Record<string, (n: number) => number>;
const nop = v8.nop!;
const jsFn = (a: number) => (a + 1) | 0;
// polymorphic on purpose: a monomorphic closure the JIT inlines away would price nothing
const sink = { f: jsFn as (a: number) => number };
sink.f = (a) => (a + 1) | 0;

function jsLoopWasm(n: number) {
	let s = 0;
	for (let i = 0; i < n; i++) s = nop(s);
	return s;
}
function jsLoopJs(n: number) {
	let s = 0;
	for (let i = 0; i < n; i++) s = sink.f(s);
	return s;
}

const { createInterpreter } = await import(`${burrowDist}/interpret.js`);
const wasm3Module = new WebAssembly.Module(readFileSync(`${burrowDist}/vendor/wasm3.wasm`));
const vm = await createInterpreter({ module: wasm3Module });
const guest = vm.load(new Uint8Array(crossBytes), {
	imports: {
		native: {
			host: { signature: 'i(i)', fn: jsHost },
			thunk: { signature: 'i(ii)', fn: jsThunk }
		}
	}
});
const b = (name: string) => (n: number) => guest.call(name, n) >>> 0;

interface Arm {
	name: string;
	run: (n: number) => number;
	n: number;
}
const arms: Arm[] = [
	{ name: 'js-loop-js', run: jsLoopJs, n: 4_000_000 },
	{ name: 'js-loop-wasm', run: jsLoopWasm, n: 4_000_000 },
	{ name: 'v8-empty', run: v8.empty!, n: 20_000_000 },
	{ name: 'v8-local', run: v8.local!, n: 20_000_000 },
	{ name: 'v8-host', run: v8.host!, n: 4_000_000 },
	{ name: 'v8-thunk', run: v8.thunk!, n: 4_000_000 },
	{ name: 'burrow-empty', run: b('empty'), n: 2_000_000 },
	{ name: 'burrow-local', run: b('local'), n: 1_000_000 },
	{ name: 'burrow-host', run: b('host'), n: 200_000 },
	{ name: 'burrow-thunk', run: b('thunk'), n: 200_000 }
];

const time = (f: () => number) => {
	const t = performance.now();
	f();
	return performance.now() - t;
};
// ns per iteration: (t(2n) - t(n)) / n
const perIter = (a: Arm) => ((time(() => a.run(2 * a.n)) - time(() => a.run(a.n))) * 1e6) / a.n;

const samples = await locked(async () => {
	for (const a of arms) for (let k = 0; k < 3; k++) perIter(a);
	const got = new Map(arms.map((a) => [a.name, [] as number[]]));
	for (let r = 0; r < rounds; r++)
		for (let k = 0; k < arms.length; k++) {
			const a = arms[(k + r) % arms.length]!;
			got.get(a.name)!.push(perIter(a));
		}
	return got;
});

const arm = Object.fromEntries([...samples].map(([k, v]) => [k, { ...summary(v), samples: v }]));
// a kind's cost: its arm less its control, the medians and the spread of the paired rounds' differences
const pair = (name: string, control: string) => {
	const d = arm[name]!.samples.map((x, i) => x - arm[control]!.samples[i]!);
	return { kind: name, control, ...summary(d) };
};
const kinds = [
	pair('js-loop-wasm', 'js-loop-js'),
	pair('v8-host', 'v8-empty'),
	pair('v8-thunk', 'v8-empty'),
	pair('burrow-local', 'burrow-empty'),
	pair('burrow-host', 'burrow-empty'),
	pair('burrow-thunk', 'burrow-empty')
];
console.log(JSON.stringify({ node: process.version, v8: process.versions.v8, burrow: 'dist of the drupflare burrow package', rounds, unit: 'ns per iteration (crossing = kinds[])', arms, kinds }, null, '\t'));
