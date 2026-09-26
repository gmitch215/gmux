// the reference side of the wasm corpus: V8 runs wasm-ops.calls on wasm-ops.wasm and prints each
// result as katybug --wasm does. `node wasm-ops.mjs <dir>`
import { readFileSync } from 'node:fs';

const dir = process.argv[2];
const module = new WebAssembly.Module(readFileSync(`${dir}/wasm-ops.wasm`));
const instance = new WebAssembly.Instance(module, {});
const types = Object.fromEntries(WebAssembly.Module.exports(module).map((e) => [e.name, e.kind]));
// V8's RuntimeError messages, as katybug names its traps
const kinds = [
	[/unreachable/, 'unreachable'],
	[/divide by zero|remainder by zero/, 'div0'],
	[/divide result unrepresentable|integer overflow/, 'overflow'],
	[/memory access out of bounds/, 'oob'],
	[/table index is out of bounds/, 'tableoob'],
	[/signature mismatch|null function|uninitialized element/, 'sig']
];
const params = new Map();
for (const line of readFileSync(`${dir}/wasm-ops.wat`, 'utf8').split('\n')) {
	const m = line.match(/\(func (?:\$\w+ )?\(export "([^"]+)"\)((?: \(param \w+\))*)/);
	if (m)
		params.set(
			m[1],
			[...m[2].matchAll(/\(param (\w+)\)/g)].map((p) => p[1])
		);
}
const hex = (v) => (typeof v === 'bigint' ? BigInt.asUintN(64, v) : BigInt(v >>> 0)).toString(16);
for (const line of readFileSync(`${dir}/wasm-ops.calls`, 'utf8').split('\n')) {
	const [name, ...raw] = line.trim().split(/\s+/);
	if (!name) continue;
	const args = raw.map((a, i) => {
		const v = BigInt(`0x${a}`);
		return params.get(name)?.[i] === 'i64'
			? BigInt.asIntN(64, v)
			: Number(BigInt.asIntN(32, v));
	});
	let out = `${name}(${raw.map((a) => BigInt(`0x${a}`).toString(16)).join(' ')})`;
	if (types[name] !== 'function') {
		console.log(`${out} no such export`);
		continue;
	}
	try {
		const r = instance.exports[name](...args);
		const values = r === undefined ? [] : Array.isArray(r) ? r : [r];
		out += ` =${values.map((v) => ` ${hex(v)}`).join('')}`;
	} catch (error) {
		const kind =
			kinds.find(([re]) => re.test(String(error.message)))?.[1] ?? String(error.message);
		out += ` trap ${kind}`;
	}
	console.log(out);
}
