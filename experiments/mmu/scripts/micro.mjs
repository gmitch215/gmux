// the per-load cost of a page table lookup in V8, apart from the kernel and the programs
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
const src = new URL('../src/micro.wat', import.meta.url).pathname;
execFileSync('wat2wasm', ['--enable-multi-memory', src, '-o', '/tmp/gmux-g1-micro.wasm']);
const k = new WebAssembly.Instance(new WebAssembly.Module(readFileSync('/tmp/gmux-g1-micro.wasm'))).exports;
const n = 16 << 20;
for (const f of ['plain', 'second', 'same', 'hoisted', 'nested']) for (let i = 0; i < 50; i++) k[f](1 << 12, 1);
const time = (f) => {
	const t0 = performance.now();
	k[f](n, 20);
	return performance.now() - t0;
};
const best = (f) => Math.min(...Array.from({ length: 5 }, () => time(f)));
const plain = best('plain');
if (k.hoisted(n, 1) !== k.plain(n, 1)) throw new Error('hoisted sum differs');
console.log(JSON.stringify({ plainMs: +plain.toFixed(1), second: +(best('second') / plain).toFixed(2), same: +(best('same') / plain).toFixed(2), hoisted: +(best('hoisted') / plain).toFixed(2), hoistedVsSameShape: +(best('hoisted') / best('nested')).toFixed(2) }));
