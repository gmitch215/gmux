// what a cold checkpoint handler around each call costs while nothing throws
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
const src = new URL('../src/micro.wat', import.meta.url).pathname;
execFileSync('wat2wasm', ['--enable-exceptions', src, '-o', '/tmp/gmux-g2-micro.wasm']);
const k = new WebAssembly.Instance(new WebAssembly.Module(readFileSync('/tmp/gmux-g2-micro.wasm'))).exports;
for (let i = 0; i < 200; i++) k.fib(15), k.fib_flat(15), k.fib_eh(15), k.loop(1000), k.loop_eh(1000);
const best = (f, arg) => Math.min(...Array.from({ length: 7 }, () => { const t = performance.now(); f(arg); return performance.now() - t; }));
if (k.fib(30) !== k.fib_eh(30) || k.loop(1e6) !== k.loop_eh(1e6)) throw new Error('results differ');
const fibFlat = best(k.fib_flat, 32), fib = best(k.fib, 32), fibEh = best(k.fib_eh, 32), loop = best(k.loop, 5e7), loopEh = best(k.loop_eh, 5e7);
console.log(JSON.stringify({ fibMs: +fib.toFixed(1), fibRatio: +(fibEh / fib).toFixed(3), fibVsSameShape: +(fibEh / fibFlat).toFixed(3), loopMs: +loop.toFixed(1), loopRatio: +(loopEh / loop).toFixed(3) }));
