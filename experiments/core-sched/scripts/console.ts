import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { hostRuntime } from '../../../scripts/wasm/router-modules.ts';
import { Machine } from '../../../src/worker/machine/machine.ts';

/**
 * The console ring's host side on two workloads: the boot's own output, and `cat` of a BYTES-byte file
 * (default 4 MiB of 79-column lines) made first. Prints one JSON line per part with the wall of the
 * window, the machine's own `consoleDrains` and `consoleDrainBytes`, and the bytes the write callback
 * received. Run it under method-timers.ts (METHODS=drainConsole) for the drain's own time.
 * GMUX_BUILD names the build (build/ by default).
 * `node --import ./method-timers.ts console.ts`
 */
const root = new URL('../../../', import.meta.url).pathname;
const kernel = join(process.env.GMUX_BUILD ?? join(root, 'build'), 'kernel');
const read = (path: string) => new Uint8Array(readFileSync(path));
const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const manifest = JSON.parse(readFileSync(join(kernel, 'manifest.json'), 'utf8'));
const bytes = Number(process.env.BYTES ?? 4 * 1024 * 1024);

let output = '';
let received = 0;
// the write callback's own time, which the drain's self time includes
let writeNs = 0n;
const machine = new Machine({
	vmlinux: new WebAssembly.Module(read(join(kernel, 'vmlinux.wasm'))),
	initrd: read(join(kernel, 'initramfs.bin')),
	cmdline: 'maxcpus=3 root=/dev/ram0 rootfstype=ramfs init=/init console=hvc console=ttyS0',
	registry: new Map([[manifest.busybox, new WebAssembly.Module(read(join(kernel, 'busybox.wasm')))]]),
	maximumPages: 4096,
	sha256,
	sharedKernel: true,
	runtime: hostRuntime(),
	write: (text) => {
		const start = process.hrtime.bigint();
		received += text.length;
		// the tail is enough to find the markers
		output = (output + text).slice(-4096);
		writeNs += process.hrtime.bigint() - start;
	}
});
const run = (until: () => boolean) =>
	machine.run(
		() => until(),
		(ms) => new Promise((r) => setTimeout(r, Math.min(ms, 5)))
	);
const line = (name: string, ms: number, at: { drains: number; bytes: number }, recv: number) =>
	console.log(
		JSON.stringify({
			part: name,
			windowMs: +ms.toFixed(1),
			drains: machine.stats.consoleDrains - at.drains,
			drainBytes: machine.stats.consoleDrainBytes - at.bytes,
			received: received - recv,
			writeUsSoFar: +(Number(writeNs) / 1000).toFixed(1)
		})
	);

const t0 = performance.now();
await run(() => output.includes('# '));
line('boot', performance.now() - t0, { drains: 0, bytes: 0 }, 0);

const type = async (cmd: string, marker: string) => {
	machine.type(`${cmd}; echo ${marker}$((6*7))\n`);
	await run(() => output.includes(`${marker}42`));
};
// a file of 79-column lines, made in the guest first and not counted
await type(
	`yes 0123456789012345678901234567890123456789012345678901234567890123456789012345678 | head -c ${bytes} > /tmp/big`,
	'MADE'
);
const at = { drains: machine.stats.consoleDrains, bytes: machine.stats.consoleDrainBytes };
const recv = received;
const t1 = performance.now();
await type('cat /tmp/big', 'CATDONE');
line('cat', performance.now() - t1, at, recv);
process.exit(0);
