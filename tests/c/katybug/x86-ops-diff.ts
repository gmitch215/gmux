import { readFileSync } from 'node:fs';

/**
 * Compares two outputs of x86-ops (or a64-ops, with --a64): per instruction form, how many cases
 * differ, and the first one. `x86-ops-diff.ts x86-ops.S native.bin katybug.bin [--a64]`
 */
const [asm, first, second, arch] = process.argv.slice(2);
const labels = [...readFileSync(asm!, 'utf8').matchAll(/^\t# (.*)$/gm)].map((m) => m[1]!);
const a = readFileSync(first!);
const b = readFileSync(second!);
const names =
	arch === '--a64'
		? ['x0', 'x1', 'x2', 'x3', 'nzcv', 'mem0', 'mem8']
		: ['rax', 'rbx', 'rcx', 'rdx', 'flags', 'mem'];
const size = 8 * names.length;
// a run that died early leaves the rest of its cases as zeros
const words = (buf: Buffer, i: number) => {
	const block = Buffer.alloc(size);
	if (size * i < buf.length) buf.copy(block, 0, size * i, size * i + size);
	return names.map((_, k) => block.readBigUInt64LE(8 * k));
};
const bad = new Map<string, string[]>();
labels.forEach((label, i) => {
	const x = a.subarray(size * i, size * i + size);
	const y = b.subarray(size * i, size * i + size);
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
