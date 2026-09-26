import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Machine } from '../../../src/worker/machine/machine.ts';

/**
 * the transcript inside gmux: boots build/kernel with the tree transcript.sh keeps in build/katybug/transcript
 * and runs its run.sh there, the amd64 BusyBox and userland reaching katybug through binfmt_misc;
 * every line must match the native x86-64 transcript.
 * `node --experimental-strip-types tests/c/katybug/transcript-gmux.ts [busybox|userland]...`
 */
const root = new URL('../../../', import.meta.url).pathname;
const build = process.env.GMUX_BUILD ?? join(root, 'build');
const tree = join(build, 'katybug/transcript');
const suites = process.argv.slice(2).length ? process.argv.slice(2) : ['busybox', 'userland'];
const read = (path: string) => new Uint8Array(readFileSync(join(build, path)));
const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

const manifest = JSON.parse(readFileSync(join(build, 'kernel/manifest.json'), 'utf8'));
const registry = new Map([
	[manifest.busybox as string, new WebAssembly.Module(read('kernel/busybox.wasm'))],
	[manifest.katybug as string, new WebAssembly.Module(read('kernel/katybug.wasm'))]
]);
const files = readdirSync(tree, { recursive: true, withFileTypes: true })
	.filter((f) => f.isFile())
	.map((f) => join(f.parentPath, f.name));
const initrd = join(mkdtempSync(join(tmpdir(), 'gmux-transcript-')), 'initramfs.cpio');
execFileSync('python3', [
	join(root, 'scripts/wasm/cpio-append.py'),
	join(build, 'kernel/initramfs.bin'),
	initrd,
	...files.map((f) => `/t${f.slice(tree.length)}=${f}`)
]);

const links = 'for p in $(cat ubin.list); do ln -s coreutils "ubin/$p"; done';
const script =
	`ifconfig lo 127.0.0.1 up; cd /t && mkdir -p bin /tmp/kt && { [ ! -f ubin.list ] || ${links}; }; ` +
	`for s in ${suites.join(' ')}; do echo "=== $s"; TMPDIR=/tmp/kt ./run.sh $s < /dev/null; done; ` +
	'echo "=== DONE-$((6*7))"\n';
let output = '';
let typed = false;
const machine = new Machine({
	vmlinux: new WebAssembly.Module(read('kernel/vmlinux.wasm')),
	initrd: new Uint8Array(readFileSync(initrd)),
	cmdline: 'maxcpus=3 root=/dev/ram0 rootfstype=ramfs init=/init console=hvc console=ttyS0',
	registry,
	maximumPages: 8192,
	sha256,
	sharedKernel: true,
	...(process.env.FROZEN ? { now: () => 0n } : {}),
	write: (text) => {
		output += text;
		if (!typed && output.includes('# ')) {
			typed = true;
			machine.type(script);
		}
	}
});
const started = Date.now();
await machine.run(
	() => output.includes('=== DONE-42') || Date.now() - started > 900_000,
	(ms) => new Promise((r) => setTimeout(r, Math.min(ms, 50)))
);

const split = (text: string) => {
	const parts = text.replace(/\r/g, '').split(/^== (\d+) (.*)$/m);
	const out = new Map<number, [string, string]>();
	for (let i = 1; i < parts.length; i += 3)
		out.set(Number(parts[i]), [parts[i + 1]!, parts[i + 2]!]);
	return out;
};
let failed = 0;
for (const s of suites) {
	const at = output.lastIndexOf(`\n=== ${s}`);
	const end = output.indexOf('\n===', at + 1);
	const got = split(at < 0 ? '' : output.slice(at, end < 0 ? undefined : end + 1));
	const want = split(readFileSync(join(tree, `${s}.native.txt`), 'utf8'));
	let ok = 0;
	console.log(`# ${s}`);
	for (const [n, [line, x]] of want) {
		const y = got.get(n)?.[1] ?? '';
		if (x === y) {
			ok++;
			continue;
		}
		console.log(`FAIL ${line}`);
		console.log('  native :', x.trim().slice(0, 300).replace(/\n/g, ' | '));
		console.log('  gmux   :', y.trim().slice(0, 300).replace(/\n/g, ' | '));
	}
	console.log(`${ok}/${want.size} lines equal (${((Date.now() - started) / 1000).toFixed(0)} s)`);
	if (ok !== want.size) failed++;
}
process.exit(failed ? 1 : 0);
