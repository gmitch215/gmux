import { createHash } from 'node:crypto';
import { gunzipSync, gzipSync } from 'node:zlib';

/** one file of a build payload: a path relative to build/, its bytes and whether it is executable */
export interface PayloadFile {
	path: string;
	data: Uint8Array;
	executable: boolean;
}

/** the payload's table of contents, published beside the tarball */
export interface PayloadManifest {
	version: string;
	commit: string;
	files: Record<string, string>;
}

/** which files a lock pins: the release carrying the payload and the tarball's SHA-256 */
export interface PayloadLock {
	tag: string;
	asset: string;
	sha256: string;
}

export const sha256 = (bytes: Uint8Array): string =>
	createHash('sha256').update(bytes).digest('hex');

const BLOCK = 512;
const encoder = new TextEncoder();

function field(header: Uint8Array, offset: number, length: number, value: string) {
	const bytes = encoder.encode(value);
	if (bytes.length > length) throw new Error(`tar field too long: ${value}`);
	header.set(bytes, offset);
}

const octal = (value: number, length: number) => value.toString(8).padStart(length - 1, '0') + '\0';

function checkPath(path: string) {
	if (
		!path ||
		path.startsWith('/') ||
		path.split('/').some((part) => part === '..' || part === '')
	)
		throw new Error(`unsafe payload path: ${path}`);
	if (encoder.encode(path).length > 100) throw new Error(`payload path over 100 bytes: ${path}`);
}

/**
 * a gzipped ustar archive of `files`, byte for byte the same for the same input: sorted paths,
 * mtime 0, owner 0, modes 0644 or 0755, and a gzip header without a timestamp
 */
export function packTar(files: PayloadFile[]): Uint8Array {
	const sorted = [...files].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
	const blocks: Uint8Array[] = [];
	for (const file of sorted) {
		checkPath(file.path);
		const header = new Uint8Array(BLOCK);
		field(header, 0, 100, file.path);
		field(header, 100, 8, octal(file.executable ? 0o755 : 0o644, 8));
		field(header, 108, 8, octal(0, 8));
		field(header, 116, 8, octal(0, 8));
		field(header, 124, 12, octal(file.data.length, 12));
		field(header, 136, 12, octal(0, 12));
		header.fill(0x20, 148, 156);
		header[156] = 0x30;
		field(header, 257, 6, 'ustar\0');
		field(header, 263, 2, '00');
		let sum = 0;
		for (const byte of header) sum += byte;
		field(header, 148, 8, octal(sum, 7) + ' ');
		blocks.push(header, file.data, new Uint8Array(-file.data.length & (BLOCK - 1)));
	}
	blocks.push(new Uint8Array(BLOCK * 2));
	const tar = new Uint8Array(blocks.reduce((n, b) => n + b.length, 0));
	let at = 0;
	for (const block of blocks) tar.set(block, (at += block.length) - block.length);
	return new Uint8Array(gzipSync(tar, { level: 9 }));
}

/** the files of an archive packTar wrote; refuses anything else it finds */
export function unpackTar(archive: Uint8Array): PayloadFile[] {
	const tar = gunzipSync(archive);
	const decoder = new TextDecoder();
	const text = (offset: number, length: number) =>
		decoder.decode(tar.subarray(offset, offset + length)).replace(/\0[\s\S]*$/, '');
	const files: PayloadFile[] = [];
	for (let at = 0; at + BLOCK <= tar.length;) {
		if (tar.subarray(at, at + BLOCK).every((byte) => byte === 0)) break;
		const path = text(at, 100);
		const type = String.fromCharCode(tar[at + 156]!);
		if (type !== '0' && type !== '\0') throw new Error(`unsupported tar entry ${path}`);
		checkPath(path);
		const size = parseInt(text(at + 124, 12), 8);
		const mode = parseInt(text(at + 100, 8), 8);
		const start = at + BLOCK;
		if (!Number.isFinite(size) || start + size > tar.length)
			throw new Error(`truncated tar entry ${path}`);
		files.push({
			path,
			data: new Uint8Array(tar.subarray(start, start + size)),
			executable: (mode & 0o111) !== 0
		});
		at = start + size + (-size & (BLOCK - 1));
	}
	return files;
}

/** throws unless the archive is the one the lock pins and every file matches the manifest */
export function verify(archive: Uint8Array, lock: PayloadLock, manifest?: PayloadManifest) {
	const actual = sha256(archive);
	if (actual !== lock.sha256)
		throw new Error(`${lock.asset}: sha256 ${actual}, but build.lock.json pins ${lock.sha256}`);
	const files = unpackTar(archive);
	if (!manifest) return files;
	const listed = Object.keys(manifest.files).sort();
	const found = files.map((f) => f.path).sort();
	if (listed.join('\n') !== found.join('\n'))
		throw new Error(`${lock.asset}: its files differ from the manifest's`);
	for (const file of files)
		if (sha256(file.data) !== manifest.files[file.path])
			throw new Error(`${lock.asset}: ${file.path} does not match the manifest`);
	return files;
}
