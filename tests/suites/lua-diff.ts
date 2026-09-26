import { readFileSync } from 'node:fs';

/**
 * The Lua suite's two columns: each file's PASS or FAIL natively and in gmux, and where they differ.
 * `lua-diff.ts native.txt gmux.txt`
 */
function load(path: string): Map<string, string> {
	const out = new Map<string, string>();
	for (const line of readFileSync(path, 'utf8').split('\n')) {
		const [status, file] = line.trim().split(/\s+/);
		if ((status === 'PASS' || status === 'FAIL') && file) out.set(file, status);
	}
	return out;
}

const [first, second] = process.argv.slice(2);
const native = load(first!);
const gmux = load(second!);
const files = [...new Set([...native.keys(), ...gmux.keys()])].sort();
let agree = 0;
console.log(`${'file'.padEnd(18)} ${'native'.padEnd(7)} ${'gmux'.padEnd(7)}`);
for (const f of files) {
	const n = native.get(f) ?? '-';
	const g = gmux.get(f) ?? '-';
	if (n === g) agree++;
	console.log(`${f.padEnd(18)} ${n.padEnd(7)} ${g.padEnd(7)}${n === g ? '' : '  differs'}`);
}
const passes = (m: Map<string, string>) => [...m.values()].filter((v) => v === 'PASS').length;
console.log(
	`native ${passes(native)}/${native.size}, gmux ${passes(gmux)}/${gmux.size}, agree on ${agree}/${files.length}`
);
