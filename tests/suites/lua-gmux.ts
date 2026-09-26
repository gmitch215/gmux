import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { appendCpio } from '../../scripts/wasm/cpio-append.ts';
import { Machine } from '../../src/worker/machine/machine.ts';

/**
 * Lua's test suite on gmux, one fresh machine per file, printing `PASS file` or `FAIL file`.
 * `node --experimental-strip-types tests/suites/lua-gmux.ts <lua.wasm> <tests dir> [file...]`;
 * GMUX_BUILD points at another build, PAGES sets the machine's memory (default 2400)
 */
const [luaPath, testsDir, ...only] = process.argv.slice(2);
if (!luaPath || !testsDir) throw new Error('usage: lua-gmux.ts <lua.wasm> <tests dir> [file...]');
const root = new URL('../../', import.meta.url).pathname;
const build = process.env.GMUX_BUILD ?? join(root, 'build');
const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const read = (path: string) => new Uint8Array(readFileSync(join(build, path)));

const scratch = mkdtempSync(join(tmpdir(), 'gmux-lua-'));
const fueled = join(scratch, 'lua.wasm');
execFileSync(join(root, 'scripts/wasm/instrument.sh'), [luaPath, fueled]);
const manifest = JSON.parse(readFileSync(join(build, 'kernel/manifest.json'), 'utf8'));
const registry = new Map([
	[manifest.busybox as string, new WebAssembly.Module(read('kernel/busybox.wasm'))],
	[sha256(new Uint8Array(readFileSync(luaPath))), new WebAssembly.Module(readFileSync(fueled))]
]);
const files = readdirSync(testsDir)
	.filter((f) => f.endsWith('.lua') && f !== 'all.lua')
	.sort();
const initrd = join(scratch, 'initramfs.cpio');
appendCpio(join(build, 'kernel/initramfs.bin'), initrd, [
	`/bin/lua=${luaPath}`,
	...files.map((f) => `/lua-tests/${f}=${join(testsDir, f)}`)
]);
const image = new Uint8Array(readFileSync(initrd));
const vmlinux = new WebAssembly.Module(read('kernel/vmlinux.wasm'));

for (const file of only.length ? only : files) {
	let output = '';
	let typed = false;
	const machine = new Machine({
		vmlinux,
		initrd: image,
		cmdline: 'maxcpus=3 root=/dev/ram0 rootfstype=ramfs init=/init console=hvc console=ttyS0',
		registry,
		maximumPages: Number(process.env.PAGES ?? 2400),
		sha256,
		sharedKernel: true,
		write: (text) => {
			output += text;
			if (!typed && output.includes('# ')) {
				typed = true;
				machine.type(
					`cd /lua-tests; lua -e "_port=true" ${file} > /tmp/o 2>&1; echo "RC=$?"; echo END-$((6*7))\n`
				);
			}
		}
	});
	const started = Date.now();
	await machine.run(
		() => output.includes('END-42') || Date.now() - started > 300_000,
		(ms) => new Promise((r) => setTimeout(r, Math.min(ms, 50)))
	);
	const rc = output.match(/RC=(\d+)/)?.[1];
	console.log(rc === '0' ? 'PASS' : 'FAIL', file);
}
