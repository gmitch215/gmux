import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { appendCpio } from '../../../scripts/wasm/cpio-append.ts';

/**
 * the workerd arm's bundle: worker.js (esbuild), the asyncified kernel and census programs, the
 * initramfs with the census images, and the workerd config; no address in it, `workerd serve
 * --socket-addr http=<host:port> config.capnp` gives one
 * `node --experimental-strip-types build.ts <stage dir> <build/kernel> <out dir>`
 */
const [stage, kernel, out] = process.argv.slice(2);
if (!stage || !kernel || !out) {
	console.error('usage: node --experimental-strip-types build.ts <stage dir> <kernel dir> <out dir>');
	process.exit(2);
}
const here = new URL('.', import.meta.url).pathname;
const root = join(here, '../../..');
const names = ['lua', 'gzip', 'bzip2', 'sqlite', 'sed', 'gawk'];
mkdirSync(out, { recursive: true });

execFileSync(join(root, 'node_modules/.bin/esbuild'), [join(here, 'src/worker.ts'), '--bundle', '--format=esm', '--platform=neutral', '--target=es2022', '--main-fields=module,main', '--conditions=workerd', '--external:*.wasm', '--external:*.bin', '--external:*.json', '--external:node:*', `--outfile=${join(out, 'worker.js')}`], { stdio: 'inherit' });

const hashes: Record<string, string> = {};
const files: string[] = [];
for (const n of names) {
	const image = join(stage, `${n}.wasm`);
	hashes[n] = createHash('sha256').update(readFileSync(image)).digest('hex');
	files.push(`/bin/${n}=${image}`);
	copyFileSync(join(stage, `${n}.async.wasm`), join(out, `${n}.async.wasm`));
}
writeFileSync(join(out, 'hashes.json'), JSON.stringify(hashes));
appendCpio(join(kernel, 'initramfs.bin'), join(out, 'initrd.bin'), files);
for (const f of ['vmlinux.async.wasm', 'busybox.async.wasm', 'busybox.guard.wasm', 'katybug.wasm', 'manifest.json']) copyFileSync(join(kernel, f), join(out, f));

const wasm = [...names.map((n) => `${n}.async.wasm`), 'vmlinux.async.wasm', 'busybox.async.wasm', 'busybox.guard.wasm', 'katybug.wasm'];
const module = (name: string, kind: string) => `\t\t(name = "${name}", ${kind} = embed "${name}")`;
writeFileSync(
	join(out, 'config.capnp'),
	`using Workerd = import "/workerd/workerd.capnp";

const config :Workerd.Config = (
	services = [(name = "main", worker = .worker)],
	sockets = [(name = "http", http = (), service = "main")]
);

const worker :Workerd.Worker = (
	modules = [
${[module('worker.js', 'esModule'), ...wasm.map((n) => module(n, 'wasm')), module('initrd.bin', 'data'), module('hashes.json', 'json'), module('manifest.json', 'json')].join(',\n')}
	],
	compatibilityDate = "2026-08-01",
	compatibilityFlags = ["nodejs_compat", "no_handle_cross_request_promise_resolution"]
);
`
);
console.log(`bundle in ${out}`);
