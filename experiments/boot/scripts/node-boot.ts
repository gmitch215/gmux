import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeSync } from 'node:fs';
import { Machine } from '../src/machine.ts';
import { pauseAfter } from './pause-probe.ts';
if (process.env.PAUSE_MS) pauseAfter(Number(process.env.PAUSE_MS));

const vendor = new URL('../vendor/', import.meta.url);
const read = (name: string) => new Uint8Array(readFileSync(new URL(name, vendor)));
const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

const busybox = read(process.env.BUSYBOX ?? 'busybox.wasm');
const program = process.env.FUEL === '0' ? busybox : read(process.env.BUSYBOX_FUEL ?? 'busybox.fuel.wasm');
const registry = new Map([[sha256(busybox), new WebAssembly.Module(program)]]);
for (const extra of (process.env.EXTRA ?? '').split(',').filter(Boolean)) {
	// the kernel hashes the file it reads; a fueled build beside it (x.fuel.wasm) is what runs
	const fueled = extra.replace(/\.wasm$/, '.fuel.wasm');
	const bytes = read(extra);
	registry.set(sha256(bytes), new WebAssembly.Module(existsSync(new URL(fueled, vendor)) ? read(fueled) : bytes));
}
const seconds = Number(process.argv[2] ?? 20);
const script = process.argv[3] ?? '';
let output = '';
const started = Date.now();

const machine = new Machine({
	vmlinux: new WebAssembly.Module(read(process.env.KERNEL ?? 'vmlinux.min.wasm')),
	initrd: read(process.env.INITRD ?? 'initramfs.cpio.gz'),
	cmdline:
		'maxcpus=3 root=/dev/ram0 rootfstype=ramfs init=/init console=hvc console=ttyS0',
	registry,
	maximumPages: Number(process.env.PAGES ?? 4096),
	sha256,
	trace: process.env.TRACE === '1',
	sharedKernel: process.env.SHARED === '1',
	log: (line) => writeSync(2, `[host] ${line}\n`),
	write: (text) => {
		output += text;
		writeSync(1, text);
		if (script && output.includes('# ') && !typed) {
			typed = true;
			const steps: [number, string][] = process.env.STEPS
				? JSON.parse(process.env.STEPS)
				: [[0, script]];
			for (const [delay, text] of steps) setTimeout(() => machine.type(text), delay);
		}
	}
});
let typed = false;
const outcome = await machine.run(
	() =>
		Date.now() - started > seconds * 1000 ||
		(!!process.env.UNTIL && output.includes(process.env.UNTIL)),
	(ms) => new Promise((r) => setTimeout(r, Math.min(ms, 50)))
);
const mu = process.memoryUsage();
console.error(
	`[host] memory rss=${(mu.rss / 2 ** 20).toFixed(1)}MiB heapUsed=${(mu.heapUsed / 2 ** 20).toFixed(1)} external=${(mu.external / 2 ** 20).toFixed(1)} arrayBuffers=${(mu.arrayBuffers / 2 ** 20).toFixed(1)} linear=${(machine.memory.buffer.byteLength / 2 ** 20).toFixed(1)}`
);
console.error(
	`\n[host] outcome=${outcome} after ${Date.now() - started} ms stats=${JSON.stringify(machine.stats)}`
);
process.exit(0);
