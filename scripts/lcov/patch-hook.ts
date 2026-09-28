import { writeFileSync } from 'node:fs';

// node --import for scripts/lcov/patch.ts: every instance exporting gmux_cov, its i64 counters
// summed over instances into GMUX_PATCH_COVERAGE as the process exits
const out = process.env.GMUX_PATCH_COVERAGE!;
const memories: WebAssembly.Memory[] = [];
const noted = (i: WebAssembly.Instance) => {
	const m = i.exports.gmux_cov;
	if (m instanceof WebAssembly.Memory) memories.push(m);
	return i;
};
const W = WebAssembly as unknown as Record<string, unknown>;
const Instance = WebAssembly.Instance;
const Hooked = function (module: WebAssembly.Module, imports?: WebAssembly.Imports) {
	return noted(new Instance(module, imports));
};
Hooked.prototype = Instance.prototype;
W.Instance = Hooked;
const instantiate = WebAssembly.instantiate;
W.instantiate = async (...a: Parameters<typeof WebAssembly.instantiate>) => {
	const r = (await instantiate(...a)) as
		WebAssembly.Instance | WebAssembly.WebAssemblyInstantiatedSource;
	noted('instance' in r ? r.instance : r);
	return r;
};
process.on('exit', () => {
	const sum: number[] = [];
	for (const m of memories) {
		const a = new BigUint64Array(m.buffer);
		for (let k = 0; k < a.length; k++) sum[k] = (sum[k] ?? 0) + Number(a[k]);
	}
	writeFileSync(out, JSON.stringify(sum));
});
