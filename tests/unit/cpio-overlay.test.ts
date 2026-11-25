import { gunzipSync, gzipSync } from 'fflate';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { concat } from '../../scripts/wasm/binary.ts';
import { overlay } from '../../scripts/wasm/cpio-overlay.ts';
import { file, trailer } from '../../scripts/wasm/cpio.ts';

const text = (s: string) => new TextEncoder().encode(s);

/** the entries of a newc archive, in order: path, mode and body */
function entries(gz: Uint8Array) {
	const data = gunzipSync(gz);
	const out: { name: string; mode: number; body: string }[] = [];
	let p = 0;
	while (new TextDecoder().decode(data.subarray(p, p + 6)) === '070701') {
		const head = new TextDecoder().decode(data.subarray(p, p + 110));
		const field = (i: number) => parseInt(head.slice(6 + 8 * i, 14 + 8 * i), 16);
		const [mode, size, nameLen] = [field(1), field(6), field(11)];
		const name = new TextDecoder().decode(data.subarray(p + 110, p + 110 + nameLen - 1));
		const bodyAt = p + 110 + nameLen + ((4 - ((110 + nameLen) % 4)) % 4);
		out.push({
			name,
			mode,
			body: new TextDecoder().decode(data.subarray(bodyAt, bodyAt + size))
		});
		p = bodyAt + size + ((4 - (size % 4)) % 4);
	}
	return out;
}

function source(name: string, body: string) {
	const path = join(mkdtempSync(join(tmpdir(), 'overlay-')), name);
	writeFileSync(path, body);
	return path;
}

describe('cpio overlay', () => {
	const base = gzipSync(
		concat([
			file('etc', new Uint8Array(), 0o040755, 1),
			file('etc/init.d', new Uint8Array(), 0o040755, 2),
			file('etc/init.d/rcS', text('old rcS body, longer than the new one'), 0o100755, 3),
			file('etc/passwd', text('root'), 0o100644, 4),
			trailer()
		])
	);

	it('replaces a file of the same path, keeps the others in order and puts new files before the trailer', () => {
		const out = entries(
			overlay(base, [
				`etc/init.d/rcS=${source('rcS', 'new')}`,
				`bin/lighttpd=${source('lighttpd', 'stub')}`,
				`www/index.html=${source('index.html', '<p>')}`
			])
		);
		expect(out.map((e) => e.name)).toEqual([
			'etc',
			'etc/init.d',
			'etc/passwd',
			'bin',
			'www',
			'etc/init.d/rcS',
			'bin/lighttpd',
			'www/index.html',
			'TRAILER!!!'
		]);
		const byName = Object.fromEntries(out.map((e) => [e.name, e]));
		// the replaced file is the new one in full, not the old one overwritten in place
		expect(byName['etc/init.d/rcS']!.body).toBe('new');
		expect(byName['etc/passwd']!.body).toBe('root');
		expect(byName['bin/lighttpd']!.mode).toBe(0o100755);
		expect(byName['etc/init.d/rcS']!.mode).toBe(0o100755);
		expect(byName['www/index.html']!.mode).toBe(0o100644);
		expect(byName['bin']!.mode).toBe(0o040755);
	});

	it('adds a directory the archive already has only once, and refuses a malformed pair', () => {
		const out = entries(overlay(base, [`etc/lighttpd.conf=${source('c', 'x')}`]));
		expect(out.filter((e) => e.name === 'etc')).toHaveLength(1);
		expect(() => overlay(base, ['etc/x'])).toThrow('expected path=source');
	});

	it('refuses an archive with no trailer', () => {
		expect(() =>
			overlay(gzipSync(file('a', text('b'), 0o100644, 1)), [`c=${source('c', 'x')}`])
		).toThrow('no trailer');
	});
});
