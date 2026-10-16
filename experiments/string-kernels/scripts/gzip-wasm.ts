import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { gzipSync } from 'node:zlib';
import { appendCpio } from '../../../scripts/wasm/cpio-append.ts';
import { nodeInflater } from '../../../src/worker/machine/inflate.ts';
import { Machine } from '../../../src/worker/machine/machine.ts';

/**
 * `gzip -dc` (what zcat and gunzip -c run) of gzip files under a machine in node (V8) with the kernels off, with the crc
 * loop only (kernel) and with the host inflate (host), and natively. d8 is eight distinct MIB MiB files of text gzipped at
 * level 6 (natively one command over all eight; in the machine one file at a time, a boot per file and round so the ramfs holds
 * one, eight runs per sample, each taking the timing lock and reading quiet.sh before and after it); pipe-out and pipe-in are the
 * first file with the output sent through a pipe and with the input read from one (a stream the host inflate refuses). gen cells
 * time `dd` reading the same file(s). A sample's check is the exit status, the host streams it took (1 per host run, 0 in
 * the others) and, once per arm and file outside the timed part, the md5 of what it printed.
 *
 * env: BUNDLE (a kernel build: initramfs.bin or initrd.cpio, busybox.wasm, vmlinux.wasm, manifest.json), GZIP_BIN (GZIP is gzip's own option variable; the static x86-64
 * GNU gzip 1.13, in the guest as /bin/gzip and run natively), WASM (katybug.wasm) and INST (its instrumented build), OUT (the
 * samples file), CPU, LOCK, QUIET (quiet.sh); REPS (5), MIB (64), WAITS (8) tries of 15 s for a quiet reading of 0.5 or less,
 * ARMS (native,off,kernel,host; off is the guest's own inflate and crc), INPUTS (d8,pipe-out,pipe-in), FILES (8)
 */
const env = (name: string, fallback?: string) => {
	const v = process.env[name] ?? fallback;
	if (v === undefined) throw new Error(`set ${name}`);
	return v;
};
const bundle = env('BUNDLE');
const gzip = env('GZIP_BIN');
const wasm = env('WASM');
const inst = env('INST');
const out = env('OUT');
const cpu = env('CPU');
const lock = env('LOCK');
const quiet = env('QUIET');
const reps = Number(env('REPS', '5'));
const mib = Number(env('MIB', '64'));
const waits = Number(env('WAITS', '8'));
const arms = env('ARMS', 'native,off,kernel,host').split(',');
const inputs = env('INPUTS', 'd8,pipe-out,pipe-in').split(',');
const nfiles = Number(env('FILES', '8'));
const armEnv = (arm: string) => (arm === 'off' ? 'KATYBUG_PRIM=0 ' : arm === 'kernel' ? 'KATYBUG_PRIM=gzcrc ' : '');
const md5 = (bytes: Uint8Array) => createHash('md5').update(bytes).digest('hex');
const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const read = (path: string) => new Uint8Array(readFileSync(path));
const manifest = JSON.parse(readFileSync(join(bundle, 'manifest.json'), 'utf8'));

// eight distinct files of words, gzipped once outside every timed part
const dir = resolve(`${out}.files`);
mkdirSync(dir, { recursive: true });
const want: string[] = [];
for (let i = 0; i < nfiles; i++) {
	let seed = 1000 + i;
	const r = () => (seed = (Math.imul(seed, 1103515245) + 12345) >>> 0) >>> 8;
	const words = Array.from({ length: 4000 }, () => Array.from({ length: 3 + (r() % 8) }, () => String.fromCharCode(97 + (r() % 26))).join(''));
	const raw = Buffer.alloc(mib << 20);
	let o = 0;
	while (o < raw.length) o += raw.write(words[r() % words.length] + (r() % 7 ? ' ' : '\n'), o);
	want.push(md5(raw));
	if (!existsSync(join(dir, `g${i}.gz`))) writeFileSync(join(dir, `g${i}.gz`), gzipSync(raw.subarray(0, mib << 20), { level: 6 }));
}
const files = Array.from({ length: nfiles }, (_, i) => join(dir, `g${i}.gz`));

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
	return { ms: performance.now() - t, text: r.stdout, status: String(r.status) };
};

// a machine with one file in its ramfs
const registry = new Map<string, WebAssembly.Module>([[manifest.busybox, new WebAssembly.Module(read(join(bundle, 'busybox.wasm')))]]);
registry.set(sha256(read(wasm)), new WebAssembly.Module(read(inst)));
const vmlinux = new WebAssembly.Module(read(join(bundle, 'vmlinux.wasm')));
const base = existsSync(join(bundle, 'initrd.cpio')) ? join(bundle, 'initrd.cpio') : join(bundle, 'initramfs.bin');
const boot = async (file: string) => {
	let output = '';
	const cpio = `${out}.cpio`;
	appendCpio(base, cpio, [`/bin/katybug=${wasm}`, `/bin/gzip=${gzip}`, `/g.gz=${file}`]);
	const machine = new Machine({
		vmlinux,
		initrd: read(cpio),
		cmdline: 'maxcpus=3 root=/dev/ram0 rootfstype=ramfs init=/init console=hvc console=ttyS0',
		registry,
		maximumPages: 4096,
		sha256,
		inflate: nodeInflater,
		sharedKernel: true,
		write: (text) => (output += text)
	});
	const sleep = (ms: number) => new Promise((r) => setTimeout(r, Math.min(ms, 5)));
	await machine.run(() => output.includes('# '), sleep, 300_000);
	const guest = async (cmd: string) => {
		const mark = `@@${Math.random().toString(36).slice(2)}`;
		const from = output.length;
		const t = performance.now();
		machine.type(`B=/bin; ${cmd}; echo "${mark.slice(0, 2)}""${mark.slice(2)} $?"\n`);
		await machine.run(() => output.indexOf(mark, from) >= 0 && /\n/.test(output.slice(output.indexOf(mark, from))), sleep, 3_600_000);
		const ms = performance.now() - t;
		const status = output.slice(output.indexOf(mark, from) + mark.length).trim().split(/\s/)[0];
		return { ms, status, text: output.slice(from, output.indexOf(mark, from)) };
	};
	return { machine, guest };
};

const columns = 'arm\ttool\tinput\trep\tms\tquiet_before\tquiet_after\tok\tstatus\thost_streams\n';
writeFileSync(out, columns);
console.log(`node ${process.version}, V8 ${process.versions.v8}, cpu ${cpu}`);
const nat = (input: string) =>
	input === 'd8'
		? `${gzip} -dc ${files.join(' ')} > /dev/null`
		: input === 'pipe-out'
			? `${gzip} -dc ${files[0]} | cat > /dev/null`
			: `cat ${files[0]} | ${gzip} -dc > /dev/null`;
const gcmd = (arm: string, input: string, file: string) =>
	input === 'd8'
		? `${armEnv(arm)}$B/gzip -dc ${file} > /dev/null`
		: input === 'pipe-out'
			? `${armEnv(arm)}$B/gzip -dc ${file} | $B/busybox cat > /dev/null`
			: `$B/busybox cat ${file} | ${armEnv(arm)}$B/gzip -dc > /dev/null`;
const rows: string[] = [];
let failedInARow = 0;
const dead = new Set<string>();
const emit = (arm: string, input: string, rep: number, ms: number, q0: string, q1: string, ok: number, status: string, streams: number, tool = 'gzip -dc') => {
	const row = [arm, tool, input, rep, ms.toFixed(1), q0, q1, ok, status, streams].join('\t');
	appendFileSync(out, `${row}\n`);
	rows.push(row);
	console.log(row);
	failedInARow = ok ? 0 : failedInARow + 1;
	if (!ok) dead.add(`${arm}-${input}`);
	if (failedInARow >= 3) {
		console.log('three failed checks in a row: stopping');
		process.exit(1);
	}
};
for (let rep = 0; rep < reps; rep++) {
	// the control and the floors natively
	if (inputs.includes('d8')) {
		const f = await sample(() => native(`for f in ${files.join(' ')}; do dd if=$f of=/dev/null bs=32768 2> /dev/null; done`));
		emit('gen-native', 'd8', rep, f.ms, f.q0, f.q1, 1, '-', 0, 'dd');
	}
	for (const input of inputs) {
		if (!arms.includes('native') || dead.has(`native-${input}`)) continue;
		const s = await sample(() => native(nat(input)));
		emit('native', input, rep, s.ms, s.q0, s.q1, Number(s.status === '0'), s.status, 0);
	}
	// the machine: one boot per file, the arms and floors inside it
	const sums = new Map<string, { arm: string; input: string; ms: number; q0: number; q1: number; ok: number; streams: number; status: string }>();
	for (let i = 0; i < nfiles; i++) {
		const { machine, guest } = await boot(files[i]);
		const cells: [string, string][] = [];
		for (const arm of arms.filter((a) => a !== 'native')) {
			if (inputs.includes('d8')) cells.push([arm, 'd8']);
			if (i === 0) for (const input of inputs.filter((n) => n !== 'd8')) cells.push([arm, input]);
		}
		if (inputs.includes('d8')) cells.push(['gen-guest', 'd8']);
		for (const [arm, input] of cells) {
			if (dead.has(`${arm}-${input}`)) continue;
			const n0 = machine.stats.inflates;
			const cmd = arm === 'gen-guest' ? '$B/busybox dd if=/g.gz of=/dev/null bs=32768 2> /dev/null' : gcmd(arm, input, '/g.gz');
			const s = await sample(() => guest(cmd));
			const streams = machine.stats.inflates - n0;
			// the md5 of what a run prints, once per arm and file, outside the timed part
			let ok = Number(s.status === '0');
			if (rep === 0 && arm !== 'gen-guest' && input === 'd8') {
				const r = await guest(`${armEnv(arm)}$B/gzip -dc /g.gz | $B/busybox md5sum`);
				ok &&= Number(r.text.includes(want[i]));
				if (!ok) console.log(`check failed: arm ${arm} file ${i}, wanted ${want[i]}, got ${JSON.stringify(r.text.slice(-200))}`);
			}
			if (arm === 'host' && input !== 'pipe-in') ok &&= Number(streams === 1);
			else if (arm !== 'gen-guest') ok &&= Number(streams === 0 || arm === 'host');
			const sum = sums.get(`${arm}-${input}`) ?? { arm, input, ms: 0, q0: 0, q1: 0, ok: 1, streams: 0, status: '0' };
			sum.ms += s.ms;
			sum.q0 = Math.max(sum.q0, Number(s.q0));
			sum.q1 = Math.max(sum.q1, Number(s.q1));
			sum.ok &&= ok;
			sum.streams += streams;
			if (s.status !== '0') sum.status = s.status;
			sums.set(`${arm}-${input}`, sum);
		}
	}
	for (const s of sums.values())
		emit(s.arm, s.input, rep, s.ms, String(s.q0), String(s.q1), s.ok, s.status, s.streams, s.arm === 'gen-guest' ? 'dd' : 'gzip -dc');
}
process.exit(0);
