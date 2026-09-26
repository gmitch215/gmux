import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { Machine } from '../src/machine.ts';
const vendor = new URL('../vendor/', import.meta.url);
const read = (n: string) => new Uint8Array(readFileSync(new URL(n, vendor)));
const sha256 = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');
let out = '';
const m = new Machine({
	vmlinux: new WebAssembly.Module(read('vmlinux.min.wasm')),
	initrd: read('initramfs.cpio.gz'),
	cmdline:
		'maxcpus=3 root=/dev/ram0 rootfstype=ramfs init=/init console=hvc console=ttyS0',
	registry: new Map([
		[sha256(read('busybox.wasm')), new WebAssembly.Module(read('busybox.fuel.wasm'))]
	]),
	maximumPages: 800,
	sha256,
	write: (t) => (out += t)
});
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, Math.min(ms, 50)));
const t0 = Date.now();
await m.run(() => /# $/.test(out) || Date.now() - t0 > 20000, sleep);
m.type('yes | head -c 268435456 | sha256sum\n');
const t1 = Date.now();
await m.run(() => Date.now() - t1 > 1000, sleep);
const snap = JSON.stringify(m.stats);
await new Promise((r) => setTimeout(r, 2000));
console.log('after pump stop, stats changed while idle:', snap !== JSON.stringify(m.stats));
console.log(snap);
console.log(JSON.stringify(m.stats));
process.exit(0);
