import { readFileSync } from 'node:fs';

/**
 * Compares two outputs of x86-ops: per instruction form, how many cases differ, and the first one.
 * `x86-ops-diff.ts x86-ops.S native.bin katybug.bin`
 */
const [asm, first, second] = process.argv.slice(2);
const labels = [...readFileSync(asm!, 'utf8').matchAll(/^\t# (.*)$/gm)].map((m) => m[1]!);
const a = readFileSync(first!);
const b = readFileSync(second!);
const names = ['rax', 'rbx', 'rcx', 'rdx', 'flags', 'mem'];
const words = (buf: Buffer, i: number) => {
	const block = Buffer.alloc(48);
	buf.copy(block, 0, 48 * i, 48 * i + 48);
	return names.map((_, k) => block.readBigUInt64LE(8 * k));
};
const bad = new Map<string, string[]>();
labels.forEach((label, i) => {
	const x = a.subarray(48 * i, 48 * i + 48);
	const y = b.subarray(48 * i, 48 * i + 48);
	if (x.equals(y)) return;
	const xs = words(a, i);
	const ys = words(b, i);
	const diff = names
		.map((n, k) =>
			xs[k] !== ys[k] ? `${n} 0x${xs[k]!.toString(16)}/0x${ys[k]!.toString(16)}` : ''
		)
		.filter(Boolean);
	const form = label.split('#')[0]!;
	if (!bad.has(form)) bad.set(form, []);
	bad.get(form)!.push(`${label}: ${diff.join(', ')}`);
});
for (const [form, cases] of bad) console.log(`${form}: ${cases.length} differ; ${cases[0]}`);
const differing = [...bad.values()].reduce((n, v) => n + v.length, 0);
console.log(`${labels.length - differing}/${labels.length} cases equal`);
process.exit(bad.size ? 1 : 0);
