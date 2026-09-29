import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { type BootstrapIndex, CHUNK, packImage } from '../../../src/worker/bootstrap.ts';
import { encodeSnapshot } from '../../../src/worker/durable.ts';
import { Machine } from '../../../src/worker/machine/machine.ts';
import { CMDLINE, MAXIMUM_PAGES, siteOptions } from '../../../src/worker/site-machine.ts';

/**
 * boots the site's machine, starts a background busybox job, checkpoints it as soon as the job
 * prints its start mark, and writes the image to experiments/restore-cold/assets/image.
 * JOB is the shell command run between the marks (default: gzip of a generated file), N its size
 * `node --no-warnings --experimental-strip-types experiments/restore-cold/scripts/image.ts`
 */
const root = new URL('../../../', import.meta.url).pathname;
const kernel = (f: string) => readFileSync(join(root, 'build/kernel', f));
const manifest = JSON.parse(kernel('manifest.json').toString());
const n = process.env.N ?? '600000';
const job = process.env.JOB ?? 'gzip -9 -c /tmp/in | wc -c';

let output = '';
const machine = new Machine(
	siteOptions(
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
	)
);
const until = async (done: () => boolean, what: string) => {
	await machine.run(done, (ms) => new Promise((r) => setTimeout(r, Math.min(ms, 50))), 600_000);
	if (!done()) throw new Error(`${what} never came: ${output.slice(-400)}`);
};
await until(() => /# $/.test(output), 'the shell prompt');
machine.type(`seq 1 ${n} > /tmp/in; echo ready$((1+1))\n`);
await until(() => output.includes('ready2'), 'the input file');
machine.type(`sh -c 'echo GO$((1+1)); ${job}; echo DONE$((1+1))' &\n`);
await until(() => output.includes('GO2'), 'the job mark');
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
const out = join(root, 'experiments/restore-cold/assets/image');
rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
chunks.forEach((c, i) => c.byteLength && writeFileSync(join(out, `c${i}.bin`), c));
writeFileSync(join(out, 'index.json'), JSON.stringify(index));
console.log(`image: ${blocks.reduce((a, b) => a + b.length, 0)} blocks, output so far: ${JSON.stringify(output.slice(-80))}`);
process.exit(0);
