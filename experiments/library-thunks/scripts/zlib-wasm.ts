import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { appendCpio } from '../../../scripts/wasm/cpio-append.ts';
import { Machine } from '../../../src/worker/machine/machine.ts';

/**
 * zbench's crc32, adler32, compress2 and uncompress over a guest libz, in a machine under node (V8, the engine
 * workerd runs) with the zlib kernels on and off, and natively on the host. One machine boots once and runs
 * every cell; each sample takes the timing lock and reads quiet.sh before and after, and waits (WAITS tries,
 * 15 s apart) for a reading of 0.5 or less. The guest's libz, loader and zbench are zlib-guest.sh's.
 *
 * env: BUNDLE (a kernel build: initramfs.bin or initrd.cpio, busybox.wasm, vmlinux.wasm, manifest.json), WASM
 * (katybug.wasm) and INST (its instrumented build), GUEST (zlib-guest.sh's output), HOSTBENCH (zbench built on this
 * host), OUT (the samples file), CPU, LOCK, QUIET (quiet.sh); REPS (5), OPS ("crc adl def inf"), ITERS ("100 100 3 30",
 * one per op), ARMS ("native kernel off"; "four" is the four whole-buffer kernels without the stream entries).
 * An op written gzrun:<c|cd>:<MiB>:<level>:<chunk> is zbench's gzip-format stream over generated data (its ITERS
 * entry is unused)
 */
const env = (name: string, fallback?: string) => {
	const v = process.env[name] ?? fallback;
	if (v === undefined) throw new Error(`set ${name}`);
	return v;
};
const bundle = env('BUNDLE');
const wasm = env('WASM');
const inst = env('INST');
const guestDir = env('GUEST');
const hostBench = env('HOSTBENCH');
const out = env('OUT');
const cpu = env('CPU');
const lock = env('LOCK');
const quiet = env('QUIET');
const reps = Number(env('REPS', '5'));
const waits = Number(env('WAITS', '8'));
const ops = env('OPS', 'crc adl def inf').split(' ');
const iters = env('ITERS', '100 100 3 30').split(' ');
const arms = env('ARMS', 'native kernel off').split(' ');
// everything but the four zlib kernels: the off arm differs from the kernel arm by those alone
const OFF = 'strlen,memcmp,strcmp,memchr,memcpy,memmove,memset,exp,log,pow';
// the four whole-buffer kernels without the stream entries ("zstream" is their one switch)
const FOUR = 'crc32,adler32,compress2,uncompress';
const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const read = (path: string) => new Uint8Array(readFileSync(path));
const manifest = JSON.parse(readFileSync(join(bundle, 'manifest.json'), 'utf8'));

let output = '';
const registry = new Map<string, WebAssembly.Module>([[manifest.busybox, new WebAssembly.Module(read(join(bundle, 'busybox.wasm')))]]);
registry.set(sha256(read(wasm)), new WebAssembly.Module(read(inst)));
const cpio = `${out}.cpio`;
const base = existsSync(join(bundle, 'initrd.cpio')) ? join(bundle, 'initrd.cpio') : join(bundle, 'initramfs.bin');
appendCpio(base, cpio, [
	`/bin/katybug=${wasm}`,
	`/bin/zbench=${join(guestDir, 'zbench')}`,
	`/lib/ld-musl-x86_64.so.1=${join(guestDir, 'ld-musl-x86_64.so.1')}`,
	`/lib/libz.so.1=${join(guestDir, 'libz.so.1')}`
]);
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
	machine.type(`${cmd}; echo "${mark.slice(0, 2)}""${mark.slice(2)} $?"\n`);
	await machine.run(() => output.indexOf(mark, from) >= 0 && /\n/.test(output.slice(output.indexOf(mark, from))), sleep, 3_600_000);
	const ms = performance.now() - t;
	const status = output.slice(output.indexOf(mark, from) + mark.length).trim().split(/\s/)[0];
	return { ms, status, text: output.slice(from, output.indexOf(mark, from)) };
};
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

writeFileSync(out, 'arm\top\titers\trep\tms\tquiet_before\tquiet_after\tok\tdigest\tstatus\n');
console.log(`node ${process.version}, V8 ${process.versions.v8}, cpu ${cpu}`);
await machine.run(() => output.includes('# '), sleep, 300_000);
const hostCorpus = `${out}.corpus`;
native(`${hostBench} corpus ${hostCorpus}`);
if (!existsSync(hostCorpus)) throw new Error('the host corpus was not written');
const gen = await guest('zbench corpus /tmp/c; ls -l /tmp/c');
if (gen.status !== '0') throw new Error(`the guest corpus was not written: ${gen.text.slice(-300)}`);
// an op written gzrun:<c|cd>:<MiB>:<level>:<chunk> is zbench's gzip-format stream over generated data
const gz = (op: string) => op.startsWith('gzrun:');
// the kernels run in the machine: one line per op from the prim log (untimed)
for (const op of ops) {
	const probe = gz(op) ? `gzrun cd 1 6 ${op.split(':')[4]}` : `run ${op} 2 /tmp/c`;
	const r = await guest(`rm -f /tmp/pz; KATYBUG_STATS=1 KATYBUG_PRIM_LOG=/tmp/pz zbench ${probe}; cat /tmp/pz`);
	console.log(`kernels ${op}: ${r.text.split('\n').filter((l) => l.includes('katybug: prim')).pop() ?? 'none'}`);
}
const want = new Map<string, string>();
const prim = (arm: string) =>
	arm === 'off' ? `KATYBUG_PRIM=${OFF} ` : arm === 'four' ? `KATYBUG_PRIM=${OFF},${FOUR} ` : '';
const cmdOf = (arm: string, op: string, n: string) => {
	const args = gz(op) ? op.replaceAll(':', ' ') : `run ${op} ${n} ${arm === 'native' ? hostCorpus : '/tmp/c'}`;
	return arm === 'native' ? `${hostBench} ${args}` : `${prim(arm)}zbench ${args}`;
};
const dead = new Set<string>();
let failedInARow = 0;
for (let rep = 0; rep < reps; rep++)
	for (const [i, op] of ops.entries())
		for (const arm of arms) {
			if (dead.has(`${arm}-${op}`)) continue;
			const n = iters[i]!;
			const s = await sample(async () => (arm === 'native' ? native(cmdOf(arm, op, n)) : guest(cmdOf(arm, op, n))));
			const digest = s.text.trim().split('\n').pop() ?? 'none';
			if (arm === 'native') want.set(op, digest);
			const status = 'status' in s ? s.status : '-';
			const ok = Number(digest === want.get(op) && (status === '-' || status === '0'));
			if (!ok) console.log(`check failed: ${arm} ${op}: status ${status}, got ${JSON.stringify(digest)}, want ${JSON.stringify(want.get(op))}`);
			const row = [arm, op, n, rep, s.ms.toFixed(1), s.q0, s.q1, ok, digest.replaceAll('\t', ' '), status].join('\t');
			appendFileSync(out, `${row}\n`);
			console.log(row);
			failedInARow = ok ? 0 : failedInARow + 1;
			if (!ok) dead.add(`${arm}-${op}`);
			if (failedInARow >= 3) {
				console.log('three failed checks in a row: stopping');
				process.exit(1);
			}
		}
process.exit(0);
