import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { appendCpio } from '../../../scripts/wasm/cpio-append.ts';
import { stageKatybug } from '../../../scripts/wasm/stage-katybug.ts';
import { Machine } from '../../../src/worker/machine/machine.ts';

/**
 * AArch64 loops run by Katybug as a guest in a machine, timed by the host clock under Node (V8, as a
 * Worker runs it), one Katybug build per variant.
 * `prepare <bundle> <name>=<katybug.wasm>...` (needs clang with lld and wabt) builds the loops of
 * experiments/katybug-fp and of piece-loops.S and stages one build per variant under `<bundle>/<name>`
 * (scripts/wasm/stage-katybug.ts, then the loops added to its initramfs);
 * `run <bundle> <variant> <loop>` boots that build's machine, runs the loop once and prints `variant loop ms`;
 * GMUX_BUILD names the build the variants are staged from (default build/)
 */
const root = new URL('../../../', import.meta.url).pathname;
const here = new URL('.', import.meta.url).pathname;
const [mode, bundle = '', ...rest] = process.argv.slice(2);
const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const build = process.env.GMUX_BUILD ?? join(root, 'build');
const loops = [
	{
		source: join(root, 'experiments/katybug-fp/scripts/fp-loops.S'),
		names: ['vfmla', 'sfmadd', 'sarith', 'mixed']
	},
	{ source: join(here, 'piece-loops.S'), names: ['narrow', 'stream', 'stride', 'straddle'] }
];

if (mode === 'prepare') {
	mkdirSync(join(bundle, 'bin'), { recursive: true });
	for (const { source, names } of loops)
		for (const name of names)
			execFileSync('clang', [
				'--target=aarch64-linux-gnu',
				'-nostdlib',
				'-static',
				'-fuse-ld=lld',
				'-x',
				'assembler-with-cpp',
				`-DWHICH=${name}`,
				...(process.env.CPPFLAGS?.split(' ').filter(Boolean) ?? []),
				'-o',
				join(bundle, 'bin', name),
				source
			]);
	const files = loops
		.flatMap(({ names }) => names)
		.map((n) => `/bin/${n}=${join(bundle, 'bin', n)}`);
	for (const spec of rest) {
		const [name = '', raw = ''] = spec.split('=');
		const staged = join(bundle, name);
		stageKatybug(build, raw, staged);
		const initramfs = join(staged, 'kernel/initramfs.bin');
		appendCpio(initramfs, initramfs, files);
		console.log(`staged ${name}`);
	}
	process.exit(0);
}

if (mode === 'run') {
	const [variant = '', loop = ''] = rest;
	if (!variant || !loop) throw new Error('usage: machine.ts run <bundle> <variant> <loop>');
	const read = (path: string) => new Uint8Array(readFileSync(path));
	const staged = join(bundle, variant);
	const manifest = JSON.parse(readFileSync(join(staged, 'kernel/manifest.json'), 'utf8'));
	let output = '';
	const machine = new Machine({
		vmlinux: new WebAssembly.Module(read(join(staged, 'kernel/vmlinux.wasm'))),
		initrd: read(join(staged, 'kernel/initramfs.bin')),
		cmdline: 'maxcpus=3 root=/dev/ram0 rootfstype=ramfs init=/init console=hvc console=ttyS0',
		registry: new Map([
			[
				manifest.busybox as string,
				new WebAssembly.Module(read(join(staged, 'kernel/busybox.wasm')))
			],
			[
				manifest.katybug as string,
				new WebAssembly.Module(read(join(staged, 'kernel/katybug.wasm')))
			]
		]),
		maximumPages: 4096,
		sha256,
		sharedKernel: true,
		write: (text) => (output += text)
	});
	const sleep = (ms: number) => new Promise((r) => setTimeout(r, Math.min(ms, 5)));
	await machine.run(() => output.includes('# '), sleep, 60_000);
	const from = output.length;
	const t = performance.now();
	machine.type(`/bin/${loop}; echo "@@""done $?"\n`);
	const outcome = await machine.run(() => /@@done \d+/.test(output.slice(from)), sleep, 900_000);
	const ms = performance.now() - t;
	const status = output.slice(from).match(/@@done (\d+)/)?.[1];
	if (outcome !== 'until' || status !== '0')
		throw new Error(`${loop}: ${outcome}, status ${status}\n${output.slice(from).slice(-600)}`);
	console.log(`${variant} ${loop} ${ms.toFixed(0)}`);
	process.exit(0);
}
throw new Error('usage: machine.ts prepare|run <bundle> ...');
