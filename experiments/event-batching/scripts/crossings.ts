import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { Session } from 'node:inspector/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { appendCpio } from '../../../scripts/wasm/cpio-append.ts';
import { hostRuntime } from '../../../scripts/wasm/router-modules.ts';
import { Machine, type SyscallCall } from '../../../src/worker/machine/machine.ts';

/**
 * Host crossings by import for five workloads run inside a machine under Node: `seq` (seq 1 200000
 * to the console), `cat` (a 1 MiB file to the console), `idle` (60 s of idle machine time, then one
 * typed command), `fork` (300 fork+exec with output to /dev/null) and `forkout` (the same with output
 * to the console).
 *   MODE=count (default): one run; the stats delta, crossings per 100 KiB of console output and per
 *     second, and write(2) calls to the console from a second counted run
 *   MODE=time: wall and process CPU of the workload alone, no counting
 *   MODE=profile: samples of the workload alone; the share inside the console put import
 * GMUX_BUILD picks the build (default build/; its kernel/ holds the kernel), RING=off turns the
 * console ring off in the machine, RING=on forces it on, unset takes the machine's default. WORK
 * names a directory that keeps the generated initramfs between runs (default: a new temporary one).
 * `node --no-warnings --experimental-strip-types experiments/event-batching/scripts/crossings.ts <workload>`
 */
const root = new URL('../../../', import.meta.url).pathname;
const [workload] = process.argv.slice(2);
const WORKLOADS = ['seq', 'cat', 'idle', 'fork', 'forkout'];
if (!WORKLOADS.includes(workload ?? ''))
	throw new Error(`usage: crossings.ts <${WORKLOADS.join('|')}>`);
const mode = process.env.MODE ?? 'count';
const build = process.env.GMUX_BUILD ?? join(root, 'build');
const kernel = join(build, 'kernel');
const work = process.env.WORK ?? mkdtempSync(join(tmpdir(), 'gmux-batching-'));
mkdirSync(work, { recursive: true });
const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const manifest = JSON.parse(readFileSync(join(kernel, 'manifest.json'), 'utf8'));
const ring = process.env.RING === 'off' ? false : process.env.RING === 'on' ? true : undefined;
const N = Number(process.env.N ?? 300);

const scripts: Record<string, string> = {
	seq: 'seq 1 200000\n',
	cat: 'cat /work/big.txt\n',
	fork: `i=0\nwhile [ $i -lt ${N} ]; do\n\ti=$((i+1))\n\t/bin/echo line-$i > /dev/null\ndone\n`,
	forkout: `i=0\nwhile [ $i -lt ${N} ]; do\n\ti=$((i+1))\n\t/bin/echo line-$i\ndone\n`,
	idle: ''
};
const cpio = join(work, `initramfs-${workload}-${N}.cpio`);
if (!existsSync(cpio)) {
	writeFileSync(join(work, `w-${workload}-${N}.sh`), scripts[workload!]!);
	// 1 MiB of text lines, the same bytes every run
	const lines: string[] = [];
	for (let n = 0, size = 0; size < 1 << 20; n++) {
		const line = `row ${n} ${(n * 2654435761 >>> 0).toString(16)} the quick brown fox\n`;
		lines.push(line);
		size += line.length;
	}
	writeFileSync(join(work, 'big.txt'), lines.join('').slice(0, 1 << 20));
	appendCpio(join(kernel, 'initramfs.bin'), cpio, [
		`/work/w.sh=${join(work, `w-${workload}-${N}.sh`)}`,
		`/work/big.txt=${join(work, 'big.txt')}`
	]);
}

const registry = new Map<string, WebAssembly.Module>([
	[manifest.busybox, new WebAssembly.Module(readFileSync(join(kernel, 'busybox.wasm')))]
]);
const vmlinux = new WebAssembly.Module(readFileSync(join(kernel, 'vmlinux.wasm')));
const initrd = new Uint8Array(readFileSync(cpio));
const runtime = hostRuntime();

// the idle workload runs on a clock that moves only when the machine sleeps
const clock = { ns: 0n };
async function boot(count: boolean | ((call: SyscallCall) => void)) {
	let output = '';
	const fake = workload === 'idle';
	const machine = new Machine({
		vmlinux,
		initrd,
		cmdline: 'maxcpus=3 root=/dev/ram0 rootfstype=ramfs init=/init console=hvc console=ttyS0',
		registry,
		maximumPages: 4096,
		sha256,
		sharedKernel: true,
		...(fake ? { now: () => clock.ns } : {}),
		...(ring === undefined ? {} : { consoleRing: ring }),
		...(count ? { runtime, countSyscalls: count } : {}),
		write: (text: string) => (output += text)
	});
	const sleep = fake
		? async (ms: number) => void (clock.ns += BigInt(Math.max(ms, 1)) * 1_000_000n)
		: (ms: number) => new Promise<void>((r) => setTimeout(r, Math.min(ms, 5)));
	const run = async (until: () => boolean, limit = 1_800_000) => {
		const t = Date.now();
		await machine.run(() => until() || Date.now() - t > limit, sleep, 100_000_000);
		if (!until()) throw new Error(`stuck: ${output.slice(-400)}`);
	};
	await run(() => output.includes('# '), 120_000);
	return { machine, run, output: () => output, clockNs: () => clock.ns };
}

type Boot = Awaited<ReturnType<typeof boot>>;
type Stats = Record<string, number>;
const numbers = (m: Machine): Stats =>
	Object.fromEntries(
		Object.entries(m.stats).filter((e): e is [string, number] => typeof e[1] === 'number')
	);
const subtract = (a: Stats, b: Stats): Stats =>
	Object.fromEntries(Object.entries(a).map(([k, v]) => [k, v - (b[k] ?? 0)]));

/** the workload on a booted machine: the console output it produced, and the machine seconds it took */
async function drive(m: Boot) {
	const start = m.output().length;
	const at = m.clockNs();
	if (workload === 'idle') {
		const settle = m.clockNs() + 5_000_000_000n;
		await m.run(() => m.clockNs() >= settle);
		const idleEnd = m.clockNs() + 60_000_000_000n;
		await m.run(() => m.clockNs() >= idleEnd);
		const typed = m.output().length;
		m.machine.type('echo typed-$((6*7))\n');
		await m.run(() => m.output().slice(typed).includes('typed-42\r\n'));
		return { text: through(m.output().slice(start), 'typed-42\r\n'), machineSeconds: Number(m.clockNs() - at) / 1e9 };
	}
	// one line, so the typed echo cannot interleave with the command's output
	m.machine.type('{ sh /work/w.sh; } < /dev/null; echo "== done-$((6*7))"\n');
	await m.run(() => m.output().slice(start).includes('== done-42\r\n'));
	return { text: through(m.output().slice(start), '== done-42\r\n'), machineSeconds: 0 };
}

// the prompt after the marker is written in the step that shows the marker or the next, by timing
const through = (text: string, marker: string) => text.slice(0, text.indexOf(marker) + marker.length);

const clean = (text: string) => text.replace(/\r/g, '');
const per = (value: number, bytes: number, seconds: number) => ({
	count: value,
	per100KiB: bytes ? +((value * 102400) / bytes).toFixed(2) : null,
	perSecond: +(value / seconds).toFixed(1)
});

if (mode === 'count') {
	const m = await boot(false);
	const before = numbers(m.machine);
	const t0 = performance.now();
	const run = await drive(m);
	const wallS = (performance.now() - t0) / 1000;
	const d = subtract(numbers(m.machine), before);
	const bytes = Buffer.byteLength(run.text);
	const seconds = run.machineSeconds || wallS;
	const crossings = [
		'consolePuts',
		'consoleDrains',
		'pumpSteps',
		'hostSleeps',
		'userTouches',
		'userCopies',
		'userStrings',
		'idles',
		'switches',
		'relaxes',
		'fuelYields',
		'consoleReads',
		'consoleRaises'
	];
	// write(2) calls to the console from a counted run of the same workload
	let writes = 0;
	let writeBytes = 0;
	const counted = await boot((c) => {
		// generic arm64 numbers: write 64, writev 66; fd 1 is the tty only before a redirect
		if (c.ret === null || (c.nr !== 64 && c.nr !== 66) || c.args[0] !== 1) return;
		writes++;
		writeBytes += c.nr === 64 ? c.ret : 0;
	});
	writes = 0;
	writeBytes = 0;
	const countedRun = await drive(counted);
	console.log(
		JSON.stringify({
			workload,
			ring: ring ?? 'default',
			consoleBytes: bytes,
			outputSha: sha256(new TextEncoder().encode(clean(run.text))),
			wallS: +wallS.toFixed(3),
			machineSeconds: run.machineSeconds,
			perSecondOf: run.machineSeconds ? 'machine' : 'wall',
			crossings: Object.fromEntries(crossings.map((k) => [k, per(d[k] ?? 0, bytes, seconds)])),
			consolePutBytes: d.consolePutBytes,
			bytesPerPut: d.consolePuts ? +(d.consolePutBytes / d.consolePuts).toFixed(2) : null,
			// write calls to the host: the put import's, plus the ring's drains
			writeCalls: per((d.consolePuts ?? 0) + (d.consoleDrains ?? 0), bytes, seconds),
			consoleDrainBytes: d.consoleDrainBytes,
			consoleDrainPeak: m.machine.stats.consoleDrainPeak,
			userCopyBytes: d.userCopyBytes,
			stdoutWrites: writes,
			stdoutWriteBytes: writeBytes,
			putsPerStdoutWrite: writes ? +(d.consolePuts / writes).toFixed(3) : null,
			countedRunSha: sha256(new TextEncoder().encode(clean(countedRun.text))),
			crashed: String(m.machine.crashed)
		})
	);
	process.exit(0);
}

if (mode === 'time') {
	const m = await boot(false);
	const cpu0 = process.cpuUsage();
	const t0 = performance.now();
	const run = await drive(m);
	const wallMs = performance.now() - t0;
	const cpu = process.cpuUsage(cpu0);
	console.log(
		JSON.stringify({
			workload,
			ring: ring ?? 'default',
			wallMs: +wallMs.toFixed(1),
			cpuMs: +((cpu.user + cpu.system) / 1000).toFixed(1),
			outputSha: sha256(new TextEncoder().encode(clean(run.text))),
			consolePuts: m.machine.stats.consolePuts,
			crashed: String(m.machine.crashed)
		})
	);
	process.exit(0);
}

// profile: samples inside the console put import (its own frame and everything under it), of the busy ones
const m = await boot(false);
const session = new Session();
session.connect();
await session.post('Profiler.enable');
await session.post('Profiler.setSamplingInterval', { interval: 100 });
await session.post('Profiler.start');
const t0 = performance.now();
const run = await drive(m);
const wallMs = performance.now() - t0;
const { profile } = await session.post('Profiler.stop');
type Node = { id: number; callFrame: { functionName: string; url: string }; children?: number[] };
const nodes = new Map<number, Node>(profile.nodes.map((x: Node) => [x.id, x]));
// V8 does not hang the JS frames of an import under the wasm frame that called it, so the console's
// share is its own leaf frames: the import, the decoder, the harness write and the drain
const CONSOLE_LEAVES = ['wasm_driver_hvc_put', 'drainConsole', 'decodeUTF8', 'decode', 'write'];
let total = 0;
let idle = 0;
let inPut = 0;
let toJs = 0;
const hostLeaf = new Map<string, number>();
for (const id of profile.samples ?? []) {
	total++;
	const f = nodes.get(id)!.callFrame;
	if (f.functionName === '(idle)') {
		idle++;
		continue;
	}
	const name = f.functionName || '(anon)';
	if (!f.url.startsWith('wasm://')) hostLeaf.set(name, (hostLeaf.get(name) ?? 0) + 1);
	if (CONSOLE_LEAVES.includes(name)) inPut++;
	if (name === 'wasm-to-js') toJs++;
}
const busy = total - idle;
console.log(
	JSON.stringify({
		workload,
		ring: ring ?? 'default',
		wallMs: Math.round(wallMs),
		samples: total,
		busySamples: busy,
		putSamples: inPut,
		putShareOfBusy: +((100 * inPut) / busy).toFixed(2),
		wasmToJsSamples: toJs,
		topHostLeaves: [...hostLeaf].sort((a, b) => b[1] - a[1]).slice(0, 12),
		consolePuts: m.machine.stats.consolePuts,
		outputSha: sha256(new TextEncoder().encode(clean(run.text))),
		crashed: String(m.machine.crashed)
	})
);
process.exit(0);
