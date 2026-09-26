import { readFileSync } from 'node:fs';
import { OPS, prepare } from '../src/work.ts';
const k = prepare(new WebAssembly.Module(readFileSync(new URL('../src/kernels.wasm', import.meta.url))));
for (const [kernel, reps] of [['sgemm', 40], ['dot8', 20], ['conv3', 40]] as const) {
	const t0 = performance.now();
	k[kernel](reps);
	const ms = performance.now() - t0;
	console.log(JSON.stringify({ kernel, gops: +((OPS[kernel]! * reps) / ms / 1e6).toFixed(2) }));
}
