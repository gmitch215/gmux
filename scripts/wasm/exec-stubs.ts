import { gunzipSync, gzipSync } from 'fflate';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { concat, readLeb, text, uleb, utf8 } from './binary.ts';
import { entry } from './cpio.ts';

/**
 * Rewrites an initramfs so each wasm executable is a stub: its header, its dylink.0 section (all
 * binfmt_wasm reads) and a gmux.exec section holding the SHA-256 of the full file, the registry key.
 * The host already holds the compiled module, so a machine no longer keeps the code in its RAM.
 * The output is gzip from fflate, whose bytes are the same on every platform and runtime.
 * `exec-stubs.ts <initramfs.cpio.gz> <out>`
 */
const MAGIC = Uint8Array.of(0, 0x61, 0x73, 0x6d, 1, 0, 0, 0);

/** a program's stub: its header, dylink.0 and the gmux.exec key; null for a file binfmt_wasm does not run */
export function stub(data: Uint8Array): Uint8Array | null {
	if (data.length < 10 || data[8] !== 0 || MAGIC.some((b, i) => data[i] !== b)) return null;
	const [size, body] = readLeb(data, 9);
	const [nameLen, name] = readLeb(data, body);
	if (text.decode(data.subarray(name, name + nameLen)) !== 'dylink.0') return null;
	const payload = concat([
		utf8.encode('\x09gmux.exec'),
		createHash('sha256').update(data).digest()
	]);
	return concat([
		MAGIC,
		data.subarray(8, body + size),
		Uint8Array.of(0),
		uleb(payload.length),
		payload
	]);
}

if (import.meta.main) {
	const [src, dst] = process.argv.slice(2);
	const data = gunzipSync(readFileSync(src!));
	const out: Uint8Array[] = [];
	const stubbed: string[] = [];
	const magic = utf8.encode('070701');
	const at = (p: number) => magic.every((b, i) => data[p + i] === b);
	let p = 0;
	// the kernel unpacks archives one after another, NUL padding between them
	while (at(p)) {
		const head = text.decode(data.subarray(p, p + 110));
		const fields = Array.from({ length: 13 }, (_, i) =>
			parseInt(head.slice(6 + 8 * i, 14 + 8 * i), 16)
		);
		const [mode, size, nameLen] = [fields[1]!, fields[6]!, fields[11]!];
		const nameAt = p + 110;
		const name = text.decode(data.subarray(nameAt, nameAt + nameLen - 1));
		const bodyAt = nameAt + nameLen + ((4 - ((110 + nameLen) % 4)) % 4);
		let body = data.subarray(bodyAt, bodyAt + size);
		p = bodyAt + size + ((4 - (size % 4)) % 4);
		const small = (mode & 0o170000) === 0o100000 ? stub(body) : null;
		if (small) {
			stubbed.push(`${name} ${size} -> ${small.length}`);
			body = small;
			fields[6] = small.length;
		}
		out.push(entry(fields, name, body));
		if (name === 'TRAILER!!!') while (data[p] === 0) p++;
	}
	writeFileSync(dst!, gzipSync(concat(out), { level: 9, mtime: 0 }));
	console.log(stubbed.join('\n'));
}
