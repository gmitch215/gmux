import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { appendCpio } from '../../../scripts/wasm/cpio-append.ts';
import { Machine } from '../../../src/worker/machine/machine.ts';

/**
 * A process's own memory against the machine's shared one (experiments/mmu/src/own.c, built like a
 * tests/c probe): the same phases as root in the shared memory (p), in a fork child, which gets its
 * own memory and reaches the kernel through host copies (c), and as uid 1000 in the shared memory
 * under the checked guard (g). Host milliseconds per phase, medians over the rounds, and the bytes
 * each memory holds. GMUX_BUILD picks the build.
 * `node --experimental-strip-types experiments/mmu/scripts/own-memory.ts <own.wasm> [rounds]`
 */
const root = new URL('../../../', import.meta.url).pathname;
const [plain, rounds = '3'] = process.argv.slice(2);
if (!plain) throw new Error('usage: own-memory.ts <own.wasm> [rounds]');
const build = process.env.GMUX_BUILD ?? join(root, 'build');
const work = mkdtempSync(join(tmpdir(), 'gmux-own-'));
const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const sh = (cmd: string, args: string[]) => execFileSync(cmd, args, { stdio: ['ignore', 'ignore', 'inherit'] });
const ts = join(root, 'scripts/ts');

// root's build: fueled, then resumable frames, as tests/c/run.ts builds a forking probe
sh(join(root, 'scripts/wasm/instrument.sh'), [plain, join(work, 'own.fuel.wasm')]);
sh(ts, [join(root, 'scripts/wasm/export-globals.ts'), join(work, 'own.fuel.wasm'), join(work, 'own.g.wasm'), '--all-mutable']);
sh(process.execPath, [join(root, 'experiments/evacuation/scripts/evacuate.ts'), join(work, 'own.g.wasm'), join(work, 'own.evac.wasm'), '--fold']);
const evacuated = new WebAssembly.Module(readFileSync(join(work, 'own.evac.wasm')));
sh('wasm2wat', ['--enable-threads', '--enable-exceptions', '--generate-names', plain, '-o', join(work, 'own.wat')]);
const registry = new Map<string, WebAssembly.Module>();
const guarded = new Map<string, WebAssembly.Module>();
const manifest = JSON.parse(readFileSync(join(build, 'kernel/manifest.json'), 'utf8'));
registry.set(manifest.busybox, new WebAssembly.Module(readFileSync(join(build, 'kernel/busybox.wasm'))));
registry.set(sha256(readFileSync(plain)), evacuated);
const files = [`/bin/own=${plain}`];
for (const [arm, flag] of [['inline', '--inline']]) {
	// its own file in the image (a custom section naming it), so the kernel hashes it apart
	const name = new TextEncoder().encode('gmux.arm');
	const payload = new TextEncoder().encode(arm!);
	const image = join(work, `own.${arm}.image.wasm`);
	writeFileSync(image, new Uint8Array([...readFileSync(plain), 0, name.length + 1 + payload.length, name.length, ...name, ...payload]));
	sh(ts, [join(root, 'scripts/wasm/guard-pass.ts'), join(work, 'own.wat'), join(work, `own.${arm}.wat`), flag!]);
	sh('wat2wasm', ['--enable-threads', '--enable-exceptions', '--enable-multi-memory', join(work, `own.${arm}.wat`), '-o', join(work, `own.${arm}.wasm`)]);
	sh(join(root, 'scripts/wasm/instrument.sh'), [join(work, `own.${arm}.wasm`), join(work, `own.${arm}.fuel.wasm`)]);
	const hash = sha256(readFileSync(image));
	registry.set(hash, evacuated);
	guarded.set(hash, new WebAssembly.Module(readFileSync(join(work, `own.${arm}.fuel.wasm`))));
	files.push(`/bin/own.${arm}=${image}`);
}
appendCpio(join(build, 'kernel/initramfs.bin'), join(work, 'initramfs.cpio'), files);

let output = '';
let seen = 0;
const marks = new Map<string, number>();
const memories = { shared: 0, child: 0 };
const machine = new Machine({
	vmlinux: new WebAssembly.Module(readFileSync(join(build, 'kernel/vmlinux.wasm'))),
	initrd: new Uint8Array(readFileSync(join(work, 'initramfs.cpio'))),
	cmdline: 'maxcpus=1 root=/dev/ram0 rootfstype=ramfs init=/init console=hvc console=ttyS0',
	registry,
	guarded,
	maximumPages: 4096,
	sha256,
	sharedKernel: true,
	write: (text) => {
		output += text;
		// each complete marker once, from where the last one ended
		const markers = /@@(\w+)@@/g;
		markers.lastIndex = seen;
		for (let m; (m = markers.exec(output)); seen = markers.lastIndex) {
			marks.set(`${round}:${m[1]}`, performance.now());
			if (m[1] === 'cstreama') {
				const own = [...((machine as any).privateMemories as Map<number, WebAssembly.Memory>).values()];
				memories.child = Math.max(memories.child, ...own.map((m) => m.buffer.byteLength));
				memories.shared = machine.memory.buffer.byteLength;
			}
		}
	}
});
const run = (until: () => boolean) =>
	machine.run(until, (ms) => new Promise((r) => setTimeout(r, Math.min(ms, 20))));
let round = 0;
await run(() => output.includes('# '));
const done = (key: string) => () => marks.has(`${round}:${key}`) || !!machine.crashed;
for (round = 0; round < Number(rounds); round++) {
	machine.type('own fork; echo @@$((0))fork@@\n');
	await run(done('0fork'));
	machine.type('own drop /bin/own.inline phases; echo @@$((0))inline@@\n');
	await run(done('0inline'));
}
if (process.env.DEBUG) console.log(output.slice(-3000), [...marks.keys()].join(' '));
if (machine.crashed) throw machine.crashed;
const phases = ['stream', 'chase', 'mix', 'sort', 'getpid', 'stat', 'pipe4k', 'pipe64k'];
const median = (xs: number[]) => [...xs].sort((x, y) => x - y)[Math.floor(xs.length / 2)]!;
const ms = (who: string, phase: string) =>
	median(
		Array.from({ length: Number(rounds) }, (_, r) => marks.get(`${r}:${who}${phase}b`)! - marks.get(`${r}:${who}${phase}a`)!)
	);
for (const phase of phases) {
	const p = ms('p', phase);
	console.log(
		JSON.stringify({
			phase,
			sharedMs: +p.toFixed(1),
			ownChild: +(ms('c', phase) / p).toFixed(3),
			guarded: +(ms('g', phase) / p).toFixed(3)
		})
	);
}
console.log(JSON.stringify({ sharedMemoryBytes: memories.shared, childMemoryBytes: memories.child, forks: machine.stats.forks }));
process.exit(0);
