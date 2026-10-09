import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { hostRuntime } from '../../../scripts/wasm/router-modules.ts';
import { Machine } from '../../../src/worker/machine/machine.ts';

/**
 * The statx cache (MachineOptions.syscallCache) on shell workloads: `ls -l /bin` in a loop, a statx
 * of every entry by its absolute path (ash's own PATH search tries execve, not statx), a churn loop
 * (statx of 50 system paths while a conftest file is made and removed in /tmp), retention cases (what
 * a change must and must not end, read from the hit counter) and a mutation script whose output must
 * be byte for byte the same with the cache as without, while every hit is checked against the kernel
 * in verify mode. GMUX_BUILD names the kernel (build/kernel by default); a kernel with patch 0022 only
 * holds answers on its whole generation, one with patch 0029 on the inodes a path crossed.
 * TIMEOUT_MS bounds a command (300000 by default): a cache that answers wrongly can leave the shell
 * waiting on output that never comes. RELATIME=1 remounts / with relatime before the loops.
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
	'mv -f /w/a/f1 /w/a/b/g; stat -c "%n %s" /w/a/f1 /w/a/b/g 2>&1',
	// changes inside one clock tick: a write that stores no new time, a chmod that stores the same one
	'echo a > /w/s; stat -c "%s" /w/s; echo bb >> /w/s; stat -c "%s" /w/s; chmod 600 /w/s; stat -c "%a" /w/s; chmod 644 /w/s; stat -c "%a" /w/s',
	'chmod 600 /w/a/f2; stat -c "%n %a" /w/a/f2',
	'echo longer > /w/a/f3; stat -c "%n %s" /w/a/f3',
	'rm -f /w/a/f2; stat -c "%n" /w/a/f2 2>&1; ln -s /w/a/f3 /w/a/l; stat -c "%n %s" /w/a/l; stat -L -c "%n %s" /w/a/l',
	'mkdir /w/a/f2; stat -c "%n %F" /w/a/f2; rmdir /w/a/f2; stat -c "%n" /w/a/f2 2>&1',
	'mount -t tmpfs none /w/a/b 2>&1; stat -c "%n" /w/a/b/g 2>&1; umount /w/a/b; stat -c "%n %s" /w/a/b/g',
	'for p in /proc/1 /proc/999 /proc/self/fd; do stat -c "%n %F" $p 2>&1; done'
];

// changes under /usr and across directories, whose answers must follow the kernel's (the file is P)
const P = '/usr/p/q/f';
const USR = [
	'mkdir -p /usr/p/q /usr/c/bin; echo a > /usr/p/q/f; touch -d "2020-01-01 00:00:00" /usr/p /usr/p/q /usr/p/q/f',
	`stat -c "%n %s %a %h" ${P} /usr/p/q /usr/p/nope 2>&1`,
	`chmod 600 ${P}; stat -c "%n %a" ${P}; chmod 644 ${P}`,
	`chmod 700 /usr/p/q; stat -c "%n %a" ${P} /usr/p/q; chmod 755 /usr/p/q`,
	`mv -f ${P} /usr/p/q/g; stat -c "%n" ${P} /usr/p/q/g 2>&1; mv -f /usr/p/q/g ${P}`,
	`mv -f /usr/p/q /usr/p/q2; stat -c "%n" ${P} /usr/p/q2/f 2>&1; mv -f /usr/p/q2 /usr/p/q`,
	`mv -f ${P} /tmp/f2; stat -c "%n" ${P} /tmp/f2 2>&1; mv -f /tmp/f2 ${P}; stat -c "%n" ${P} /tmp/f2 2>&1`,
	`rm -f ${P}; stat -c "%n" ${P} 2>&1; echo b > ${P}; stat -c "%n %s" ${P}`,
	`echo longer > ${P}; stat -c "%n %s" ${P}`,
	`mount -t tmpfs none /usr/p/q 2>&1; stat -c "%n" ${P} 2>&1; umount /usr/p/q; stat -c "%n %s" ${P}`,
	`ln -s ${P} /usr/p/l; stat -c "%n %s" /usr/p/l; stat -L -c "%n %s" /usr/p/l; rm -f /usr/p/l; ln -s /usr/p /usr/p/l; stat -c "%n %s" /usr/p/l; stat -L -c "%n %F" /usr/p/l /usr/p/l/q/f`,
	'cp /bin/busybox /usr/c/bin/busybox; chroot /usr/c /bin/busybox stat -c "%n %s" /bin/busybox /usr 2>&1; stat -c "%n" /bin/busybox /usr/c/bin/busybox'
];

interface Retain {
	name: string;
	/** run once, caching the answer to `probe` */
	prime: string;
	/** the change */
	disturb: string;
	/** one statx; a hit when the answer was kept, a miss when the change ended it */
	probe: string;
	/** true: must be kept, false: must end, null: either is exact and the table records which */
	kept: boolean | null;
}
const retain = (
	name: string,
	disturb: string,
	kept: boolean | null,
	probe = `stat -c %n ${P}`,
	prime = probe
): Retain => ({ name, prime, disturb, probe, kept });
const RETAIN = [
	retain('write in /tmp', 'echo x > /tmp/t; rm -f /tmp/t', true),
	retain('write in /etc', 'echo x > /etc/t; rm -f /etc/t', true),
	retain('chmod of the file', `chmod 600 ${P}`, false),
	retain('write to the file', `echo y >> ${P}`, false),
	retain('chmod of the directory', 'chmod 700 /usr/p/q', null),
	retain('rename of the file', `mv -f ${P} /usr/p/q/g`, false),
	retain('rename of an ancestor', 'mv -f /usr/p/q /usr/p/q2', false, 'stat -c %n /usr/p/q/g'),
	retain('rename across directories', 'mv -f /usr/p/q2/g /tmp/g', false, 'stat -c %n /usr/p/q2/g'),
	retain('unlink of the file', 'rm -f /tmp/g', false, 'stat -c %n /tmp/g'),
	retain(
		'create under a cached ENOENT',
		'echo z > /usr/p/q2/none',
		false,
		'stat -c %n /usr/p/q2/none'
	),
	retain(
		'mount over the directory',
		'mount -t tmpfs none /usr/p/q2',
		false,
		'stat -c %n /usr/p/q2/none'
	),
	retain('unmount', 'umount /usr/p/q2', false, 'stat -c %n /usr/c/bin/busybox'),
	retain('path on another mount', ':', false, 'stat -c %n /proc'),
	retain(
		'symlink retarget',
		'rm -f /tmp/l1; ln -s /etc /tmp/l1',
		false,
		'stat -L -c %n /tmp/l1',
		'ln -s /usr /tmp/l1; stat -L -c %n /tmp/l1'
	)
];

// 50 system paths the loop never executes or reads: symlinks to busybox in /usr/bin, /usr/sbin, /sbin
const CHURN_PATHS =
	'P="$(ls -d /usr/bin/* | head -20) $(ls -d /usr/sbin/* | head -15) $(ls -d /sbin/* | head -15)"';

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
		runtime: hostRuntime(),
		write: (text) => (output += text)
	});
	const run = async (until: () => boolean) => {
		const t = Date.now();
		await machine.run(
			() => until() || Date.now() - t > Number(process.env.TIMEOUT_MS ?? 300_000),
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
	// statxFineFills and statxChains are absent from a host before patch 0029's
	const count = () => {
		const s = machine.stats as Machine['stats'] & { statxFineFills?: number; statxChains?: number };
		return {
			hits: s.statxHits,
			misses: s.statxMisses,
			fills: s.statxFills,
			fine: s.statxFineFills ?? 0,
			chains: s.statxChains ?? 0
		};
	};
	const since = (a: ReturnType<typeof count>) => {
		const b = count();
		return {
			hits: b.hits - a.hits,
			misses: b.misses - a.misses,
			fills: b.fills - a.fills,
			fine: b.fine - a.fine,
			chains: b.chains - a.chains
		};
	};
	// a timed loop of n iterations with the counters it moved
	const timed = async (cmd: string, marker: string) => {
		const c0 = count();
		const t0 = performance.now();
		await command(cmd, marker);
		const ms = performance.now() - t0;
		return { ms: Math.round(ms), us: +((ms * 1000) / n).toFixed(1), ...since(c0) };
	};
	await run(() => output.includes('# '));
	// the initramfs is mounted with no relatime, so every read stores an atime once per clock tick
	if (process.env.RELATIME) await command('mount -o remount,relatime /', '@@T');
	const loop = await timed(
		`i=0; while [ $i -lt ${n} ]; do ls -l /bin > /dev/null; i=$((i+1)); done`,
		'@@L'
	);
	await command(CHURN_PATHS, '@@P');
	const churn = await timed(
		`i=0; while [ $i -lt ${n} ]; do echo x > /tmp/conf$i.c; stat -c %n $P > /dev/null 2>&1; rm -f /tmp/conf$i.c; i=$((i+1)); done`,
		'@@C'
	);
	let transcript = '';
	for (const line of MUTATIONS) transcript += await command(line, '@@M');
	for (const line of USR) transcript += await command(line, '@@U');
	// each case starts from the file as it was left by the one before, named in RETAIN's order
	const retained: { name: string; kept: boolean | null; hits: number; misses: number }[] = [];
	await command(`mkdir -p /usr/p/q; echo a > ${P}`, '@@S');
	for (const c of RETAIN) {
		if (c.name === 'rename of an ancestor') await command('echo a > /usr/p/q/g', '@@S');
		transcript += await command(c.prime, '@@R');
		transcript += await command(c.disturb, '@@R');
		const c0 = count();
		transcript += await command(c.probe, '@@R');
		const d = since(c0);
		retained.push({ name: c.name, kept: c.kept, hits: d.hits, misses: d.misses });
	}
	const stats = count();
	return {
		loop,
		churn,
		retained,
		stats: { ...stats, mismatches: machine.stats.statxMismatches },
		transcript
	};
}

const arm = (mode: boolean | 'verify') =>
	session(mode).catch((error: Error) => {
		console.log(JSON.stringify({ arm: String(mode), error: error.message.slice(0, 300) }));
		console.log('FAIL statx cache exact');
		process.exit(1);
	});
const off = await arm(false);
const on = await arm(true);
const verify = await arm('verify');
const row = (name: string, s: Awaited<ReturnType<typeof session>>) =>
	console.log(JSON.stringify({ arm: name, loop: s.loop, churn: s.churn, stats: s.stats }));
row('off', off);
row('cache', on);
row('verify', verify);
const exact = on.transcript === off.transcript && verify.transcript === off.transcript;
console.log(JSON.stringify({ transcriptsEqual: exact, mismatches: verify.stats.mismatches }));
if (!exact) {
	// the first line a cache arm answered differently from the cache-off arm
	const want = off.transcript.split('\n');
	for (const [name, s] of [
		['cache', on],
		['verify', verify]
	] as const) {
		const got = s.transcript.split('\n');
		const at = want.findIndex((line, i) => line !== got[i]);
		if (at >= 0)
			console.log(JSON.stringify({ firstDifference: { arm: name, line: at, off: want[at], got: got[at] } }));
	}
}
// a probe a change must leave is a hit and one it must end is not; only a kernel with patch 0029 holds
// on inodes, so the kept cases need fills of that kind
const fine = on.stats.fine > 0;
const retention = on.retained.map((r) => ({
	...r,
	ok: r.kept === null || !fine ? null : r.kept === r.hits > 0,
	endedOk: r.kept === false ? r.hits === 0 : null
}));
console.log(JSON.stringify({ fineGuard: fine, retention }));
const retentionOk = retention.every((r) => r.ok !== false && r.endedOk !== false);
const pass = exact && verify.stats.mismatches === 0 && on.stats.hits > 0 && retentionOk;
console.log(pass ? 'PASS statx cache exact' : 'FAIL statx cache exact');
process.exit(pass ? 0 : 1);
