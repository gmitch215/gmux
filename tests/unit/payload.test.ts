import { gzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { packTar, sha256, unpackTar, verify, type PayloadFile } from '../../scripts/payload.ts';

const bytes = (text: string) => new TextEncoder().encode(text);
const FILES: PayloadFile[] = [
	{ path: 'kernel/vmlinux.wasm', data: bytes('\0asm kernel'), executable: false },
	{ path: 'probes/fork.wasm', data: new Uint8Array(1500).fill(7), executable: true },
	{ path: 'katybug/transcript/ubin/bash', data: bytes('ELF'), executable: true },
	{ path: 'kernel/empty', data: new Uint8Array(), executable: false }
];

describe('build payload', () => {
	it('unpacks what it packed, in path order, with modes kept', () => {
		const files = unpackTar(packTar(FILES));
		expect(files.map((f) => f.path)).toEqual([
			'katybug/transcript/ubin/bash',
			'kernel/empty',
			'kernel/vmlinux.wasm',
			'probes/fork.wasm'
		]);
		for (const file of files) {
			const original = FILES.find((f) => f.path === file.path)!;
			expect(file.data).toEqual(original.data);
			expect(file.executable).toBe(original.executable);
		}
	});

	it('packs the same bytes for the same files, whatever their order', () => {
		expect(sha256(packTar(FILES))).toBe(sha256(packTar([...FILES].reverse())));
	});

	it('refuses paths that climb out of build/ or do not fit ustar', () => {
		const bad = (path: string) => () =>
			packTar([{ path, data: new Uint8Array(), executable: false }]);
		expect(bad('../escape')).toThrow(/unsafe/);
		expect(bad('/abs')).toThrow(/unsafe/);
		expect(bad('a//b')).toThrow(/unsafe/);
		expect(bad(`${'x'.repeat(101)}`)).toThrow(/100 bytes/);
	});

	it('refuses an archive it did not write', () => {
		const tar = new Uint8Array(1536);
		tar.set(bytes('link'), 0);
		tar[156] = 0x32;
		expect(() => unpackTar(gzipSync(tar))).toThrow(/unsupported/);
	});

	it('checks the pinned hash and each file against the manifest', () => {
		const archive = packTar(FILES);
		const lock = { tag: 'build-x', asset: 'gmux-build.tar.gz', sha256: sha256(archive) };
		const manifest = {
			version: '1.0.0',
			commit: 'c',
			files: Object.fromEntries(FILES.map((f) => [f.path, sha256(f.data)]))
		};
		expect(verify(archive, lock, manifest)).toHaveLength(4);
		expect(() => verify(archive, { ...lock, sha256: '0'.repeat(64) })).toThrow(/pins/);
		expect(() =>
			verify(archive, lock, {
				...manifest,
				files: { ...manifest.files, 'kernel/empty': '0' }
			})
		).toThrow(/does not match/);
		const { ['kernel/empty']: _, ...fewer } = manifest.files;
		expect(() => verify(archive, lock, { ...manifest, files: fewer })).toThrow(/differ/);
	});
});
