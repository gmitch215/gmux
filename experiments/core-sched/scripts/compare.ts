import { readFileSync } from 'node:fs';

/**
 * Compares two `resume` traces by what they pick: every address (a run of six or more digits) is
 * renamed by the order it first appears, so two builds that lay the kernel's memory out differently
 * still compare equal when they pick the same task at every step. Exits 1 and prints the first
 * difference when they do not.
 * `node --experimental-strip-types experiments/core-sched/scripts/compare.ts <a.txt> <b.txt>`
 */
const [a, b] = process.argv.slice(2);
if (!a || !b) {
	console.error('usage: compare.ts <a.txt> <b.txt>');
	process.exit(2);
}
function canon(path: string): string[] {
	const names = new Map<string, string>();
	return readFileSync(path, 'utf8')
		.split('\n')
		.filter(Boolean)
		.map((line) =>
			line.replace(/\d{6,}/g, (n) => {
				if (!names.has(n)) names.set(n, `@${names.size}`);
				return names.get(n)!;
			})
		);
}
const left = canon(a);
const right = canon(b);
const n = Math.min(left.length, right.length);
for (let i = 0; i < n; i++)
	if (left[i] !== right[i]) {
		console.log(`line ${i + 1}: ${left[i]}  |  ${right[i]}`);
		process.exit(1);
	}
if (left.length !== right.length) {
	console.log(`one trace ends at line ${n}: ${left.length} lines against ${right.length}`);
	process.exit(1);
}
console.log(`${left.length} resumes, same`);
