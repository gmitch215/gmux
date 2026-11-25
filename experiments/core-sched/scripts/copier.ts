import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Domain, jsCopier, READ, WRITE } from '../../../src/worker/machine/domain.ts';

/**
 * Times the copy module against the typed-array copier on spans of 64 B, 4 KiB and 64 KiB, in, out
 * and zero, in ns per call (the median of ROUNDS rounds of CALLS calls). Prints one JSON line.
 * `GMUX_BUILD=<dir with router/copy.wasm> node --experimental-strip-types copier.ts`
 */
const build = process.env.GMUX_BUILD;
if (!build) throw new Error('GMUX_BUILD names the build directory with router/copy.wasm');
const calls = Number(process.env.CALLS ?? 200000);
const rounds = Number(process.env.ROUNDS ?? 5);
const copy = new WebAssembly.Module(readFileSync(join(build, 'router/copy.wasm')));
const shared = () => new WebAssembly.Memory({ initial: 4, maximum: 64, shared: true });
const kernel = shared();
const user = shared();
const arms = {
	module: new Domain(user, READ | WRITE, kernel, copy).copier!,
	views: jsCopier(kernel, user)
};
const median = (xs: number[]) => xs.sort((a, b) => a - b)[xs.length >> 1]!;
const out: Record<string, number> = {};
for (const size of [64, 4096, 65536]) {
	for (const op of ['in', 'out', 'zero'] as const) {
		for (const [name, copier] of Object.entries(arms)) {
			const run = () => {
				const start = process.hrtime.bigint();
				if (op === 'zero') for (let i = 0; i < calls; i++) copier.zero(4096, size);
				else for (let i = 0; i < calls; i++) copier[op](4096, 4096 + 65536, size);
				return Number(process.hrtime.bigint() - start) / calls;
			};
			run();
			out[`${name}.${op}.${size}`] = median(Array.from({ length: rounds }, run));
		}
	}
}
console.log(JSON.stringify(out));
