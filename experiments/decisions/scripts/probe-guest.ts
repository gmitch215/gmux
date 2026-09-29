import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Machine } from '../../../src/worker/machine/machine.ts';
import { siteOptions } from '../../../src/worker/site-machine.ts';

/**
 * Runs the commands in argv inside a booted machine, one after another, and prints what each wrote.
 * `node --no-warnings --experimental-strip-types experiments/decisions/scripts/probe-guest.ts 'cmd' ...`
 */
const root = new URL('../../../', import.meta.url).pathname;
const kernel = (name: string) => new Uint8Array(readFileSync(join(root, 'build/kernel', name)));
const manifest = JSON.parse(readFileSync(join(root, 'build/kernel/manifest.json'), 'utf8'));
let output = '';
const machine = new Machine(
	siteOptions(
		{
			vmlinux: new WebAssembly.Module(kernel('vmlinux.async.wasm')),
			busybox: new WebAssembly.Module(kernel('busybox.async.wasm')),
			busyboxGuard: new WebAssembly.Module(kernel('busybox.guard.wasm')),
			katybug: new WebAssembly.Module(kernel('katybug.wasm')),
			initrd: kernel('initramfs.bin'),
			manifest
		},
		{
			sha256: (bytes) => createHash('sha256').update(bytes).digest('hex'),
			write: (text) => (output += text)
		}
	)
);
const run = (ms: number, until: () => boolean = () => false) => {
	const t = Date.now();
	return machine.run(
		() => until() || Date.now() - t > ms,
		(x) => new Promise((r) => setTimeout(r, Math.min(x, 20)))
	);
};
await run(60_000, () => output.includes('# '));
for (const [i, cmd] of process.argv.slice(2).entries()) {
	output = '';
	const mark = `\nDONE${100 + i}`;
	const t = Date.now();
	machine.type(`${cmd}; echo DONE$((100+${i}))\n`);
	await run(60_000, () => output.includes(mark));
	console.log(`$ ${cmd}  (${Date.now() - t} ms)\n${output.replaceAll('\r', '')}`);
}
process.exit(0);
