import { concat, utf8 } from './binary.ts';

const pad = (n: number) => new Uint8Array((4 - (n % 4)) % 4);

/** one newc entry: its 13 header fields in order (ino, mode, uid, gid, nlink, mtime, filesize, ...) */
export function entry(fields: number[], name: string, data: Uint8Array): Uint8Array {
	const head =
		'070701' + fields.map((f) => f.toString(16).toUpperCase().padStart(8, '0')).join('');
	const named = concat([utf8.encode(head), utf8.encode(name), Uint8Array.of(0)]);
	return concat([named, pad(named.length), data, pad(data.length)]);
}

/** an entry with every field but the ones a file needs left zero */
export function file(name: string, data: Uint8Array, mode: number, ino: number): Uint8Array {
	return entry(
		[ino, mode, 0, 0, 1, 0, data.length, 0, 0, 0, 0, utf8.encode(name).length + 1, 0],
		name,
		data
	);
}

export const trailer = () => file('TRAILER!!!', new Uint8Array(), 0, 0);
