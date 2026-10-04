import { readFileSync, writeFileSync } from 'node:fs';

/**
 * Writes libm-vectors.txt from three runs of `libm gen` over the same inputs: glibc 2.36 on x86-64
 * with FMA and AVX2 off (GLIBC_TUNABLES=glibc.cpu.hwcaps=-AVX2,-FMA,-FMA4, which is the variant
 * katybug's cpuid selects), glibc 2.36 on AArch64, and musl 1.2.5 on AArch64. Each line is
 * `fn x y x86 a64-glibc a64-musl`, all as 16 hex digits ('-' for the y of exp and log).
 * `node --experimental-strip-types tests/c/katybug/libm-vectors.ts <x86 glibc> <a64 glibc> <a64 musl> <out>`
 */
const [x86, glibc, musl, out] = process.argv.slice(2);
if (!x86 || !glibc || !musl || !out) {
	console.error('usage: libm-vectors.ts <x86 glibc> <a64 glibc> <a64 musl> <out>');
	process.exit(2);
}
const read = (p: string) => readFileSync(p, 'utf8').trim().split('\n');
const [a, b, c] = [x86, glibc, musl].map(read);
if (a.length !== b.length || a.length !== c.length) throw new Error('the runs differ in length');
const lines = [
	'# libm-vectors.ts: fn x y glibc-2.36-x86-64-non-fma glibc-2.36-aarch64 musl-1.2.5-aarch64'
];
for (let i = 0; i < a.length; i++) {
	const [fn, x, y, r1] = a[i].split(' ');
	const [fn2, x2, y2, r2] = b[i].split(' ');
	const [fn3, x3, y3, r3] = c[i].split(' ');
	if (fn !== fn2 || fn !== fn3 || x !== x2 || x !== x3 || y !== y2 || y !== y3)
		throw new Error(`line ${i + 1}: the inputs differ`);
	lines.push(`${fn} ${x} ${y} ${r1} ${r2} ${r3}`);
}
writeFileSync(out, `${lines.join('\n')}\n`);
console.log(`${a.length} vectors`);
