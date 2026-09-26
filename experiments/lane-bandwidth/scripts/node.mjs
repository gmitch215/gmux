// the same kernel in node on this host: a reference for the deployed lane
import { readFileSync } from 'node:fs';
const k = new WebAssembly.Instance(new WebAssembly.Module(readFileSync(new URL('../src/stream.wasm', import.meta.url)))).exports;
// wasm has no on-stack replacement: small calls first, so the measured one runs optimized code
k.fill(1 << 20);
for (let i = 0; i < 200; i++) k.simd(1 << 16, 1), k.scalar(1 << 16, 1);
for (const mb of [16, 64, 128]) {
	const bytes = mb * 2 ** 20;
	k.fill(bytes);
	for (const kind of ['simd', 'scalar']) {
		const passes = Math.max(1, Math.round(2048 / mb));
		const t0 = performance.now();
		kind === 'simd' ? k.simd(bytes, passes) : k.scalar(bytes, passes);
		const ms = performance.now() - t0;
		console.log(JSON.stringify({ kind, mb, passes, ms: Math.round(ms), gbps: +((bytes * passes) / ms / 1e6).toFixed(2) }));
	}
}
