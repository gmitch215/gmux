import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Machine } from '../../../src/worker/machine/machine.ts';

/**
 * the shared-instance exactness check: tests/c/katybug/busybox/commands.txt on the machine's own BusyBox, each line
 * with its output and exit status, printed for comparison between arms. SHARE=<scripts/wasm/share.py
 * output> runs every process on one instance.
 * `node --experimental-strip-types experiments/instances/scripts/transcript.ts > out.txt`
 */
const root = new URL('../../../', import.meta.url).pathname;
const build = join(root, 'build');
const inputs = join(root, 'tests/c/katybug/busybox');
const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const manifest = JSON.parse(readFileSync(join(build, 'kernel/manifest.json'), 'utf8'));
const share = process.env.SHARE;
const initrd = join(mkdtempSync(join(tmpdir(), 'gmux-g4-')), 'initramfs.cpio');
execFileSync('python3', [
	join(root, 'scripts/wasm/cpio-append.py'),
	join(build, 'kernel/initramfs.bin'),
	initrd,
	...['commands.txt', 'input.txt', 'numbers.txt'].map((f) => `/t/${f}=${join(inputs, f)}`)
]);
let output = '';
const machine = new Machine({
	vmlinux: new WebAssembly.Module(readFileSync(join(build, 'kernel/vmlinux.wasm'))),
	initrd: new Uint8Array(readFileSync(initrd)),
	cmdline:
		'maxcpus=3 root=/dev/ram0 rootfstype=ramfs init=/init console=hvc console=ttyS0',
	registry: new Map([
		[
			manifest.busybox,
			new WebAssembly.Module(readFileSync(share ?? join(build, 'kernel/busybox.wasm')))
		]
	]),
	maximumPages: 4096,
	sha256,
	sharedKernel: true,
	shareInstances: !!share,
	write: (text) => (output += text)
});
const started = Date.now();
const run = (until: () => boolean) =>
	machine.run(
		() => until() || Date.now() - started > 300_000,
		(ms) => new Promise((r) => setTimeout(r, Math.min(ms, 20)))
	);
await run(() => output.includes('# '));
const start = output.length;
// a script, not typed: the loop's redirected reads go wrong in an interactive shell on the console
machine.type(
	`printf '%s\\n' 'n=0; while IFS= read -r line; do n=$((n+1)); echo "== $n $line"; sh -c "$line" < /dev/null 2>&1; echo "== rc $?"; done < commands.txt' > /t/run.sh; ` +
		'cd /t; sh run.sh; echo "== DONE-$((6*7))"\n'
);
await run(() => output.includes('== DONE-42'));
const text = output.slice(start).replace(/\r/g, '');
if (!text.includes('== DONE-42')) {
	console.error(`did not finish: ${JSON.stringify(text.slice(-600))}`);
	process.exit(1);
}
process.stdout.write(text.slice(text.indexOf('\n== 1 ') + 1, text.indexOf('== DONE-42')));
console.error(JSON.stringify({ execs: machine.stats.userExecs, shared: machine.stats.sharedEntries }));
process.exit(0);
