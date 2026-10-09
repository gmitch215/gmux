import { readFileSync } from 'node:fs';

// the hash block bench (hashbench.c built for wasm32) under this node's V8: `hashbench-wasm.ts <wasm> [MiB per run] [runs]`
// prints the same columns as the native bench; the first run of each variant is a warm-up that lets V8 tier up
const [file = '', mibArg = '256', runsArg = '5'] = process.argv.slice(2);
const mib = Number(mibArg);
const runs = Number(runsArg);
const names = ['sha256 shipped', 'sha256 renamed', 'sha256 final 1 block a call', 'sha256 final', 'sha1 final', 'md5 final', 'sha512 final', 'cksum final'];
const { instance } = await WebAssembly.instantiate(readFileSync(file));
const run = instance.exports.run as (variant: number, reps: number) => number;
const reps = (mib * 1048576) / 32768;
const rate = names.map(() => [] as number[]);
const digest = names.map(() => 0);
for (let r = 0; r <= runs; r++)
	names.forEach((_, v) => {
		const t = performance.now();
		digest[v] = run(v, reps) >>> 0;
		const s = (performance.now() - t) / 1000;
		if (r) rate[v]!.push((mib * 1.048576) / s);
	});
console.log(`node ${process.version}, V8 ${process.versions.v8}, flags [${process.execArgv.join(' ')}]`);
names.forEach((name, v) => {
	const xs = [...rate[v]!].sort((a, b) => a - b);
	console.log(`${name}\t${xs[Math.floor(xs.length / 2)]!.toFixed(1)}\t${xs[0]!.toFixed(1)}-${xs[xs.length - 1]!.toFixed(1)}\t${digest[v]!.toString(16).padStart(8, '0')}`);
});
