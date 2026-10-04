import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { appendCpio } from '../../../scripts/wasm/cpio-append.ts';
import { Machine } from '../../../src/worker/machine/machine.ts';

/**
 * Host crossings per syscall in a fork child (experiments/mmu/src/calls.c, built like a tests/c
 * probe): `calls.c` does n of one call in the child and brackets them with markers, and the machine's
 * crossing counters are read at each marker. A crossing is a copy (`userCopies`) or a string
 * (`userStrings`) between the kernel and the child's memory. GMUX_BUILD picks the build.
 * `node --experimental-strip-types experiments/mmu/scripts/calls.ts <calls.wasm> [n] [call...]`
 */
const root = new URL('../../../', import.meta.url).pathname;
const [plain, n = '1000', ...named] = process.argv.slice(2);
if (!plain) throw new Error('usage: calls.ts <calls.wasm> [n] [call...]');
const calls = named.length ? named : ['getpid', 'stat', 'open', 'read', 'writev', 'readv'];
const build = process.env.GMUX_BUILD ?? join(root, 'build');
const work = mkdtempSync(join(tmpdir(), 'gmux-calls-'));
const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const sh = (cmd: string, args: string[]) =>
	execFileSync(cmd, args, { stdio: ['ignore', 'ignore', 'inherit'] });
const ts = join(root, 'scripts/ts');

// the build a forking probe gets: fueled, then resumable frames
sh(join(root, 'scripts/wasm/instrument.sh'), [plain, join(work, 'calls.fuel.wasm')]);
sh(ts, [
	join(root, 'scripts/wasm/export-globals.ts'),
	join(work, 'calls.fuel.wasm'),
	join(work, 'calls.g.wasm'),
	'--all-mutable'
]);
sh(process.execPath, [
	join(root, 'experiments/evacuation/scripts/evacuate.ts'),
	join(work, 'calls.g.wasm'),
	join(work, 'calls.evac.wasm'),
	'--fold'
]);
const manifest = JSON.parse(readFileSync(join(build, 'kernel/manifest.json'), 'utf8'));
const registry = new Map<string, WebAssembly.Module>();
registry.set(
	manifest.busybox,
	new WebAssembly.Module(readFileSync(join(build, 'kernel/busybox.wasm')))
);
registry.set(
	sha256(readFileSync(plain)),
	new WebAssembly.Module(readFileSync(join(work, 'calls.evac.wasm')))
);
appendCpio(join(build, 'kernel/initramfs.bin'), join(work, 'initramfs.cpio'), [
	`/bin/calls=${plain}`
]);

type Counters = {
	copies: number;
	copyBytes: number;
	strings: number;
	stringBytes: number;
	at: number;
};
let output = '';
let seen = 0;
const marks = new Map<string, Counters>();
const machine: Machine = new Machine({
	vmlinux: new WebAssembly.Module(readFileSync(join(build, 'kernel/vmlinux.wasm'))),
	initrd: new Uint8Array(readFileSync(join(work, 'initramfs.cpio'))),
	cmdline: 'maxcpus=1 root=/dev/ram0 rootfstype=ramfs init=/init console=hvc console=ttyS0',
	registry,
	maximumPages: 4096,
	sha256,
	sharedKernel: true,
	write: (text) => {
		output += text;
		const markers = /@@(\w+)@@/g;
		markers.lastIndex = seen;
		for (let m; (m = markers.exec(output)); seen = markers.lastIndex) {
			const s = machine.stats;
			marks.set(m[1]!, {
				copies: s.userCopies,
				copyBytes: s.userCopyBytes,
				strings: s.userStrings,
				stringBytes: s.userStringBytes,
				at: performance.now()
			});
		}
	}
});
const run = (until: () => boolean) =>
	machine.run(until, (ms) => new Promise((r) => setTimeout(r, Math.min(ms, 20))));
if (process.env.DEBUG) setTimeout(() => console.error(output.slice(-2000)), 30000);
await run(() => output.includes('# '));
for (const call of calls) {
	// $((0)) keeps the typed line from matching the marker it prints
	machine.type(`calls ${call} ${n}; echo @@$((0))${call}done@@\n`);
	await run(() => marks.has(`0${call}done`) || !!machine.crashed);
	if (machine.crashed) throw machine.crashed;
	const a = marks.get(`${call}a`)!;
	const b = marks.get(`${call}b`)!;
	const per = (x: number, y: number) => +((y - x) / Number(n)).toFixed(3);
	console.log(
		JSON.stringify({
			call,
			n: Number(n),
			copiesPerCall: per(a.copies, b.copies),
			stringsPerCall: per(a.strings, b.strings),
			crossingsPerCall: per(a.copies + a.strings, b.copies + b.strings),
			bytesPerCall: per(a.copyBytes + a.stringBytes, b.copyBytes + b.stringBytes),
			nsPerCall: Math.round(((b.at - a.at) * 1e6) / Number(n))
		})
	);
}
if (process.env.DEBUG) console.log(output.slice(-2000));
process.exit(0);
