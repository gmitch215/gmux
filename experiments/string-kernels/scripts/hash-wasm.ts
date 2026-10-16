import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { appendCpio } from '../../../scripts/wasm/cpio-append.ts';
import { Machine, type HostDigest } from '../../../src/worker/machine/machine.ts';

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
 * ARMS (native,kernel,off): the arms; kernel is every kernel but the host digest, host is all of them, the machine
 * giving the program node:crypto. INPUTS (zero): zero is the files above; d8 is eight distinct FILEMIB files (natively one
 * command over all eight; in the machine one file at a time, written before its sample and removed after it, so the
 * ramfs holds one; the generated lines are the same bytes natively) and p512 a 512 MiB stream of zeros (natively from
 * a file, in the machine through a pipe from busybox head, whose own time is the gen-guest cell). TRACE (unset): the time
 * inside the machine's __gmux_digest import and inside node's Hash.update, per sample, in the last three columns. Diagnostic
 * arms of the host digest, all with the host digest on: nohash takes the bytes and hashes none (every cost but the hash),
 * batch64 and batch1m stage the bytes of many calls into one buffer and hash it in one update
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
const arms = env('ARMS', 'native,kernel,off').split(',');
const inputs = env('INPUTS', 'zero').split(',');
// katybug's kernels by name (prim.c), all of them but "digest": KATYBUG_PRIM takes a list
const kernels =
	'strlen,memcmp,strcmp,memchr,memcpy,memmove,memset,exp,log,pow,crc32,adler32,compress2,uncompress,zstream,sha256,md5,sha1,sha512,cksum';
const armEnv = (arm: string) => (arm === 'off' ? 'KATYBUG_PRIM=0 ' : arm === 'kernel' ? `KATYBUG_PRIM=${kernels} ` : '');
const line = (i: number) => `d8-${i}-the-quick-brown-fox-jumps-over-the-lazy-dog`;
const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const read = (path: string) => new Uint8Array(readFileSync(path));
const manifest = JSON.parse(readFileSync(join(bundle, 'manifest.json'), 'utf8'));

let output = '';
const registry = new Map<string, WebAssembly.Module>([[manifest.busybox, new WebAssembly.Module(read(join(bundle, 'busybox.wasm')))]]);
registry.set(sha256(read(wasm)), new WebAssembly.Module(read(inst)));
const cpio = `${out}.cpio`;
const base = existsSync(join(bundle, 'initrd.cpio')) ? join(bundle, 'initrd.cpio') : join(bundle, 'initramfs.bin');
appendCpio(base, cpio, [`/bin/katybug=${wasm}`, `/bin/coreutils=${coreutils}`]);
const traced = env('TRACE', '') !== '';
let updateNs = 0n;
// the arm of the running cell: nohash takes the bytes and hashes nothing (the digest is wrong; the sample is everything but
// the hash), batch64 and batch1m stage the bytes of many calls and hash them in one update
let hostArm = '';
const hasher = (algorithm: string): HostDigest => {
	const h = createHash(algorithm);
	const size = hostArm === 'batch64' ? 65536 : hostArm === 'batch1m' ? 1048576 : 0;
	if (!traced && !size && hostArm !== 'nohash') return h;
	const staged = new Uint8Array(size);
	let n = 0;
	const update = (data: Uint8Array) => {
		const t = process.hrtime.bigint();
		h.update(data);
		updateNs += process.hrtime.bigint() - t;
	};
	const flush = () => {
		if (n) update(staged.subarray(0, n));
		n = 0;
	};
	return {
		update(data) {
			if (hostArm === 'nohash') return;
			if (!size) return update(data);
			if (data.length > size - n) flush();
			if (data.length >= size) return update(data);
			staged.set(data, n);
			n += data.length;
		},
		digest() {
			flush();
			return h.digest();
		},
		copy() {
			flush();
			return h.copy();
		}
	};
};
const machine = new Machine({
	vmlinux: new WebAssembly.Module(read(join(bundle, 'vmlinux.wasm'))),
	initrd: read(cpio),
	cmdline: 'maxcpus=3 root=/dev/ram0 rootfstype=ramfs init=/init console=hvc console=ttyS0',
	registry,
	maximumPages: 4096,
	sha256,
	digest: (algorithm) => hasher(algorithm),
	sharedKernel: true,
	write: (text) => (output += text)
});
// TRACE: the time spent inside the machine's __gmux_digest import and its calls, per sample (the hrtime pair costs about 0.1 us a call)
let importNs = 0n;
let importCalls = 0;
if (traced) {
	const m = machine as unknown as { hostDigest: (...a: number[]) => number };
	const host = m.hostDigest.bind(machine);
	m.hostDigest = (...a) => {
		const t = process.hrtime.bigint();
		const r = host(...a);
		importNs += process.hrtime.bigint() - t;
		importCalls++;
		return r;
	};
}
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

writeFileSync(out, 'arm\ttool\tmib\trep\tms\tquiet_before\tquiet_after\tok\tdigest\tstatus\thost_digests\timport_ms\timport_calls\tupdate_ms\n');
console.log(`node ${process.version}, V8 ${process.versions.v8}, cpu ${cpu}`);
await machine.run(() => output.includes('# '), sleep, 300_000);
const zero = inputs.includes('zero');
const zeroMibs = zero ? mibs : [];
const size = (mib: number) => Math.min(mib, fileMib);
const copies = (mib: number) => (mib === 0 ? 1 : mib / size(mib));
const dir = resolve(`${out}.files`);
mkdirSync(dir, { recursive: true });
const names = (root: string, mib: number) => Array.from({ length: copies(mib) }, () => `${root}/z${size(mib)}`).join(' ');
for (const mib of new Set(zeroMibs.map(size))) writeFileSync(join(dir, `z${mib}`), new Uint8Array(mib * 1048576));
for (const mib of new Set(zeroMibs.map(size))) {
	const r = await guest(`$B/busybox head -c ${mib * 1048576} /dev/zero > /tmp/z${mib}; $B/busybox ls -l /tmp/z${mib}`);
	if (r.status !== '0') throw new Error(`could not write /tmp/z${mib} in the guest: ${r.text.slice(-300)}`);
}
// eight distinct files and a 512 MiB file of zeros, written natively outside every timed part
const eight = Array.from({ length: 8 }, (_, i) => i);
if (inputs.includes('d8'))
	for (const i of eight) spawnSync('sh', ['-c', `yes '${line(i)}' | head -c ${fileMib * 1048576} > ${dir}/d${i}`]);
if (inputs.includes('p512')) spawnSync('sh', ['-c', `head -c 536870912 /dev/zero > ${dir}/z512p`]);
const nat = (tool: string, mib: number | string) =>
	mib === 'd8'
		? `${coreutils} --coreutils-prog=${tool} ${eight.map((i) => `${dir}/d${i}`).join(' ')}`
		: mib === 'p512'
			? `${coreutils} --coreutils-prog=${tool} ${dir}/z512p`
			: `${coreutils} --coreutils-prog=${tool} ${names(dir, mib as number)}`;
const gst = (tool: string, mib: number, env = '') => `${env}$B/coreutils --coreutils-prog=${tool} ${names('/tmp', mib)}`;
const floor = (root: string, mib: number, dd: string) =>
	`for f in ${names(root, mib)}; do ${dd} if=$f of=/dev/null bs=32768 2> /dev/null; done`;
const cells: { arm: string; tool: string; mib: number | string; n: number }[] = [];
for (const mib of zeroMibs) {
	cells.push({ arm: 'gen-native', tool: 'dd', mib, n: reps }, { arm: 'gen-guest', tool: 'dd', mib, n: mib > offMax ? bigReps : reps });
	for (const tool of tools) {
		cells.push({ arm: 'native', tool, mib, n: reps });
		for (const arm of arms.filter((a) => a !== 'native')) {
			if (arm === 'off' && mib > offMax) continue;
			cells.push({ arm, tool, mib, n: arm === 'off' ? (mib >= 64 ? bigReps : reps) : mib >= 512 ? bigReps : reps });
		}
	}
}
for (const mib of ['d8', 'p512'].filter((i) => inputs.includes(i))) {
	cells.push({ arm: 'gen-native', tool: 'dd', mib, n: reps }, { arm: 'gen-guest', tool: 'dd', mib, n: reps });
	for (const tool of tools) for (const arm of arms) cells.push({ arm, tool, mib, n: reps });
}
// the reads of eight files, and the producer of the stream, each alone
const floorOf = (mib: number | string) =>
	mib === 'd8'
		? { native: `for f in ${eight.map((i) => `${dir}/d${i}`).join(' ')}; do dd if=$f of=/dev/null bs=32768 2> /dev/null; done`, guest: '' }
		: mib === 'p512'
			? { native: `dd if=${dir}/z512p of=/dev/null bs=32768 2> /dev/null`, guest: '$B/busybox head -c 536870912 /dev/zero > /dev/null' }
			: { native: floor(dir, mib as number, 'dd'), guest: floor('/tmp', mib as number, '$B/busybox dd') };
// the eight files in the machine, one at a time: written before the sample, removed after it
const d8 = async (run: (file: string) => Promise<{ ms: number; text: string; status: string; q0: string; q1: string }>) => {
	let ms = 0;
	let q0 = 0;
	let q1 = 0;
	let status = '0';
	const text: string[] = [];
	for (const i of eight) {
		await guest(`$B/busybox yes '${line(i)}' | $B/busybox head -c ${fileMib * 1048576} > /tmp/d`);
		const s = await run('/tmp/d');
		ms += s.ms;
		q0 = Math.max(q0, Number(s.q0));
		q1 = Math.max(q1, Number(s.q1));
		if (s.status !== '0') status = s.status;
		text.push(s.text);
		await guest('$B/busybox rm -f /tmp/d');
	}
	return { ms, text: text.join('\n'), status, q0: String(q0), q1: String(q1) };
};
const want = new Map<string, string>();
const rows: string[] = [];
// a failed check ends its cell, three in a row end the sweep
const dead = new Set<string>();
let failedInARow = 0;
for (let rep = 0; rep < Math.max(reps, bigReps); rep++)
	for (const c of cells) {
		if (rep >= c.n || dead.has(`${c.arm}-${c.tool}-${c.mib}`)) continue;
		const key = `${c.tool}-${c.mib}`;
		hostArm = c.arm;
		const h0 = machine.stats.digests;
		const n0 = importNs;
		const c0 = importCalls;
		const u0 = updateNs;
		const run = async () => {
			if (c.arm === 'gen-native') return native(floorOf(c.mib).native);
			if (c.arm === 'native') return native(nat(c.tool, c.mib));
			if (c.mib === 'd8')
				return d8((file) =>
					sample(() =>
						guest(
							c.arm === 'gen-guest'
								? `$B/busybox dd if=${file} of=/dev/null bs=32768 2> /dev/null`
								: `${armEnv(c.arm)}$B/coreutils --coreutils-prog=${c.tool} ${file}`
						)
					)
				);
			if (c.mib === 'p512')
				return guest(
					c.arm === 'gen-guest'
						? floorOf('p512').guest
						: `$B/busybox head -c 536870912 /dev/zero | ${armEnv(c.arm)}$B/coreutils --coreutils-prog=${c.tool}`
				);
			if (c.arm === 'gen-guest') return guest(floor('/tmp', c.mib as number, '$B/busybox dd'));
			return guest(gst(c.tool, c.mib as number, armEnv(c.arm)));
		};
		const s = c.mib === 'd8' && c.arm !== 'native' && c.arm !== 'gen-native' ? await run() : await sample(run);
		const d = digestOf(s.text);
		if (c.arm === 'native') want.set(key, d);
		const exit0 = 'status' in s ? s.status === '0' : true;
		// nohash prints a digest of nothing, so only its status can be checked
		const ok = c.arm.startsWith('gen') ? 1 : c.arm === 'nohash' ? Number(exit0) : Number(d !== 'none' && d === want.get(key) && exit0);
		const status = 'status' in s ? s.status : '-';
		if (!ok) console.log(`check failed: status ${status}, digest ${d}, want ${want.get(key)}, text ${JSON.stringify(s.text.slice(-300))}`);
		const row = [c.arm, c.tool, c.mib, rep, s.ms.toFixed(1), s.q0, s.q1, ok, d.slice(0, 8), status, machine.stats.digests - h0, (Number(importNs - n0) / 1e6).toFixed(2), importCalls - c0, (Number(updateNs - u0) / 1e6).toFixed(2)].join('\t');
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
console.log(`memory pages ${machine.memory.buffer.byteLength / 65536} rss ${(process.memoryUsage().rss / 1048576).toFixed(1)} MiB`);
process.exit(0);
