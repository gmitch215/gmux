import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { appendCpio } from '../../../scripts/wasm/cpio-append.ts';
import { Machine } from '../../../src/worker/machine/machine.ts';

/**
 * md5sum, sha1sum, sha256sum, sha512sum and cksum of zeros read from a file, under a machine in node (V8) with the kernel on and
 * off, and natively from a file of the same size. One machine boots once and runs every cell; each sample takes the
 * timing lock and reads quiet.sh before and after it, and waits (WAITS tries, 15 s apart) for a reading of 0.5 or
 * less. The ramfs cannot hold 512 MiB, so an input over FILEMIB is the same file named several times: the tool reads
 * and hashes 512 MiB, prints one digest per name, and starts up once. A pipe from `busybox head` was tried first and
 * its producer alone took 1.7 s of the 1.5-1.9 s a 512 MiB kernel sample took. `gen` cells time `dd` reading the
 * same files to /dev/null: the start-up and that read floor are what the table subtracts.
 *
 * env: BUNDLE (a kernel build: initramfs.bin or initrd.cpio, busybox.wasm, vmlinux.wasm, manifest.json), COREUTILS
 * (the static x86-64 coreutils, in the guest as /bin/coreutils and run natively), WASM (katybug.wasm) and INST
 * (its instrumented build), OUT (the samples file), CPU, LOCK, QUIET (quiet.sh); REPS (3) and BIGREPS (1) the samples of
 * a cell, MIBS ("0 1 64 512"), FILEMIB (64), OFFMAX (64) the largest input the off arm runs, TOOLS, WAITS (8)
 */
const env = (name: string, fallback?: string) => {
	const v = process.env[name] ?? fallback;
	if (v === undefined) throw new Error(`set ${name}`);
	return v;
};
const bundle = env('BUNDLE');
const coreutils = env('COREUTILS');
const wasm = env('WASM');
const inst = env('INST');
const out = env('OUT');
const cpu = env('CPU');
const lock = env('LOCK');
const quiet = env('QUIET');
const reps = Number(env('REPS', '3'));
const bigReps = Number(env('BIGREPS', '1'));
const mibs = env('MIBS', '0 1 64 512').split(' ').map(Number);
const offMax = Number(env('OFFMAX', '64'));
const fileMib = Number(env('FILEMIB', '64'));
const waits = Number(env('WAITS', '8'));
const tools = env('TOOLS', 'md5sum sha1sum sha256sum sha512sum cksum').split(' ');
const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const read = (path: string) => new Uint8Array(readFileSync(path));
const manifest = JSON.parse(readFileSync(join(bundle, 'manifest.json'), 'utf8'));

let output = '';
const registry = new Map<string, WebAssembly.Module>([[manifest.busybox, new WebAssembly.Module(read(join(bundle, 'busybox.wasm')))]]);
registry.set(sha256(read(wasm)), new WebAssembly.Module(read(inst)));
const cpio = `${out}.cpio`;
const base = existsSync(join(bundle, 'initrd.cpio')) ? join(bundle, 'initrd.cpio') : join(bundle, 'initramfs.bin');
appendCpio(base, cpio, [`/bin/katybug=${wasm}`, `/bin/coreutils=${coreutils}`]);
const machine = new Machine({
	vmlinux: new WebAssembly.Module(read(join(bundle, 'vmlinux.wasm'))),
	initrd: read(cpio),
	cmdline: 'maxcpus=3 root=/dev/ram0 rootfstype=ramfs init=/init console=hvc console=ttyS0',
	registry,
	maximumPages: 4096,
	sha256,
	sharedKernel: true,
	write: (text) => (output += text)
});
const sleep = (ms: number) => new Promise((r) => setTimeout(r, Math.min(ms, 5)));
const guest = async (cmd: string) => {
	const mark = `@@${Math.random().toString(36).slice(2)}`;
	const from = output.length;
	const t = performance.now();
	machine.type(`B=/bin; ${cmd}; echo "${mark.slice(0, 2)}""${mark.slice(2)} $?"\n`);
	const outcome = await machine.run(() => output.indexOf(mark, from) >= 0 && /\n/.test(output.slice(output.indexOf(mark, from))), sleep, 3_600_000);
	const ms = performance.now() - t;
	const status = output.slice(output.indexOf(mark, from) + mark.length).trim().split(/\s/)[0];
	return { ms, status, text: output.slice(from, output.indexOf(mark, from)) };
};
const digestOf = (text: string) => text.match(/[0-9a-f]{32,128}|^\d+ \d+(?= )/gm)?.join(',') ?? 'none';

const pause = (ms: number) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const take = () => {
	for (;;) {
		try {
			mkdirSync(lock);
			return;
		} catch {
			pause(10_000);
		}
	}
};
const q = () => spawnSync('bash', [quiet, cpu, '1'], { encoding: 'utf8' }).stdout.trim().split(' ')[1] ?? '?';
const sample = async <T extends { ms: number }>(run: () => Promise<T> | T) => {
	for (let t = 0; ; t++) {
		take();
		const q0 = q();
		if (Number(q0) > 0.5 && t < waits) {
			rmdirSync(lock);
			pause(15_000);
			continue;
		}
		try {
			const r = await run();
			return { ...r, q0, q1: q() };
		} finally {
			rmdirSync(lock);
		}
	}
};
const native = (cmd: string) => {
	const t = performance.now();
	const r = spawnSync('sh', ['-c', cmd], { encoding: 'utf8', maxBuffer: 1 << 20 });
	return { ms: performance.now() - t, text: r.stdout };
};

writeFileSync(out, 'arm\ttool\tmib\trep\tms\tquiet_before\tquiet_after\tok\tdigest\tstatus\n');
console.log(`node ${process.version}, V8 ${process.versions.v8}, cpu ${cpu}`);
await machine.run(() => output.includes('# '), sleep, 300_000);
const size = (mib: number) => Math.min(mib, fileMib);
const copies = (mib: number) => (mib === 0 ? 1 : mib / size(mib));
const dir = resolve(`${out}.files`);
mkdirSync(dir, { recursive: true });
const names = (root: string, mib: number) => Array.from({ length: copies(mib) }, () => `${root}/z${size(mib)}`).join(' ');
for (const mib of new Set(mibs.map(size))) writeFileSync(join(dir, `z${mib}`), new Uint8Array(mib * 1048576));
for (const mib of new Set(mibs.map(size))) {
	const r = await guest(`$B/busybox head -c ${mib * 1048576} /dev/zero > /tmp/z${mib}; $B/busybox ls -l /tmp/z${mib}`);
	if (r.status !== '0') throw new Error(`could not write /tmp/z${mib} in the guest: ${r.text.slice(-300)}`);
}
const nat = (tool: string, mib: number) => `${coreutils} --coreutils-prog=${tool} ${names(dir, mib)}`;
const gst = (tool: string, mib: number, env = '') => `${env}$B/coreutils --coreutils-prog=${tool} ${names('/tmp', mib)}`;
const floor = (root: string, mib: number, dd: string) =>
	`for f in ${names(root, mib)}; do ${dd} if=$f of=/dev/null bs=32768 2> /dev/null; done`;
const cells: { arm: string; tool: string; mib: number; n: number }[] = [];
for (const mib of mibs) {
	cells.push({ arm: 'gen-native', tool: 'dd', mib, n: reps }, { arm: 'gen-guest', tool: 'dd', mib, n: mib > offMax ? bigReps : reps });
	for (const tool of tools) {
		cells.push({ arm: 'native', tool, mib, n: reps });
		cells.push({ arm: 'kernel', tool, mib, n: mib >= 512 ? bigReps : reps });
		if (mib <= offMax) cells.push({ arm: 'off', tool, mib, n: mib >= 64 ? bigReps : reps });
	}
}
const want = new Map<string, string>();
const rows: string[] = [];
// a failed check ends its cell, three in a row end the sweep
const dead = new Set<string>();
let failedInARow = 0;
for (let rep = 0; rep < Math.max(reps, bigReps); rep++)
	for (const c of cells) {
		if (rep >= c.n || dead.has(`${c.arm}-${c.tool}-${c.mib}`)) continue;
		const key = `${c.tool}-${c.mib}`;
		const s = await sample(async () => {
			if (c.arm === 'gen-native') return native(floor(dir, c.mib, 'dd'));
			if (c.arm === 'gen-guest') return guest(floor('/tmp', c.mib, '$B/busybox dd'));
			if (c.arm === 'native') return native(nat(c.tool, c.mib));
			return guest(gst(c.tool, c.mib, c.arm === 'off' ? 'KATYBUG_PRIM=0 ' : ''));
		});
		const d = digestOf(s.text);
		if (c.arm === 'native') want.set(key, d);
		const ok = c.arm.startsWith('gen') ? 1 : Number(d !== 'none' && d === want.get(key) && ('status' in s ? s.status === '0' : true));
		const status = 'status' in s ? s.status : '-';
		if (!ok) console.log(`check failed: status ${status}, digest ${d}, want ${want.get(key)}, text ${JSON.stringify(s.text.slice(-300))}`);
		const row = [c.arm, c.tool, c.mib, rep, s.ms.toFixed(1), s.q0, s.q1, ok, d.slice(0, 8), status].join('\t');
		appendFileSync(out, `${row}\n`);
		rows.push(row);
		console.log(row);
		failedInARow = ok ? 0 : failedInARow + 1;
		if (!ok) dead.add(`${c.arm}-${c.tool}-${c.mib}`);
		if (failedInARow >= 3) {
			console.log('three failed checks in a row: stopping');
			process.exit(1);
		}
	}
process.exit(0);
