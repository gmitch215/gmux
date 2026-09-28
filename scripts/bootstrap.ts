import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { type BootstrapIndex, CHUNK, packImage } from '../src/worker/bootstrap.ts';
import { encodeSnapshot } from '../src/worker/durable.ts';
import { Machine } from '../src/worker/machine/machine.ts';
import { CMDLINE, MAXIMUM_PAGES, siteOptions } from '../src/worker/site-machine.ts';

/**
 * Boots the site's machine from build/kernel, runs it to its shell prompt (then each `--run <line>
 * --until <text>` pair, typed in order and run until its text is printed, for a port that should
 * start already initialized), checkpoints it, and writes the image the site restores instead of
 * booting: build/assets/_gmux/bootstrap/index.json plus a file per 1 MiB of memory that holds a
 * nonzero byte. The image names build/kernel/manifest.json's `image` hash; a site built from anything
 * else boots as before.
 * `node --no-warnings --experimental-strip-types scripts/bootstrap.ts [--run <line> --until <text>]...`
 */
const root = new URL('..', import.meta.url).pathname;
const kernel = (f: string) => readFileSync(join(root, 'build/kernel', f));
const manifest = JSON.parse(kernel('manifest.json').toString()) as {
	busybox: string;
	katybug: string;
	image?: string;
};
if (!manifest.image)
	throw new Error(
		'build/kernel/manifest.json has no image hash: stage it with scripts/build-kernel.sh'
	);

const steps: { run: string; until: string }[] = [];
const args = process.argv.slice(2);
for (let i = 0; i < args.length; i += 4) {
	if (args[i] !== '--run' || args[i + 2] !== '--until')
		throw new Error('usage: [--run <line> --until <text>]...');
	steps.push({ run: args[i + 1]!, until: args[i + 3]! });
}

let output = '';
const options = siteOptions(
	{
		vmlinux: new WebAssembly.Module(kernel('vmlinux.async.wasm')),
		busybox: new WebAssembly.Module(kernel('busybox.async.wasm')),
		busyboxGuard: new WebAssembly.Module(kernel('busybox.guard.wasm')),
		katybug: new WebAssembly.Module(kernel('katybug.wasm')),
		initrd: new Uint8Array(kernel('initramfs.bin')),
		manifest
	},
	{
		sha256: (bytes) => createHash('sha256').update(bytes).digest('hex'),
		write: (text) => void (output += text)
	}
);
const machine = new Machine(options);
const started = performance.now();
const until = async (done: () => boolean, what: string) => {
	const outcome = await machine.run(
		done,
		(ms) => new Promise((r) => setTimeout(r, Math.min(ms, 50))),
		600_000
	);
	if (!done())
		throw new Error(`${what} never came (${outcome}); output ends: ${output.slice(-400)}`);
};
await until(() => /# $/.test(output), 'the shell prompt');
const booted = performance.now() - started;
for (const step of steps) {
	const from = output.length;
	machine.type(`${step.run}\n`);
	await until(() => output.indexOf(step.until, from) >= 0, `"${step.until}"`);
}
const snapshot = await machine.checkpoint();
const { blocks, chunks } = packImage(snapshot.memory);
const index: BootstrapIndex = {
	version: 1,
	image: manifest.image,
	cmdline: CMDLINE,
	maximumPages: MAXIMUM_PAGES,
	byteLength: snapshot.memory.byteLength,
	chunkBytes: CHUNK,
	blocks,
	snapshot: encodeSnapshot(snapshot)
};
const out = join(root, 'build/assets/_gmux/bootstrap');
// ponytail: the directory is this script's own output, rebuilt whole each run
rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
chunks.forEach((c, n) => c.byteLength && writeFileSync(join(out, `c${n}.bin`), c));
writeFileSync(join(out, 'index.json'), JSON.stringify(index));
const held = blocks.reduce((n, b) => n + b.length, 0);
console.log(
	`bootstrap: booted in ${(booted / 1000).toFixed(1)} s, ${steps.length} steps, ` +
		`${held} of ${snapshot.memory.byteLength / 0x10000} blocks held (${((held * 0x10000) / 2 ** 20).toFixed(1)} MiB) ` +
		`in ${chunks.filter((c) => c.byteLength).length} files, image ${manifest.image.slice(0, 12)}`
);
