import { readFileSync } from 'node:fs';

/**
 * Compares a transcript's native and katybug runs line by line (sections headed `== <n> <command>`).
 * `transcript-diff.ts native.txt katybug.txt`
 */
function split(path: string): Map<number, [string, string]> {
	const parts = readFileSync(path, 'utf8').split(/^== (\d+) (.*)$/m);
	const out = new Map<number, [string, string]>();
	for (let i = 1; i < parts.length; i += 3)
		out.set(Number(parts[i]), [parts[i + 1]!, parts[i + 2]!]);
	return out;
}

const [first, second] = process.argv.slice(2);
const a = split(first!);
const b = split(second!);
const clip = (s: string) => s.trim().slice(0, 300).replaceAll('\n', ' | ');
let ok = 0;
for (const n of [...a.keys()].sort((x, y) => x - y)) {
	const [line, x] = a.get(n)!;
	const y = b.get(n)?.[1] ?? '';
	if (x === y) {
		ok++;
		console.log(`PASS ${line}`);
	} else {
		console.log(`FAIL ${line}`);
		console.log('  native :', clip(x));
		console.log('  katybug:', clip(y));
	}
}
console.log(`${ok}/${a.size} lines equal`);
process.exit(ok === a.size ? 0 : 1);
