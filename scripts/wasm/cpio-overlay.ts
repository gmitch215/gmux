import { gunzipSync, gzipSync } from 'fflate';
import { readFileSync, writeFileSync } from 'node:fs';
import { concat, text, utf8 } from './binary.ts';
import { entry, file } from './cpio.ts';

/**
 * Puts files into a gzipped initramfs: an entry of the same path is replaced, the others are kept in
 * order, new files and the directories they need go before the trailer. Files under bin/ and
 * etc/init.d/ are executable. `cpio-overlay.ts <in.cpio.gz> <out.cpio.gz> <path=source>...`
 */
export function overlay(base: Uint8Array, pairs: string[]): Uint8Array {
	const files = pairs.map((pair) => {
		const [path, src, ...rest] = pair.split('=');
		if (!path || !src || rest.length)
			throw new Error(`cpio-overlay: expected path=source, got ${pair}`);
		return { path: path.replace(/^\/+/, ''), data: new Uint8Array(readFileSync(src)) };
	});
	const replaced = new Set(files.map((f) => f.path));
	const data = gunzipSync(base);
	const magic = utf8.encode('070701');
	const at = (p: number) => magic.every((b, i) => data[p + i] === b);
	const out: Uint8Array[] = [];
	const present = new Set<string>();
	let p = 0;
	while (at(p)) {
		const head = text.decode(data.subarray(p, p + 110));
		const fields = Array.from({ length: 13 }, (_, i) =>
			parseInt(head.slice(6 + 8 * i, 14 + 8 * i), 16)
		);
		const [size, nameLen] = [fields[6]!, fields[11]!];
		const nameAt = p + 110;
		const name = text.decode(data.subarray(nameAt, nameAt + nameLen - 1));
		const bodyAt = nameAt + nameLen + ((4 - ((110 + nameLen) % 4)) % 4);
		const body = data.subarray(bodyAt, bodyAt + size);
		p = bodyAt + size + ((4 - (size % 4)) % 4);
		if (name === 'TRAILER!!!') {
			// the new entries go in before the first trailer; a later archive is left as it is
			const dirs = [...new Set(files.flatMap((f) => parents(f.path)))].filter(
				(d) => !present.has(d)
			);
			out.push(
				...dirs.map((d, i) => file(d, new Uint8Array(), 0o040755, 0x7000 + i)),
				...files.map((f, i) =>
					file(
						f.path,
						f.data,
						/^(bin|etc\/init\.d)\//.test(f.path) ? 0o100755 : 0o100644,
						0x7100 + i
					)
				)
			);
			out.push(entry(fields, name, body));
			while (data[p] === 0) p++;
			files.length = 0;
			continue;
		}
		present.add(name);
		if (!replaced.has(name)) out.push(entry(fields, name, body));
	}
	if (files.length) throw new Error('cpio-overlay: the archive has no trailer');
	return gzipSync(concat(out), { level: 9, mtime: 0 });
}

function parents(path: string): string[] {
	const parts = path.split('/').slice(0, -1);
	return parts.map((_, n) => parts.slice(0, n + 1).join('/'));
}

if (import.meta.main) {
	const [src, dst, ...pairs] = process.argv.slice(2);
	const out = overlay(new Uint8Array(readFileSync(src!)), pairs);
	writeFileSync(dst!, out);
	console.log(`${dst}: ${out.length} bytes`);
}
