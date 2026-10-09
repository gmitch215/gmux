import { createHash } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmdirSync } from 'node:fs';
import { join } from 'node:path';
import v8 from 'node:v8';
import { appendCpio } from '../../../scripts/wasm/cpio-append.ts';
import { Machine } from '../../../src/worker/machine/machine.ts';

/**
 * One workload's promoted regions under V8: each arm is a katybug.wasm of its own (`int` has no regions,
 * `fn`, `fnc` and `all` carry region.sh's), the region arms run in the forms KATYBUG_REGS picks, and the timed
 * runs go round the arms so drift lands on all of them. The first run of each arm is kept apart from the
 * rest: it is the one that runs on Liftoff code while V8 tiers up. Run it under different node flags
 * (--no-liftoff, --liftoff-only, --no-wasm-tier-up) to move the tier-up out of the way.
 *
 * `region-wasm.ts <bundle> <variant dir> <rounds> <workload> [scale]`; ARMS=int,fnc:0,fnc:2 picks arms
 * (arm:form), the variants are `katybug-<arm>-<workload>.wasm` with their `.inst.wasm`; the arm `binary` runs NATIVE_CMD
 * pinned to NATIVE_CPU in each round. For a timed sweep set LOCK (taken per sample), QUIET_CPUS, SAMPLES and PROCESS (see
 * the block below `Arm`); a bundle may hold `initramfs.bin` in place of `initrd.cpio`, and the workloads are sha256, gzip,
 * bzip2, sqlite and bash.
 */
const [bundle = '', dir = '', roundsArg = '3', workload = 'gzip', scaleArg = '1'] = process.argv.slice(2);
const rounds = Number(roundsArg);
const scale = Number(scaleArg);
const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const read = (path: string) => new Uint8Array(readFileSync(path));
const manifest = JSON.parse(readFileSync(join(bundle, 'manifest.json'), 'utf8'));

const workloads: Record<string, string> = {
	sha256: '$B/coreutils --coreutils-prog=sha256sum /tmp/in',
	gzip: '$B/busybox-amd64 gzip -9 -c /tmp/in',
	bzip2: '$B/busybox-amd64 bzip2 -9 -c /tmp/in',
	sqlite: `$B/sqlite3 :memory: 'with recursive c(x) as (select 1 union all select x+1 from c where x<${100000 * scale}) select count(*), sum(x*x) % 1000003 from c;'`,
	bash: `$B/bash -c 'i=0; s=0; while [ $i -lt ${20000 * scale} ]; do s=$((s+i*i%7)); i=$((i+1)); done; echo $s'`
};
// a bundle holds initrd.cpio, build/kernel holds initramfs.bin
const initrdBase = existsSync(join(bundle, 'initrd.cpio')) ? join(bundle, 'initrd.cpio') : join(bundle, 'initramfs.bin');
const setup = `$B/busybox-amd64 seq 1 ${400000 * scale} > /tmp/in`;

function machine(name: string) {
	const registry = new Map<string, WebAssembly.Module>([[manifest.busybox, new WebAssembly.Module(read(join(bundle, 'busybox.wasm')))]]);
	const path = join(dir, `katybug-${name}-${workload}.wasm`);
	registry.set(sha256(read(path)), new WebAssembly.Module(read(path.replace(/\.wasm$/, '.inst.wasm'))));
	const cpio = join(dir, `${name}-${workload}.cpio`);
	appendCpio(initrdBase, cpio, [`/bin/katybug=${path}`]);
	let output = '';
	const m = new Machine({
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
	const run = async (cmd: string) => {
		const mark = `@@${Math.random().toString(36).slice(2)}`;
		const from = output.length;
		const t = performance.now();
		m.type(`B=/bin; ${cmd}; echo "${mark.slice(0, 2)}""${mark.slice(2)} $?"\n`);
		const outcome = await m.run(() => output.indexOf(mark, from) >= 0 && /\n/.test(output.slice(output.indexOf(mark, from))), sleep, 1_800_000);
		const ms = performance.now() - t;
		const status = output.slice(output.indexOf(mark, from) + mark.length).trim().split(/\s/)[0];
		if (outcome !== 'until' || status !== '0') throw new Error(`${name} ${workload}: ${cmd}: ${outcome}, status ${status}\n${output.slice(from).slice(-600)}`);
		return { ms, text: output.slice(from, output.indexOf(mark, from)) };
	};
	return { run, booted: () => m.run(() => output.includes('# '), sleep, 120_000) };
}

interface Arm {
	label: string;
	vm?: ReturnType<typeof machine>;
	env: string;
}
// LOCK takes a host timing lock around each sample, QUIET_CPUS reads build/batch/quiet.sh over it (above 0.5 the sample is
// noisy and taken once more), SAMPLES appends one tab-separated line per sample, NATIVE_CMD (with NATIVE_CPU) is what the
// `binary` arm runs. Three failed samples in a row stop the process; a failed arm drops out.
const lock = process.env.LOCK ?? '';
const quietCpus = process.env.QUIET_CPUS ?? '';
const samplesPath = process.env.SAMPLES ?? '';
const tag = process.env.PROCESS ?? '1';
const limit = Number(process.env.QUIET_LIMIT ?? 0.5);
const quietSh = new URL('../../../build/batch/quiet.sh', import.meta.url).pathname;
const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));
let held = false;
let failures = 0;
const release = () => {
	if (held) rmdirSync(lock);
	held = false;
};
process.on('exit', release);
for (const s of ['SIGINT', 'SIGTERM'] as const) process.on(s, () => process.exit(130));
async function acquire() {
	if (!lock) return;
	const until = Date.now() + 1000 * Number(process.env.LOCK_WAIT ?? 1800);
	for (;;) {
		try {
			mkdirSync(lock);
			held = true;
			return;
		} catch (e) {
			if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
			if (Date.now() > until) throw new Error(`no timing lock at ${lock}`);
			await pause(2000);
		}
	}
}
const quiet = () =>
	new Promise<number>((resolve) => {
		let text = '';
		const p = spawn('bash', [quietSh, quietCpus, '2']);
		p.stdout.on('data', (d) => (text += d));
		p.on('close', () => resolve(Number(/outside_busy ([\d.]+)/.exec(text)?.[1] ?? NaN)));
	});
const native = () => {
	const t = performance.now();
	const run = spawnSync('taskset', ['-c', process.env.NATIVE_CPU ?? '19', 'sh', '-c', `${process.env.NATIVE_CMD ?? 'false'} > /dev/null`]);
	if (run.status !== 0) throw new Error(`binary: status ${run.status}`);
	return { ms: performance.now() - t, text: '' };
};
// one timed sample under the lock; null when it failed, `noisy` when the quiet reading was above 0.5 and no retry was left
async function measure(a: Arm, round: string, cmd: string) {
	let last: { ms: number; text: string } | undefined;
	for (let attempt = 1; attempt <= (quietCpus ? 2 : 1); attempt++) {
		const until = Date.now() + 1000 * Number(process.env.QUIET_PREWAIT ?? 0);
		while (quietCpus && Date.now() < until && !((await quiet()) <= limit)) await pause(1000);
		await acquire();
		const q = quietCpus ? quiet() : undefined;
		let result: { ms: number; text: string } | undefined;
		try {
			result = a.vm ? await a.vm.run(cmd) : native();
		} catch (e) {
			console.error(`# ${a.label} ${round}: ${String(e).slice(0, 300)}`);
		}
		const reading = q ? await q : NaN;
		release();
		if (samplesPath)
			appendFileSync(samplesPath, `v8\t${workload}\t${a.label}\t${tag}\t${round}\t${attempt}\t${result ? result.ms.toFixed(0) : '-'}\t${Number.isNaN(reading) ? '-' : reading}\t${load1()}\t${result ? 0 : 1}\n`);
		if (!result) {
			if (++failures >= 3) {
				console.error('# three failed samples in a row');
				process.exit(4);
			}
			return null;
		}
		failures = 0;
		last = result;
		if (!(reading > limit)) return { ...result, noisy: false };
	}
	return { ...last!, noisy: true };
}
const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]!;
const load1 = () => {
	try {
		return readFileSync('/proc/loadavg', 'utf8').split(' ')[0]!;
	} catch {
		return '?';
	}
};
const wanted = (process.env.ARMS ?? 'int,fn:0,fn:2,fnc:0,fnc:2,all:0,all:2').split(',');
// GUEST_ENV is prefixed to every guest command (KATYBUG_PRIM=0 for the sha256 arms: the host kernel replaces the lifted function)
const guestEnv = process.env.GUEST_ENV ? `${process.env.GUEST_ENV} ` : '';
const mib = (n: number) => (n / 1048576).toFixed(0);
console.log(`node ${process.version}, V8 ${process.versions.v8}, flags [${process.execArgv.join(' ')}], scale ${scale}, ${rounds} rounds after the first run`);
console.log('| workload | arm | first run ms | later ms | median ms | spread | output md5 | load1 after each run | rss MiB after first run, after all |');
console.log('| --- | --- | --- | --- | --- | --- | --- | --- | --- |');
const arms: Arm[] = [];
const vms = new Map<string, ReturnType<typeof machine>>();
for (const spec of wanted) {
	const [name, form] = spec.split(':') as [string, string | undefined];
	if (name === 'binary') {
		arms.push({ label: 'binary', env: '' });
		continue;
	}
	if (!existsSync(join(dir, `katybug-${name}-${workload}.wasm`))) continue;
	if (!vms.has(name)) {
		const vm = machine(name);
		await vm.booted();
		await vm.run(setup);
		vms.set(name, vm);
	}
	arms.push({ label: spec, vm: vms.get(name)!, env: `${guestEnv}${form === undefined ? '' : `KATYBUG_REGS=${form} `}` });
}
const first = new Map<string, number>();
const md5 = new Map<string, string>();
const rssFirst = new Map<string, number>();
const dropped = new Set<string>();
for (const a of arms) {
	const t = await measure(a, 'first', `{ ${a.env}${workloads[workload]!}; } | $B/busybox md5sum`);
	if (!t) {
		dropped.add(a.label);
		continue;
	}
	first.set(a.label, t.ms);
	md5.set(a.label, /[0-9a-f]{32}/.exec(t.text)?.[0]?.slice(0, 8) ?? 'none');
	rssFirst.set(a.label, process.memoryUsage().rss);
}
const ms = new Map<string, number[]>(arms.map((a) => [a.label, []]));
const loads = new Map<string, string[]>(arms.map((a) => [a.label, []]));
let noisy = 0;
// PERF_CTL=<perf record --control fifo>: perf samples only the timed rounds (boot, setup and first runs stay out)
const perfCtl = (cmd: string) => process.env.PERF_CTL && appendFileSync(process.env.PERF_CTL, `${cmd}\n`);
perfCtl('enable');
for (let r = 0; r < rounds; r++) {
	for (const a of r % 2 ? [...arms].reverse() : arms) {
		if (dropped.has(a.label)) continue;
		const t = await measure(a, String(r + 1), `${a.env}${workloads[workload]!} > /dev/null`);
		if (!t) dropped.add(a.label);
		else if (t.noisy) noisy++;
		else {
			ms.get(a.label)!.push(t.ms);
			loads.get(a.label)!.push(load1());
		}
	}
}
perfCtl('disable');
for (const [label, xs] of ms) {
	if (!xs.length) continue;
	const med = median(xs);
	console.log(
		`| ${workload} | ${label} | ${first.get(label)!.toFixed(0)} | ${xs.map((x) => x.toFixed(0)).join(' ')} | ${med.toFixed(0)} | ${((100 * (Math.max(...xs) - Math.min(...xs))) / med).toFixed(1)}% | ${md5.get(label)} | ${loads.get(label)!.join(' ')} | ${mib(rssFirst.get(label)!)}, ${mib(process.memoryUsage().rss)} |`
	);
}
if (noisy || dropped.size) console.log(`# dropped samples: ${noisy} noisy after a retry; arms stopped: ${[...dropped].join(' ') || 'none'}`);
const heap = v8.getHeapStatistics();
console.log(`heap at the end: physical ${mib(heap.total_physical_size)} MiB, malloced ${mib(heap.malloced_memory)} MiB, external ${mib(heap.external_memory)} MiB`);
process.exit(0);
