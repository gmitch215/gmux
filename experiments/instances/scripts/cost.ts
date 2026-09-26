import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Machine } from '../../../src/worker/machine/machine.ts';

/**
 * what one instance per process costs. Boots build/kernel in Node, starts N
 * sleeping BusyBox processes, and reads the retained JS memory and the instantiation time per process.
 * `node --expose-gc --experimental-strip-types experiments/instances/scripts/cost.ts`
 */
const root = new URL('../../../', import.meta.url).pathname;
const build = join(root, 'build');
const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const manifest = JSON.parse(readFileSync(join(build, 'kernel/manifest.json'), 'utf8'));
// SHARE=<scripts/wasm/share.ts output>: every BusyBox process on one instance
const share = process.env.SHARE;
const busybox = new WebAssembly.Module(readFileSync(share ?? join(build, 'kernel/busybox.wasm')));

// time spent in new WebAssembly.Instance for user programs
let instantiateMs = 0;
let instantiations = 0;
const Instance = WebAssembly.Instance;
(WebAssembly as any).Instance = function (module: WebAssembly.Module, imports: WebAssembly.Imports) {
	const t0 = performance.now();
	const instance = new Instance(module, imports);
	if (module === busybox) {
		instantiateMs += performance.now() - t0;
		instantiations++;
	}
	return instance;
};

async function measure(n: number) {
	let output = '';
	const machine = new Machine({
		vmlinux: new WebAssembly.Module(readFileSync(join(build, 'kernel/vmlinux.wasm'))),
		initrd: new Uint8Array(readFileSync(join(build, 'kernel/initramfs.bin'))),
		cmdline: 'maxcpus=1 root=/dev/ram0 rootfstype=ramfs init=/init console=hvc console=ttyS0',
		registry: new Map([[manifest.busybox, busybox]]),
		maximumPages: 4096,
		sha256,
		sharedKernel: true,
		shareInstances: !!share,
		write: (text) => (output += text)
	});
	const run = (until: () => boolean) =>
		machine.run(until, (ms) => new Promise((r) => setTimeout(r, Math.min(ms, 20))));
	await run(() => output.includes('# '));
	const gc = (globalThis as any).gc as () => void;
	// warm up: 50 processes started and reaped, so boot's garbage and first-use code are not counted
	machine.type(`i=0; while [ $i -lt 50 ]; do sleep 0 & i=$((i+1)); done; wait; echo @@$((30+3))@@\n`);
	await run(() => output.includes('@@33@@'));
	for (let i = 0; i < 4; i++) gc();
	const before = process.memoryUsage();
	const [ms0, count0] = [instantiateMs, instantiations];
	machine.type(`i=0; while [ $i -lt ${n} ]; do sleep 1000 & i=$((i+1)); done; echo @@$((40+2))@@\n`);
	await run(() => output.includes('@@42@@'));
	for (let i = 0; i < 4; i++) gc();
	const after = process.memoryUsage();
	const execs = instantiations - count0;
	const mib = (b: number) => +(b / 2 ** 20).toFixed(2);
	console.log(
		JSON.stringify({
			processes: n,
			execs,
			heapPerProcessKiB: +(((after.heapUsed - before.heapUsed) / n) / 1024).toFixed(1),
			externalPerProcessKiB: +(((after.external - before.external) / n) / 1024).toFixed(1),
			arrayBuffersPerProcessKiB: +(((after.arrayBuffers - before.arrayBuffers) / n) / 1024).toFixed(1),
			rssPerProcessKiB: +(((after.rss - before.rss) / n) / 1024).toFixed(1),
			heapMiB: mib(after.heapUsed),
			instantiateMsPerExec: +((instantiateMs - ms0) / Math.max(execs, 1)).toFixed(3)
		})
	);
}
for (const n of (process.argv[2] ?? "1,10,50").split(",").map(Number)) await measure(n);
process.exit(0);
