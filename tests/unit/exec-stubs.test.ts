import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gunzipSync, gzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { stub } from '../../scripts/wasm/exec-stubs.ts';
import { stageKatybug } from '../../scripts/wasm/stage-katybug.ts';
import { dylinkInfo } from '../../src/worker/machine/dl.ts';
import { stubHash } from '../../src/worker/machine/machine.ts';

const MAGIC = [0, 0x61, 0x73, 0x6d, 1, 0, 0, 0];
const name = (text: string) => [text.length, ...Buffer.from(text)];
// dylink.0 with a mem-info subsection (memory 0x4000, align 2, table 3, align 0)
const DYLINK = [0, 17, ...name('dylink.0'), 1, 6, 0x80, 0x80, 1, 2, 3, 0];
// a type section and an empty function: the code a stub leaves out
const CODE = [1, 4, 1, 0x60, 0, 0, 3, 2, 1, 0, 10, 4, 1, 2, 0, 0x0b];
const PROGRAM = new Uint8Array([...MAGIC, ...DYLINK, ...CODE]);
const PLAIN = new Uint8Array([...MAGIC, ...CODE]);

function cpio(files: [string, Uint8Array, number][]): Uint8Array {
	const parts: Buffer[] = [];
	for (const [path, data, mode] of [...files, ['TRAILER!!!', new Uint8Array(), 0] as const]) {
		const fields = [1, mode, 0, 0, 1, 0, data.length, 0, 0, 0, 0, path.length + 1, 0];
		const head = `070701${fields.map((f) => f.toString(16).toUpperCase().padStart(8, '0')).join('')}${path}\0`;
		parts.push(Buffer.from(head.padEnd(head.length + (-head.length & 3), '\0')));
		parts.push(Buffer.from(data), Buffer.alloc(-data.length & 3));
	}
	return Buffer.concat(parts);
}

/** every archive in the stream, later files over earlier ones, as the kernel unpacks them */
function unpack(archive: Uint8Array, compressed = true): Map<string, Uint8Array> {
	const data = compressed ? gunzipSync(archive) : Buffer.from(archive);
	const files = new Map<string, Uint8Array>();
	for (let p = 0; p < data.length;) {
		const field = (i: number) =>
			parseInt(data.subarray(p + 6 + 8 * i, p + 14 + 8 * i).toString(), 16);
		const [size, nameLength] = [field(6), field(11)];
		const path = data.subarray(p + 110, p + 109 + nameLength).toString();
		const body = p + 110 + nameLength + (-(110 + nameLength) & 3);
		if (path !== 'TRAILER!!!')
			files.set(path, new Uint8Array(data.subarray(body, body + size)));
		p = body + size + (-size & 3);
		while (data[p] === 0) p++;
	}
	return files;
}

function stubbed(...archives: [string, Uint8Array, number][][]) {
	const dir = mkdtempSync(join(tmpdir(), 'gmux-stubs-'));
	const padded = archives.flatMap((files) => [cpio(files), Buffer.alloc(4)]);
	writeFileSync(join(dir, 'in.gz'), gzipSync(Buffer.concat(padded)));
	execFileSync('scripts/ts', [
		'scripts/wasm/exec-stubs.ts',
		join(dir, 'in.gz'),
		join(dir, 'out.gz')
	]);
	return unpack(readFileSync(join(dir, 'out.gz')));
}

describe('exec stubs', () => {
	const motd = new Uint8Array(Buffer.from('hello\n'));
	const out = stubbed(
		[
			['bin/prog', PROGRAM, 0o100755],
			['bin/plain', PLAIN, 0o100755],
			['etc/motd', motd, 0o100644],
			['bin/link', new Uint8Array(Buffer.from('prog')), 0o120777]
		],
		[['bin/late', PROGRAM, 0o100755]]
	);

	it('stubs programs in every archive of the stream, not only the first', () => {
		expect(out.get('bin/late')).toEqual(out.get('bin/prog'));
	});

	it('replaces a program with its header and dylink.0, keyed by the full file hash', () => {
		const stub = out.get('bin/prog')!;
		expect(stub.length).toBe(8 + DYLINK.length + 2 + name('gmux.exec').length + 32);
		expect([...stub.subarray(0, 8 + DYLINK.length)]).toEqual([...MAGIC, ...DYLINK]);
		expect(stubHash(stub)).toBe(createHash('sha256').update(PROGRAM).digest('hex'));
	});

	it('leaves files binfmt_wasm would not run, other files and links alone', () => {
		expect(out.get('bin/plain')).toEqual(PLAIN);
		expect(out.get('etc/motd')).toEqual(motd);
		expect(Buffer.from(out.get('bin/link')!).toString()).toBe('prog');
	});

	it('reads no hash from a full program, a cut-off stub or a stub with another section', () => {
		const stub = out.get('bin/prog')!;
		expect(stubHash(PROGRAM)).toBeNull();
		for (let n = 0; n < stub.length; n++) expect(stubHash(stub.subarray(0, n))).toBeNull();
		const renamed = stub.slice();
		renamed[renamed.length - 33] = renamed[renamed.length - 33]! ^ 1;
		expect(stubHash(renamed)).toBeNull();
		expect(stubHash(new Uint8Array([...stub, 0]))).toBeNull();
	});
});

describe('staging another katybug', () => {
	const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
	// the same program with 36 KiB of data and bss: one page more than the build's 16 KiB one
	const grown = new Uint8Array(PROGRAM);
	grown.set([0x80, 0xa0, 0x02], 8 + 13);
	const dir = mkdtempSync(join(tmpdir(), 'gmux-stage-test-'));
	const build = join(dir, 'build');
	mkdirSync(join(build, 'kernel'), { recursive: true });
	mkdirSync(join(build, 'probes'));
	writeFileSync(
		join(build, 'kernel/initramfs.bin'),
		cpio([['bin/katybug', stub(PROGRAM)!, 0o100755]])
	);
	writeFileSync(
		join(build, 'kernel/manifest.json'),
		JSON.stringify({ busybox: 'b', katybug: sha(PROGRAM), inputs: 'i' })
	);
	writeFileSync(join(build, 'kernel/katybug.wasm'), PROGRAM);
	writeFileSync(join(dir, 'grown.wasm'), grown);
	writeFileSync(join(dir, 'grown.fueled.wasm'), PLAIN);
	const key = stageKatybug(
		build,
		join(dir, 'grown.wasm'),
		join(dir, 'out'),
		join(dir, 'grown.fueled.wasm')
	);
	const kernel = join(dir, 'out/kernel');
	const manifest = JSON.parse(readFileSync(join(kernel, 'manifest.json'), 'utf8'));

	it('gives the kernel a stub with the new program data size, keyed by its hash', () => {
		expect(dylinkInfo(grown)!.memorySize).toBe(0x9000);
		const seen = unpack(readFileSync(join(kernel, 'initramfs.bin')), false).get('bin/katybug')!;
		expect(dylinkInfo(seen)!.memorySize).toBe(0x9000);
		expect(stubHash(seen)).toBe(sha(grown));
		expect(manifest.katybug).toBe(sha(grown));
		expect(key).toBe(sha(grown));
	});

	it('registers the instrumented build and keeps the rest of the build', () => {
		expect(readFileSync(join(kernel, 'katybug.wasm'))).toEqual(Buffer.from(PLAIN));
		expect(manifest.busybox).toBe('b');
		expect(manifest.inputs).toBe('i');
		expect(lstatSync(join(dir, 'out/probes')).isSymbolicLink()).toBe(true);
		expect(readFileSync(join(build, 'kernel/manifest.json'), 'utf8')).toContain(sha(PROGRAM));
	});

	it('links no ancestor of the staging directory into it', () => {
		mkdirSync(join(build, 'nested'));
		const nested = join(build, 'nested/out');
		stageKatybug(build, join(dir, 'grown.wasm'), nested, join(dir, 'grown.fueled.wasm'));
		expect(() => lstatSync(join(nested, 'nested'))).toThrow();
		expect(lstatSync(join(nested, 'probes')).isSymbolicLink()).toBe(true);
		const cyclic = join(build, 'batch/run/out');
		mkdirSync(join(build, 'batch/run'), { recursive: true });
		stageKatybug(build, join(dir, 'grown.wasm'), cyclic, join(dir, 'grown.fueled.wasm'));
		expect(() => lstatSync(join(cyclic, 'batch'))).toThrow();
	});

	it('refuses a file binfmt_wasm would not run', () => {
		writeFileSync(join(dir, 'plain.wasm'), PLAIN);
		expect(() => stageKatybug(build, join(dir, 'plain.wasm'), join(dir, 'bad'))).toThrow(
			/no dylink.0|dylink.0 section/
		);
	});
});
