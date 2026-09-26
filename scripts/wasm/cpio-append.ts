import { readFileSync, writeFileSync } from 'node:fs';
import { concat } from './binary.ts';
import { file, trailer } from './cpio.ts';

/**
 * Appends a newc cpio archive with extra files to an initramfs; the kernel unpacks archives in
 * sequence. Parent directories are added, because the kernel does not create them for a file.
 * `pairs` are `path=source`. Returns the size written.
 */
export function appendCpio(base: string, dst: string, pairs: string[]): number {
	const dirs: string[] = [];
	for (const pair of pairs) {
		const parts = pair
			.split('=')[0]!
			.replace(/^\/+|\/+$/g, '')
			.split('/')
			.slice(0, -1);
		for (let n = 1; n <= parts.length; n++) {
			const dir = parts.slice(0, n).join('/');
			if (!dirs.includes(dir)) dirs.push(dir);
		}
	}
	const archive = [
		...dirs.map((d, i) => file(d, new Uint8Array(), 0o040755, 900 + i)),
		...pairs.map((pair, i) => {
			const [path, src, ...rest] = pair.split('=');
			if (!src || rest.length)
				throw new Error(`cpio-append: expected path=source, got ${pair}`);
			return file(path!.replace(/^\/+/, ''), readFileSync(src), 0o100755, 1000 + i);
		}),
		trailer()
	];
	const data = readFileSync(base);
	const out = concat([data, new Uint8Array((4 - (data.length % 4)) % 4), ...archive]);
	writeFileSync(dst, out);
	return out.length;
}

if (import.meta.main) {
	const [base, dst, ...pairs] = process.argv.slice(2);
	console.log(`${dst}: ${appendCpio(base!, dst!, pairs)} bytes`);
}
