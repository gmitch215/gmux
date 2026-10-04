import { readFileSync } from 'node:fs';

/**
 * Prints a row for src/gmux/katybug/prim.c's glibc table: a function's whole machine code in a libc.so.6
 * (length, first eight bytes, FNV-1a hash). A function is name:address:size from readelf -s of the
 * library's debug file (libc6-dbg); the text segment maps file offset to the same address.
 * `node --experimental-strip-types tests/c/katybug/glibc-sigs.ts <libc.so.6> name:0xaddr:size...`
 */
const [file, ...fns] = process.argv.slice(2);
if (!file || !fns.length) {
	console.error('usage: glibc-sigs.ts <libc.so.6> name:0xaddr:size...');
	process.exit(2);
}
const lib = readFileSync(file);
const fnv = (b: Buffer): bigint => {
	let h = 0xcbf29ce484222325n;
	for (const x of b) h = ((h ^ BigInt(x)) * 0x100000001b3n) & 0xffffffffffffffffn;
	return h;
};
for (const f of fns) {
	const [name, addr, size] = f.split(':');
	const b = lib.subarray(Number(addr), Number(addr) + Number(size));
	console.log(
		`${b.length}, 0x${b.readBigUInt64LE(0).toString(16).padStart(16, '0')}ull, 0x${fnv(b).toString(16).padStart(16, '0')}ull}, /* ${name} */`
	);
}
