import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { type BootstrapIndex } from '../../../src/worker/bootstrap.ts';
import { restoreAndRun } from '../src/rig.ts';

/**
 * the rig's restore-and-run under node in one process: the first round is cold (nothing of the
 * kernel or busybox has run in this isolate), the rest warm
 * `node --no-warnings --experimental-strip-types experiments/restore-cold/scripts/local.ts [rounds]`
 */
const root = new URL('../../../', import.meta.url).pathname;
const kernel = (f: string) => readFileSync(join(root, 'build/kernel', f));
const dir = join(root, 'experiments/restore-cold/assets/image');
const index = JSON.parse(readFileSync(join(dir, 'index.json'), 'utf8')) as BootstrapIndex;
const build = {
	vmlinux: new WebAssembly.Module(kernel('vmlinux.async.wasm')),
	busybox: new WebAssembly.Module(kernel('busybox.async.wasm')),
	busyboxGuard: new WebAssembly.Module(kernel('busybox.guard.wasm')),
	katybug: new WebAssembly.Module(kernel('katybug.wasm')),
	initrd: new Uint8Array(kernel('initramfs.bin')),
	manifest: JSON.parse(kernel('manifest.json').toString())
};
let memory: WebAssembly.Memory | undefined;
for (let i = 0; i < Number(process.argv[2] ?? 6); i++) {
	const r = await restoreAndRun(build, index, async (n) => new Uint8Array(readFileSync(join(dir, `c${n}.bin`))), {
		sha256: (b) => createHash('sha256').update(b).digest('hex'),
		sleep: (ms) => new Promise((res) => setTimeout(res, ms)),
		now: () => performance.now(),
		memory
	});
	memory = r.memory;
	console.log(JSON.stringify({ round: i, restoreMs: +r.restoreMs.toFixed(1), runMs: +r.runMs.toFixed(1), tail: r.output.slice(-40) }));
}
process.exit(0);
