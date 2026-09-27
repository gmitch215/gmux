import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Machine, type MachineOptions } from '../../../src/worker/machine/machine.ts';

/**
 * lazy restore: two processes park holding 6 MB each, the machine checkpoints, and a restore
 * writes only the pages no parked process owns (kernel patch 0014's owner table). Each process's pages
 * come in when one of its tasks is next scheduled. Reads the bytes written at restore, after a shell
 * command, and after each sleeper wakes, and checks each sleeper still holds its 6 MB. Before either
 * wakes, `ps` reads their /proc/<pid>/cmdline, which kernel patch 0021 brings in for it. The
 * checkpoint zeroes the page allocator's free pages (patch 0020), counted here. Every read of the
 * image is traced: those the restore makes, those in a second with no input (by window), and those the
 * commands cause.
 * `node --experimental-strip-types experiments/mmu/scripts/lazy-restore.ts` (after boot stage.sh)
 */
const root = new URL('../../../', import.meta.url).pathname;
const vendor = join(root, 'experiments/boot/vendor');
const read = (name: string) => new Uint8Array(readFileSync(join(vendor, name)));
const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const manifest = JSON.parse(readFileSync(join(root, 'build/kernel/manifest.json'), 'utf8'));

let output = '';
const options: MachineOptions = {
	vmlinux: new WebAssembly.Module(read('vmlinux.async.wasm')),
	initrd: read('initramfs.bin'),
	cmdline:
		'maxcpus=3 root=/dev/ram0 rootfstype=ramfs init=/init console=hvc console=ttyS0',
	registry: new Map([[manifest.busybox, new WebAssembly.Module(read('busybox.async.wasm'))]]),
	maximumPages: 2048,
	sha256,
	sharedKernel: true,
	asyncify: true,
	write: (text) => (output += text)
};
const run = (m: Machine, until: () => boolean, ms = 60_000) => {
	const t = Date.now();
	return m.run(() => until() || Date.now() - t > ms, (x) => new Promise((r) => setTimeout(r, Math.min(x, 20))));
};

let machine = new Machine(options);
await run(machine, () => output.includes('# '));
machine.type(
	'mkfifo /tmp/w1 /tmp/w2; for f in /tmp/w1 /tmp/w2; do ' +
		`sh -c 'x=$(yes a | head -c 6000000); read go < $1; echo "woke $1 \${#x}"' sh $f & done; ` +
		'sleep 2; echo @@READY-$((6*7))@@\n'
);
await run(machine, () => output.includes('@@READY-42@@'), 300_000);
await run(machine, () => false, 2000);
const snapshot = await machine.checkpoint();
const full = snapshot.memory;

// a stored image keeps no zero pages, so what a restore fetches is its non-zero pages
const words = new BigUint64Array(full.buffer, full.byteOffset, full.byteLength / 8);
const nonzero = (page: number) => {
	for (let i = page * 512; i < page * 512 + 512; i++) if (words[i]) return true;
	return false;
};
let bytes = 0;
// every read the restore makes, ms after the restore returned (negative: during it), and its bytes
let restored = 0;
const mib = (n: number) => +(n / 2 ** 20).toFixed(2);
const reads: [number, number][] = [];
const source = {
	byteLength: full.byteLength,
	read: (start: number, end: number) => {
		const before = bytes;
		for (let page = start >>> 12; page < end >>> 12; page++) if (nonzero(page)) bytes += 4096;
		reads.push([restored ? performance.now() - restored : -1, bytes - before]);
		return full.slice(start, end);
	}
};
let stored = 0;
for (let page = 0; page < full.byteLength >>> 12; page++) if (nonzero(page)) stored += 4096;
const t0 = performance.now();
machine = await Machine.restore(options, { ...snapshot, memory: new Uint8Array(0) }, undefined, source);
const restoreMs = performance.now() - t0;
const atRestore = bytes;
const deferred = machine.stats.deferredPages;
const readsAtRestore = reads.length;
// a second with no input: what the machine brings in on its own, by window
restored = performance.now();
await run(machine, () => false, 1000);
const idle = Object.fromEntries(
	[1, 10, 100, 1000].map((ms) => {
		const hit = reads.slice(readsAtRestore).filter(([t]) => t <= ms);
		return [`${ms}ms`, { reads: hit.length, MiB: mib(hit.reduce((n, [, b]) => n + b, 0)) }];
	})
);
const readsIdle = reads.length;

const mark = output.length;
machine.type('echo shell-$((1+1))\n');
await run(machine, () => output.slice(mark).includes('shell-2'));
const afterShell = bytes;
// the sleepers' command lines, read through /proc while their pages are still held back
const psMark = output.length;
// busybox ps prints [sh] for a command line it reads as empty; [r] keeps grep off its own line
machine.type('ps w | grep -c "[r]ead go" ; echo ps-$((2+1))\n');
await run(machine, () => output.slice(psMark).includes('ps-3'));
const psLines = Number(/\n(\d+)\r?\n/.exec(output.slice(psMark))?.[1] ?? -1);
const touched = machine.stats.touchedPages;
machine.type('echo go > /tmp/w1\n');
await run(machine, () => output.slice(mark).includes('woke /tmp/w1'));
await run(machine, () => output.endsWith('# '));
const afterFirst = bytes;
machine.type('echo go > /tmp/w2\n');
await run(machine, () => output.slice(mark).includes('woke /tmp/w2'));
const tail = output.slice(mark);
const later = reads.slice(readsIdle);
console.log(
	JSON.stringify({
		machineMiB: mib(full.byteLength),
		storedMiB: mib(stored),
		restoreMs: Math.round(restoreMs),
		fetchedAtRestoreMiB: mib(atRestore),
		readsAtRestore,
		// with no input, by window after the restore returned
		idle,
		// after the idle second, driven by the commands below: reads, and bytes per read
		readsAfterIdle: later.length,
		bytesPerReadAfterIdle: later.length ? Math.round(later.reduce((n, [, b]) => n + b, 0) / later.length) : 0,
		deferredPages: deferred,
		deferredMiB: mib(deferred * 4096),
		afterShellMiB: mib(afterShell - atRestore),
		afterFirstSleeperMiB: mib(afterFirst - afterShell),
		afterSecondSleeperMiB: mib(bytes - afterFirst),
		filledPages: machine.stats.filledPages,
		// both sleepers' full command lines; without patch 0021 ps sees none
		psSleepers: psLines,
		touchedPages: touched,
		freePagesZeroed: snapshot.stats.freePages,
		// the command substitution drops the last newline of the 6,000,000 bytes
		sleepersExact: /woke \/tmp\/w1 5999999/.test(tail) && /woke \/tmp\/w2 5999999/.test(tail),
		crashed: String(machine.crashed)
	})
);
if (process.env.DEBUG) console.log(JSON.stringify(tail.slice(-600)));
process.exit(0);
