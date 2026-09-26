import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Machine } from '../../src/worker/machine/machine.ts';

/**
 * Runs a wasm32-linux program on the target: a machine booted from $GMUX_BUILD (default build/) runs
 * it with its arguments, and this process prints its stdout and stderr and exits with its status.
 * Configure scripts that execute their test programs reach it through cc-strict's GMUX_TARGET_RUN.
 * `node scripts/wasm/target-run.ts <program.wasm> [args...]`
 */
const root = new URL('../../', import.meta.url).pathname;
const [program, ...args] = process.argv.slice(2);
if (!program) {
	console.error('usage: target-run.ts <program.wasm> [args...]');
	process.exit(2);
}
const build = process.env.GMUX_BUILD ?? join(root, 'build');
const read = (path: string) => new Uint8Array(readFileSync(path));
const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const kernel = join(build, 'kernel');
const manifest = JSON.parse(readFileSync(join(kernel, 'manifest.json'), 'utf8'));
const scratch = mkdtempSync(join(tmpdir(), 'gmux-target-'));
execFileSync(join(root, 'scripts/wasm/instrument.sh'), [program, join(scratch, 'fueled.wasm')]);
execFileSync('python3', [
	join(root, 'scripts/wasm/cpio-append.py'),
	join(kernel, 'initramfs.bin'),
	join(scratch, 'initrd.cpio'),
	`/t=${program}`
]);

let output = '';
const machine = new Machine({
	vmlinux: new WebAssembly.Module(read(join(kernel, 'vmlinux.wasm'))),
	initrd: read(join(scratch, 'initrd.cpio')),
	cmdline: 'maxcpus=3 root=/dev/ram0 rootfstype=ramfs init=/init console=hvc',
	registry: new Map([
		[manifest.busybox, new WebAssembly.Module(read(join(kernel, 'busybox.wasm')))],
		[sha256(read(program)), new WebAssembly.Module(read(join(scratch, 'fueled.wasm')))]
	]),
	maximumPages: 1024,
	sha256,
	sharedKernel: true,
	write: (text) => (output += text)
});
const sleep = (ms: number) => new Promise((r) => setTimeout(r, Math.min(ms, 5)));
const started = Date.now();
const until = (done: () => boolean) =>
	machine.run(() => done() || Date.now() - started > 60_000, sleep);
await until(() => output.includes('# '));
const quoted = args.map((a) => `'${a.replaceAll("'", `'\\''`)}'`).join(' ');
// the markers are split in the typed line, so its echo never matches them
const from = output.length;
machine.type(
	`cd /tmp; /t ${quoted} < /dev/null > o 2> e; s=$?; echo "@@""O"; cat o; echo "@@""E"; cat e; echo "@@""S $s"\n`
);
const status = /\n@@S (\d+)\r?\n/;
await until(() => status.test(output.slice(from)));
const tail = output.slice(from).replace(/\r/g, '');
const m = tail.match(/\n@@O\n([\s\S]*?)@@E\n([\s\S]*?)@@S (\d+)\n/);
if (!m) {
	console.error(
		`target-run: no result from ${program}${machine.crashed ? ` (${machine.crashed})` : ''}`
	);
	process.exit(124);
}
process.stdout.write(m[1]!);
process.stderr.write(m[2]!);
process.exit(Number(m[3]));
