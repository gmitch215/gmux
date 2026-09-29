import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { type BootstrapIndex } from '../../../src/worker/bootstrap.ts';
import { restoreAndRun } from '../src/rig.ts';

/**
 * one fresh process: an optional warm-up at start (none, a small gzip typed into the shipped
 * prompt image, or the job image itself), then the job image restored three times; prints the
 * warm-up's cost and each restore's rest of run
 * `ARM=<default|small|full> node --no-warnings --experimental-strip-types arms.ts`
 */
const root = new URL('../../../', import.meta.url).pathname;
const kernel = (f: string) => readFileSync(join(root, 'build/kernel', f));
const load = (dir: string) => {
	const index = JSON.parse(readFileSync(join(dir, 'index.json'), 'utf8')) as BootstrapIndex;
	return { index, chunk: async (n: number) => new Uint8Array(readFileSync(join(dir, `c${n}.bin`))) };
};
const job = load(join(root, 'experiments/restore-cold/assets/image'));
const prompt = load(join(root, 'build/assets/_gmux/bootstrap'));
const build = {
	vmlinux: new WebAssembly.Module(kernel('vmlinux.async.wasm')),
	busybox: new WebAssembly.Module(kernel('busybox.async.wasm')),
	busyboxGuard: new WebAssembly.Module(kernel('busybox.guard.wasm')),
	katybug: new WebAssembly.Module(kernel('katybug.wasm')),
	initrd: new Uint8Array(kernel('initramfs.bin')),
	manifest: JSON.parse(kernel('manifest.json').toString())
};
const host = {
	sha256: (b: Uint8Array) => createHash('sha256').update(b).digest('hex'),
	sleep: (ms: number) => new Promise<void>((res) => setTimeout(res, ms)),
	now: () => performance.now()
};
const arm = process.env.ARM ?? 'default';
let memory: WebAssembly.Memory | undefined;
let warmup = 0;
if (arm !== 'default') {
	const t = performance.now();
	const r =
		arm === 'small'
			? await restoreAndRun(build, prompt.index, prompt.chunk, host, 'DONE2', 'seq 1 20000 | gzip -9 | wc -c; echo DONE$((1+1))\n')
			: await restoreAndRun(build, job.index, job.chunk, host);
	memory = r.memory;
	warmup = performance.now() - t;
}
const runs: number[] = [];
for (let i = 0; i < 3; i++) {
	const r = await restoreAndRun(build, job.index, job.chunk, { ...host, memory });
	memory = r.memory;
	runs.push(+r.runMs.toFixed(1));
}
console.log(JSON.stringify({ arm, warmupMs: +warmup.toFixed(1), runs }));
process.exit(0);
