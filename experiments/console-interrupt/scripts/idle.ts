import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Machine } from '../../../src/worker/machine/machine.ts';

/**
 * what console input costs the host: host calls and wakes over 60 s of idle machine time, then the
 * machine time and host calls from typing a command to its output. On a clock that moves only when
 * the machine sleeps, so an idle minute takes no real minute.
 * `node --experimental-strip-types experiments/console-interrupt/scripts/idle.ts [kernel dir]`
 */
const root = new URL('../../../', import.meta.url).pathname;
const dir = process.argv[2] ?? join(root, 'build/kernel');
const manifest = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8'));
const clock = { ns: 0n };
let output = '';
const machine = new Machine({
	vmlinux: new WebAssembly.Module(readFileSync(join(dir, 'vmlinux.wasm'))),
	initrd: new Uint8Array(readFileSync(join(dir, 'initramfs.bin'))),
	cmdline:
		'maxcpus=3 root=/dev/ram0 rootfstype=ramfs init=/init console=hvc console=ttyS0',
	registry: new Map([[manifest.busybox, new WebAssembly.Module(readFileSync(join(dir, 'busybox.wasm')))]]),
	maximumPages: 1024,
	sha256: (bytes) => createHash('sha256').update(bytes).digest('hex'),
	sharedKernel: true,
	now: () => clock.ns,
	write: (text) => (output += text)
});
const sleep = async (ms: number) => void (clock.ns += BigInt(Math.max(ms, 1)) * 1_000_000n);
const run = (until: () => boolean) => machine.run(until, sleep, 1_000_000);
const counts = () => ({ ...machine.stats });
const delta = (a: ReturnType<typeof counts>, b: ReturnType<typeof counts>) => ({
	consoleReads: b.consoleReads - a.consoleReads,
	consoleRaises: b.consoleRaises - a.consoleRaises,
	idles: b.idles - a.idles,
	switches: b.switches - a.switches
});

await run(() => output.includes('# '));
// settle, then an idle minute
const settle = clock.ns + 5_000_000_000n;
await run(() => clock.ns >= settle);
const idleFrom = counts();
const idleEnd = clock.ns + 60_000_000_000n;
await run(() => clock.ns >= idleEnd);
const idle = delta(idleFrom, counts());

const typedFrom = counts();
const typedAt = clock.ns;
const hostFrom = performance.now();
const start = output.length;
machine.type('echo typed-$((6*7))\n');
await run(() => output.slice(start).includes('typed-42\r\n') || output.slice(start).includes('typed-42\n'));
const typed = delta(typedFrom, counts());

console.log(
	JSON.stringify({
		kernel: dir,
		consoleIrq: 'wasm_console_irq' in (WebAssembly.Module.exports(new WebAssembly.Module(readFileSync(join(dir, 'vmlinux.wasm')))).reduce((o, e) => ({ ...o, [e.name]: 1 }), {})),
		idleMinute: idle,
		typed: { ...typed, machineMs: Number(clock.ns - typedAt) / 1e6, hostMs: +(performance.now() - hostFrom).toFixed(1) },
		crashed: String(machine.crashed)
	})
);
