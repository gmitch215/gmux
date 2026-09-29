import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
	cpSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	symlinkSync,
	writeFileSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { appendCpio } from './cpio-append.ts';
import { stub } from './exec-stubs.ts';

/**
 * Stages a scratch GMUX_BUILD that runs another katybug.wasm: the other entries of `build` linked,
 * `kernel/` copied with the instrumented program, a fresh stub of it appended to the initramfs and
 * its hash as manifest.katybug. binfmt_wasm maps the data size the stub's dylink.0 names, so a
 * build that keeps the old stub under the old hash runs the new program past its mapping.
 * `stage-katybug.ts <build> <katybug.wasm> <out> [instrumented.wasm]`
 */
export function stageKatybug(build: string, raw: string, out: string, instrumented?: string) {
	const bytes = new Uint8Array(readFileSync(raw));
	const small = stub(bytes);
	if (!small) throw new Error(`${raw}: not a wasm program with a dylink.0 section`);
	mkdirSync(out, { recursive: true });
	const dest = resolve(out);
	for (const entry of readdirSync(build)) {
		const source = resolve(build, entry);
		// batch is scratch, and a link to an ancestor of out points back into itself
		if (entry === 'kernel' || entry === 'batch' || existsSync(join(out, entry))) continue;
		if (dest === source || dest.startsWith(source + sep)) continue;
		symlinkSync(source, join(out, entry));
	}
	const kernel = join(out, 'kernel');
	cpSync(join(build, 'kernel'), kernel, { recursive: true });
	if (instrumented) cpSync(instrumented, join(kernel, 'katybug.wasm'));
	else
		execFileSync(join(import.meta.dirname, 'instrument.sh'), [
			raw,
			join(kernel, 'katybug.wasm')
		]);
	const tmp = mkdtempSync(join(tmpdir(), 'gmux-stage-'));
	writeFileSync(join(tmp, 'katybug'), small);
	const initramfs = join(kernel, 'initramfs.bin');
	appendCpio(initramfs, initramfs, [`/bin/katybug=${join(tmp, 'katybug')}`]);
	const manifest = JSON.parse(readFileSync(join(kernel, 'manifest.json'), 'utf8'));
	manifest.katybug = createHash('sha256').update(bytes).digest('hex');
	// scripts/build-kernel.sh's image hash, over the same files in the same order
	const image = createHash('sha256');
	for (const name of [
		'vmlinux.async.wasm',
		'busybox.async.wasm',
		'busybox.guard.wasm',
		'initramfs.bin',
		'katybug.wasm'
	])
		if (existsSync(join(kernel, name))) image.update(readFileSync(join(kernel, name)));
	manifest.image = image.digest('hex');
	writeFileSync(join(kernel, 'manifest.json'), JSON.stringify(manifest) + '\n');
	return manifest.katybug as string;
}

if (import.meta.main) {
	const [build, raw, out, instrumented] = process.argv.slice(2);
	if (!build || !raw || !out) {
		console.error('usage: stage-katybug.ts <build> <katybug.wasm> <out> [instrumented.wasm]');
		process.exit(2);
	}
	console.log(`${out}: katybug ${stageKatybug(build, raw, out, instrumented)}`);
}
