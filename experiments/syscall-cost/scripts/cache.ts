import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Machine } from '../../../src/worker/machine/machine.ts';

/**
 * The statx cache (MachineOptions.syscallCache) on shell workloads: `ls -l /bin` in a loop, a statx
 * of every entry by its absolute path (ash's own PATH search tries execve, not statx), and a mutation
 * script whose output must be byte for byte the same with the cache as without, while every hit is
 * checked against the kernel in verify mode. VMLINUX names a kernel with patch 0022 (build/kernel's by
 * default).
 * `node --experimental-strip-types experiments/syscall-cost/scripts/cache.ts [iterations]`
 */
const root = new URL('../../../', import.meta.url).pathname;
const kernel = join(process.env.GMUX_BUILD ?? join(root, 'build'), 'kernel');
const read = (path: string) => new Uint8Array(readFileSync(path));
const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const manifest = JSON.parse(readFileSync(join(kernel, 'manifest.json'), 'utf8'));
const vmlinux = new WebAssembly.Module(read(process.env.VMLINUX ?? join(kernel, 'vmlinux.wasm')));
const busybox = new WebAssembly.Module(read(join(kernel, 'busybox.wasm')));
const n = Number(process.argv[2] ?? 100);

// ls -l and stat print times, so the script pins them with touch -d first
const MUTATIONS = [
	'mkdir -p /w/a/b; cd /w',
	'for i in 1 2 3; do echo $i > a/f$i; done; touch -d "2020-01-01 00:00:00" a/f1 a/f2 a/f3 a a/b',
	'stat -c "%n %s %a %h" a/f1 a/f2 a/f3 /w/a/f1 /w/a/nope 2>&1',
	'mv /w/a/f1 /w/a/b/g; stat -c "%n %s" /w/a/f1 /w/a/b/g 2>&1',
	// changes inside one clock tick: a write that stores no new time, a chmod that stores the same one
	'echo a > /w/s; stat -c "%s" /w/s; echo bb >> /w/s; stat -c "%s" /w/s; chmod 600 /w/s; stat -c "%a" /w/s; chmod 644 /w/s; stat -c "%a" /w/s',
	'chmod 600 /w/a/f2; stat -c "%n %a" /w/a/f2',
	'echo longer > /w/a/f3; stat -c "%n %s" /w/a/f3',
	'rm /w/a/f2; stat -c "%n" /w/a/f2 2>&1; ln -s /w/a/f3 /w/a/l; stat -c "%n %s" /w/a/l; stat -L -c "%n %s" /w/a/l',
	'mkdir /w/a/f2; stat -c "%n %F" /w/a/f2; rmdir /w/a/f2; stat -c "%n" /w/a/f2 2>&1',
	'mount -t tmpfs none /w/a/b 2>&1; stat -c "%n" /w/a/b/g 2>&1; umount /w/a/b; stat -c "%n %s" /w/a/b/g',
	'for p in /proc/1 /proc/999 /proc/self/fd; do stat -c "%n %F" $p 2>&1; done'
];

async function session(syscallCache: boolean | 'verify') {
	let output = '';
	const machine = new Machine({
		vmlinux,
		initrd: read(join(kernel, 'initramfs.bin')),
		cmdline: 'maxcpus=3 root=/dev/ram0 rootfstype=ramfs init=/init console=hvc console=ttyS0',
		registry: new Map([[manifest.busybox, busybox]]),
		maximumPages: 1024,
		sha256,
		sharedKernel: true,
		syscallCache,
		write: (text) => (output += text)
	});
	const run = async (until: () => boolean) => {
		const t = Date.now();
		await machine.run(
			() => until() || Date.now() - t > 300_000,
			(ms) => new Promise((r) => setTimeout(r, Math.min(ms, 5)))
		);
		if (!until()) throw new Error(`stuck: ${output.slice(-300)}`);
	};
	// what the command printed, between markers the shell prints: the echo of typed input wraps and
	// interleaves by timing, so it is left out
	const command = async (cmd: string, marker: string) => {
		const at = output.length;
		machine.type(`echo ${marker}A$((1+1)); ${cmd}; echo ${marker}B$((1+1))\n`);
		await run(() => output.slice(at).includes(`${marker}B2\r\n`));
		const text = output.slice(at).replaceAll('\r', '');
		const end = text.indexOf(`${marker}B2\n`);
		return text.slice(text.lastIndexOf(`\n${marker}A2\n`, end) + 1, end);
	};
	await run(() => output.includes('# '));
	const t0 = performance.now();
	await command(`i=0; while [ $i -lt ${n} ]; do ls -l /bin > /dev/null; i=$((i+1)); done`, '@@L');
	const loopMs = performance.now() - t0;
	const loopStats = { ...machine.stats };
	let transcript = '';
	for (const line of MUTATIONS) transcript += await command(line, '@@M');
	return {
		loopMs: Math.round(loopMs),
		usPerIteration: +((loopMs * 1000) / n).toFixed(1),
		loop: { hits: loopStats.statxHits, misses: loopStats.statxMisses, fills: loopStats.statxFills },
		stats: {
			hits: machine.stats.statxHits,
			misses: machine.stats.statxMisses,
			fills: machine.stats.statxFills,
			mismatches: machine.stats.statxMismatches
		},
		transcript
	};
}

const off = await session(false);
const on = await session(true);
const verify = await session('verify');
console.log(JSON.stringify({ arm: 'off', loopMs: off.loopMs, usPerIteration: off.usPerIteration }));
console.log(JSON.stringify({ arm: 'cache', ...on, transcript: undefined }));
console.log(JSON.stringify({ arm: 'verify', ...verify, transcript: undefined }));
const exact = on.transcript === off.transcript && verify.transcript === off.transcript;
console.log(JSON.stringify({ transcriptsEqual: exact, mismatches: verify.stats.mismatches }));
if (!exact) console.log(off.transcript, '\n----\n', on.transcript);
const pass = exact && verify.stats.mismatches === 0 && on.stats.hits > 0;
console.log(pass ? 'PASS statx cache exact' : 'FAIL statx cache exact');
process.exit(pass ? 0 : 1);
