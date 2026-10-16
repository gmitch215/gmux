import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmdirSync, writeFileSync } from 'node:fs';
import { Session } from 'node:inspector/promises';
import { join, resolve } from 'node:path';
import { appendCpio } from '../../../scripts/wasm/cpio-append.ts';
import { hostRuntime } from '../../../scripts/wasm/router-modules.ts';
import { Machine, type SyscallCall } from '../../../src/worker/machine/machine.ts';

/**
 * the byte path inside a machine, command by command (the cells below), natively and in the machine.
 *   MODE=time (default): wall time per sample, the machine's counters per sample, the lock and quiet.sh per
 *     sample; every cell's digest must equal the digest of 512 MiB of zeros
 *   MODE=count: one counted run of each guest cell (MachineOptions.countSyscalls): calls by number, the request
 *     sizes of read and write, bytes moved; the machine's counters. A counted run pays a crossing per call and is not timed
 *   MODE=profile: a sampled run of each guest cell (100 us), leaf frames by class: bulk memory instructions in the
 *     kernel (CLASSES, a json of function indexes), the rest of the kernel, programs, host JS, idle
 * env: BUNDLE (a kernel build dir: initramfs.bin, busybox.wasm, vmlinux.wasm, manifest.json; its parent also holds
 * router/ and is GMUX_BUILD), COREUTILS (static x86-64, in the guest as /bin/coreutils), NATBB (static x86-64 BusyBox
 * 1.36.1), WASM and INST (katybug and its instrumented build), OUT (samples file), CPU, LOCK, QUIET; REPS (5), CELLS
 * (names, default all), FILEMIB (64), WAITS (8), CLASSES
 */
const env = (name: string, fallback?: string) => {
	const v = process.env[name] ?? fallback;
	if (v === undefined) throw new Error(`set ${name}`);
	return v;
};
const mode = env('MODE', 'time');
const bundle = env('BUNDLE');
const coreutils = env('COREUTILS');
const natbb = env('NATBB');
const wasm = env('WASM');
const inst = env('INST');
const out = env('OUT');
const cpu = env('CPU', '0');
const lock = env('LOCK', '');
const quiet = env('QUIET', '');
const reps = Number(env('REPS', '5'));
const fileMib = Number(env('FILEMIB', '64'));
const waits = Number(env('WAITS', '8'));
const MIB = 1048576;
const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const read = (path: string) => new Uint8Array(readFileSync(path));
const manifest = JSON.parse(readFileSync(join(bundle, 'manifest.json'), 'utf8'));

// cell: the guest command ($B is /bin, CU the coreutils prog, F the 64 MiB zero file name) and the native one
type Cell = { id: string; mib: number; cmd: string; hash?: boolean };
const BIG = 536870912;
const F8 = (root: string) => Array.from({ length: 8 }, () => `${root}/z${fileMib}`).join(' ');
const dd = (bs: number) => `dd if=/dev/zero of=/dev/null bs=${bs} count=${BIG / bs}`;
const cells: Cell[] = [
	{ id: 'head', mib: 512, cmd: `BB head -c ${BIG} /dev/zero > /dev/null` },
	{ id: 'dd4k', mib: 512, cmd: `BB ${dd(4096)} 2> /dev/null` },
	{ id: 'dd32k', mib: 512, cmd: `BB ${dd(32768)} 2> /dev/null` },
	{ id: 'dd1m', mib: 512, cmd: `BB ${dd(MIB)} 2> /dev/null` },
	{ id: 'cn', mib: 512, cmd: `BB cat ${F8('ROOT')} > /dev/null` },
	{ id: 'hc', mib: 512, cmd: `BB head -c ${BIG} /dev/zero | BB cat > /dev/null` },
	{ id: 'pp4k', mib: 512, cmd: `BB ${dd(4096)} 2> /dev/null | BB dd of=/dev/null bs=4096 2> /dev/null` },
	{ id: 'pp32k', mib: 512, cmd: `BB ${dd(32768)} 2> /dev/null | BB dd of=/dev/null bs=32768 2> /dev/null` },
	{ id: 'pp1m', mib: 512, cmd: `BB ${dd(MIB)} 2> /dev/null | BB dd of=/dev/null bs=1048576 2> /dev/null` },
	{ id: 'hm', mib: 512, cmd: `BB head -c ${BIG} /dev/zero | MD5`, hash: true },
	{ id: 'cm', mib: 512, cmd: `BB cat ${F8('ROOT')} | MD5`, hash: true },
	// start-up of the same pipelines with no bytes: what a table subtracts
	{ id: 'dd0', mib: 0, cmd: 'BB dd if=/dev/zero of=/dev/null bs=4096 count=1 2> /dev/null' },
	{ id: 'hc0', mib: 0, cmd: 'BB head -c 0 /dev/zero | BB cat > /dev/null' },
	{ id: 'hm0', mib: 0, cmd: 'BB head -c 0 /dev/zero | MD5', hash: true }
];
const wanted = env('CELLS', cells.map((c) => c.id).join(' ')).split(' ');
const picked = cells.filter((c) => wanted.includes(c.id));
const guestCmd = (c: Cell) =>
	c.cmd.replaceAll('BB', '$B/busybox').replaceAll('MD5', '$B/coreutils --coreutils-prog=md5sum').replaceAll('ROOT', '/tmp');
const dir = resolve(`${out}.files`);
const nativeCmd = (c: Cell) =>
	c.cmd.replaceAll('BB', natbb).replaceAll('MD5', `${coreutils} --coreutils-prog=md5sum`).replaceAll('ROOT', dir);
const zeroDigest = (() => {
	const h = createHash('md5');
	h.update(new Uint8Array(BIG));
	return h.digest('hex');
})();
const emptyDigest = createHash('md5').digest('hex');

let output = '';
const registry = new Map<string, WebAssembly.Module>([[manifest.busybox, new WebAssembly.Module(read(join(bundle, 'busybox.wasm')))]]);
registry.set(sha256(read(wasm)), new WebAssembly.Module(read(inst)));
mkdirSync(dir, { recursive: true });
const cpio = `${out}.cpio`;
const base = existsSync(join(bundle, 'initrd.cpio')) ? join(bundle, 'initrd.cpio') : join(bundle, 'initramfs.bin');
appendCpio(base, cpio, [`/bin/katybug=${wasm}`, `/bin/coreutils=${coreutils}`]);
const counted = mode === 'count';
const calls = new Map<string, number>();
const sizes = new Map<string, number>();
let ioBytes = 0;
const NEVER_RETURN = new Set([93, 94, 221, 139]);
const onCall = (call: SyscallCall) => {
	if (call.ret === null && !NEVER_RETURN.has(call.nr)) return;
	calls.set(String(call.nr), (calls.get(String(call.nr)) ?? 0) + 1);
	if ((call.nr === 63 || call.nr === 64) && call.ret !== null) {
		const key = `${call.nr === 63 ? 'read' : 'write'} ${call.args[2]! >>> 0}`;
		sizes.set(key, (sizes.get(key) ?? 0) + 1);
		if (call.ret > 0) ioBytes += call.ret;
	}
};
const machine = new Machine({
	vmlinux: new WebAssembly.Module(read(join(bundle, 'vmlinux.wasm'))),
	initrd: read(cpio),
	cmdline: 'maxcpus=3 root=/dev/ram0 rootfstype=ramfs init=/init console=hvc console=ttyS0',
	registry,
	maximumPages: 4096,
	sha256,
	digest: (algorithm) => createHash(algorithm),
	sharedKernel: true,
	...(counted ? { runtime: hostRuntime(), countSyscalls: onCall } : {}),
	write: (text) => (output += text)
});
const sleep = (ms: number) => new Promise((r) => setTimeout(r, Math.min(ms, 5)));
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
const digestOf = (text: string) => text.match(/[0-9a-f]{32}/g)?.join(',') ?? 'none';

const pause = (ms: number) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const take = () => {
	if (!lock) return;
	for (;;) {
		try {
			mkdirSync(lock);
			return;
		} catch {
			pause(10_000);
		}
	}
};
const q = () => (quiet ? (spawnSync('bash', [quiet, cpu, '1'], { encoding: 'utf8' }).stdout.trim().split(' ')[1] ?? '?') : '-');
const sample = async <T extends { ms: number }>(run: () => Promise<T> | T) => {
	for (let t = 0; ; t++) {
		take();
		const q0 = q();
		if (quiet && Number(q0) > 0.5 && t < waits) {
			if (lock) rmdirSync(lock);
			pause(15_000);
			continue;
		}
		try {
			const r = await run();
			return { ...r, q0, q1: q() };
		} finally {
			if (lock) rmdirSync(lock);
		}
	}
};
const native = (cmd: string) => {
	const t = performance.now();
	const r = spawnSync('sh', ['-c', cmd], { encoding: 'utf8', maxBuffer: 1 << 20 });
	return { ms: performance.now() - t, text: r.stdout, status: String(r.status) };
};

console.log(`node ${process.version}, V8 ${process.versions.v8}, cpu ${cpu}, mode ${mode}`);
await machine.run(() => output.includes('# '), sleep, 300_000);
writeFileSync(join(dir, `z${fileMib}`), new Uint8Array(fileMib * MIB));
const w = await guest(`$B/busybox head -c ${fileMib * MIB} /dev/zero > /tmp/z${fileMib}; $B/busybox ls -l /tmp/z${fileMib}`);
if (w.status !== '0') throw new Error(`could not write /tmp/z${fileMib} in the guest: ${w.text.slice(-300)}`);
const statKeys = ['switches', 'idles', 'relaxes', 'fuelYields', 'pumpSteps', 'hostSleeps', 'userCopies', 'userTouches', 'digests', 'digestBytes'] as const;
const snap = () => statKeys.map((k) => (machine.stats as unknown as Record<string, number>)[k]!);
const wantDigest = (c: Cell) => (c.hash ? (c.mib ? zeroDigest : emptyDigest) : '');

if (mode === 'time') {
	writeFileSync(out, `arm\tcell\tmib\trep\tms\tquiet_before\tquiet_after\tok\tdigest\tstatus\t${statKeys.join('\t')}\n`);
	let failedInARow = 0;
	const dead = new Set<string>();
	for (let rep = 0; rep < reps; rep++)
		for (const c of picked)
			for (const arm of env('ARMS', 'native,guest').split(',')) {
				if (dead.has(`${arm}-${c.id}`)) continue;
				const s0 = snap();
				const s = await sample(() => (arm === 'native' ? native(nativeCmd(c)) : guest(guestCmd(c))));
				const d = c.hash ? digestOf(s.text) : '-';
				const ok = Number(s.status === '0' && (!c.hash || d === wantDigest(c)));
				if (!ok) console.log(`check failed: ${arm} ${c.id} status ${s.status}, digest ${d}, text ${JSON.stringify(s.text.slice(-200))}`);
				const deltas = arm === 'guest' ? snap().map((v, i) => v - s0[i]!) : statKeys.map(() => 0);
				const row = [arm, c.id, c.mib, rep, s.ms.toFixed(1), s.q0, s.q1, ok, d.slice(0, 8), s.status, ...deltas].join('\t');
				appendFileSync(out, `${row}\n`);
				console.log(row);
				failedInARow = ok ? 0 : failedInARow + 1;
				if (!ok) dead.add(`${arm}-${c.id}`);
				if (failedInARow >= 3) {
					console.log('three failed checks in a row: stopping');
					process.exit(1);
				}
			}
} else if (mode === 'native') {
	// strace -c -f and perf stat of each cell natively, one at a time (each slows its cell; not timed)
	const report: Record<string, unknown> = {};
	for (const c of picked) {
		const cmd = nativeCmd(c);
		const trace = `${out}.strace`;
		spawnSync('strace', ['-c', '-f', '-o', trace, 'sh', '-c', cmd], { encoding: 'utf8' });
		const byName: Record<string, number> = {};
		let total = 0;
		for (const l of readFileSync(trace, 'utf8').split('\n')) {
			const m = /^\s*[\d.]+\s+[\d.]+\s+\d+\s+(\d+)(?:\s+\d+)?\s+(\w+)$/.exec(l);
			if (m) byName[m[2]!] = Number(m[1]);
			const t = /^\s*100\.00\s+[\d.]+\s+\d+\s+(\d+)/.exec(l);
			if (t) total = Number(t[1]);
		}
		const perf = spawnSync('perf', ['stat', '-x,', '-e', 'task-clock,context-switches,cpu-migrations,page-faults,user_time,system_time', 'sh', '-c', cmd], { encoding: 'utf8' });
		const events: Record<string, number> = {};
		for (const l of perf.stderr.split('\n')) {
			const f = l.split(',');
			if (f.length > 3 && f[2] && !Number.isNaN(Number(f[0]))) events[f[2].replace(/:u$/, '')] = Number(f[0]);
		}
		report[c.id] = { mib: c.mib, syscalls: total, byName, events };
	}
	writeFileSync(out, JSON.stringify(report, null, 1));
	console.log(JSON.stringify(report));
} else if (mode === 'count') {
	const report: Record<string, unknown> = {};
	for (const c of picked) {
		calls.clear();
		sizes.clear();
		ioBytes = 0;
		const s0 = snap();
		const s = await guest(guestCmd(c));
		const d = c.hash ? digestOf(s.text) : '-';
		const total = [...calls.values()].reduce((a, b) => a + b, 0);
		report[c.id] = {
			mib: c.mib,
			status: s.status,
			digestOk: !c.hash || d === wantDigest(c),
			syscalls: total,
			byNr: Object.fromEntries([...calls].sort((a, b) => b[1] - a[1]).slice(0, 12)),
			ioSizes: Object.fromEntries([...sizes].sort((a, b) => b[1] - a[1]).slice(0, 8)),
			ioBytes,
			stats: Object.fromEntries(statKeys.map((k, i) => [k, snap()[i]! - s0[i]!]))
		};
	}
	writeFileSync(out, JSON.stringify(report, null, 1));
	console.log(JSON.stringify(report));
} else {
	// profile: the leaf frame of each sample, by class
	const classes = existsSync(env('CLASSES', '/nonexistent')) ? JSON.parse(readFileSync(env('CLASSES'), 'utf8')) : { copy: [], fill: [] };
	const bulk = new Map<number, string>();
	for (const i of classes.copy) bulk.set(i, 'kernel copy (memory.copy)');
	for (const i of classes.fill) bulk.set(i, 'kernel clear (memory.fill)');
	type Node = { id: number; callFrame: { functionName: string; url: string; lineNumber: number; columnNumber: number }; children?: number[] };
	const report: Record<string, unknown> = {};
	const preps = Number(env('PREPS', '1'));
	for (let prep = 0; prep < preps; prep++)
		for (const c of picked) {
		const run = await sample(async () => {
			const session = new Session();
			session.connect();
			await session.post('Profiler.enable');
			await session.post('Profiler.setSamplingInterval', { interval: 100 });
			await session.post('Profiler.start');
			const t0 = performance.now();
			const s = await guest(guestCmd(c));
			const ms = performance.now() - t0;
			const { profile } = await session.post('Profiler.stop');
			session.disconnect();
			return { ms, s, profile };
		});
		const { ms, s, profile } = run;
		const nodes = new Map<number, Node>(profile.nodes.map((x: Node) => [x.id, x]));
		// the kernel is the wasm module with the highest function index (15,471 functions against BusyBox's 3,702)
		const top = new Map<string, number>();
		for (const x of nodes.values()) {
			const m = /wasm-function\[(\d+)\]/.exec(x.callFrame.functionName);
			if (m && x.callFrame.url.startsWith('wasm://')) top.set(x.callFrame.url, Math.max(top.get(x.callFrame.url) ?? 0, Number(m[1])));
		}
		const kernelUrls = new Set([...top].sort((a, b) => b[1] - a[1]).slice(0, 1).map(([u]) => u));
		const cats = new Map<string, number>();
		const leaves = new Map<string, number>();
		const bump = (m: Map<string, number>, k: string) => m.set(k, (m.get(k) ?? 0) + 1);
		for (const id of profile.samples ?? []) {
			const f = nodes.get(id)!.callFrame;
			let cat: string;
			if (f.functionName === '(idle)') cat = 'idle';
			else if (f.functionName === '(garbage collector)') cat = 'host JS (gc)';
			else if (f.url.startsWith('wasm://') && kernelUrls.has(f.url)) {
				const m = /wasm-function\[(\d+)\]/.exec(f.functionName);
				cat = (m && bulk.get(Number(m[1]))) || 'kernel (other)';
				bump(leaves, `kernel ${f.functionName}`);
			} else if (f.url.startsWith('wasm://')) {
				cat = 'programs (wasm)';
				bump(leaves, `program ${f.functionName}`);
			} else {
				cat = f.functionName === '(program)' ? 'host (program)' : 'host JS';
				bump(leaves, `host ${f.functionName || f.url}`);
			}
			bump(cats, cat);
		}
		const total = (profile.samples ?? []).length;
		report[`${c.id}#${prep}`] = {
			ms: Math.round(ms),
			quiet: [run.q0, run.q1],
			status: s.status,
			samples: total,
			categories: Object.fromEntries([...cats].map(([k, v]) => [k, +((100 * v) / total).toFixed(2)])),
			topLeaves: Object.fromEntries([...leaves].sort((a, b) => b[1] - a[1]).slice(0, 14).map(([k, v]) => [k, +((100 * v) / total).toFixed(2)]))
		};
	}
	writeFileSync(out, JSON.stringify(report, null, 1));
	console.log(JSON.stringify(report));
}
process.exit(0);
