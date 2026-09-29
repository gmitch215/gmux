import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { appendCpio } from '../../../scripts/wasm/cpio-append.ts';
import { Machine } from '../../../src/worker/machine/machine.ts';

/**
 * Katybug's trace length and flag handling as a guest of the wasm kernel under V8: every arm's
 * instrumented katybug.wasm sits in one initramfs, and each workload runs through every arm and link
 * order inside one machine (a fresh machine per arch and workload), arms interleaved, timed by the host
 * clock from typing the command to its marker. A sample holds LOCK (a directory) while it runs and is
 * marked dirty when its core and SMT sibling were busy with something other than this process.
 * `node --no-warnings --experimental-strip-types run.ts <bundle> <out.tsv>` under `taskset -c <cores>`;
 * the bundle holds kernel/{vmlinux.wasm,busybox.wasm,initramfs.bin,manifest.json},
 * kb/<build>-<layout>{,.raw}.wasm and guests/<arch>/{sqlite3,bash,coreutils,busybox}.
 * CORES (comma list, required) is where the process is pinned; ARCHES, ONLY (workloads), ARMS,
 * LAYOUTS=3, ROUNDS=2, SCALE=1, LOCK, NATIVE_RUNS=15 (x86_64 only, when the host is x86_64)
 */
const [bundle, outFile] = process.argv.slice(2);
const cores = (process.env.CORES ?? '').split(',').filter(Boolean).map(Number);
if (!bundle || !outFile || !cores.length) {
	console.error('usage: CORES=<a,b> run.ts <bundle> <out.tsv>');
	process.exit(2);
}
const layouts = Number(process.env.LAYOUTS ?? 3);
const rounds = Number(process.env.ROUNDS ?? 2);
const scale = Number(process.env.SCALE ?? 1);
const lock = process.env.LOCK;
const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const read = (name: string) => new Uint8Array(readFileSync(join(bundle, name)));

const allArms = [
	{ name: 'eager', build: 'lazy2', env: 'KATYBUG_PLAN=0' },
	{ name: 'dead', build: 'lazy0', env: '' },
	{ name: 'expr', build: 'lazy1', env: '' },
	{ name: 'fused', build: 'lazy2', env: '' },
	{ name: 'notrace', build: 'notrace', env: '' },
	{ name: 't1', build: 'lazy2', env: 'KATYBUG_SEGMENTS=1' },
	{ name: 't4', build: 'lazy2', env: 'KATYBUG_SEGMENTS=4' },
	{ name: 't8', build: 'lazy2', env: 'KATYBUG_SEGMENTS=8' },
	{ name: 't16', build: 'lazy2', env: 'KATYBUG_SEGMENTS=16' },
	{ name: 't64', build: 'lazy2', env: 'KATYBUG_SEGMENTS=64' }
];
const want = (process.env.ARMS ?? '').split(',').filter(Boolean);
const arms = allArms.filter((a) => !want.length || want.includes(a.name));
const builds = [...new Set(arms.map((a) => a.build))];

const n = (base: number) => Math.max(1, Math.round(base * scale));
// $K is katybug, the guests are in /g
const workloads: Record<string, string> = {
	null: `$K /g/busybox true`,
	sqlite: `$K /g/sqlite3 :memory: 'with recursive c(x) as (select 1 union all select x+1 from c where x<${n(200000)}) select count(*), sum(x*x) % 1000003 from c;'`,
	bash: `$K /g/bash -c 'i=0; s=0; while [ $i -lt ${n(8000)} ]; do s=$((s+i*i%7)); i=$((i+1)); done; echo $s'`,
	awk: `$K /g/busybox awk '{s += $1 * 3} END {print s}' /tmp/in`,
	sort: `$K /g/coreutils --coreutils-prog=sort -r /tmp/in`
};
// input lines a workload reads from /tmp/in
const inputLines: Record<string, number> = { awk: n(60000), sort: n(500000) };
const only = (process.env.ONLY ?? '').split(',').filter(Boolean);
const names = Object.keys(workloads).filter((k) => !only.length || only.includes(k));

const held = { on: false };
const takeLock = async () => {
	if (!lock) return;
	for (;;) {
		try {
			mkdirSync(lock);
			held.on = true;
			return;
		} catch {
			await new Promise((r) => setTimeout(r, 20_000));
		}
	}
};
const freeLock = () => {
	if (!lock || !held.on) return;
	rmdirSync(lock);
	held.on = false;
};
process.on('exit', freeLock);

// busy ms of the pinned cores and of their SMT siblings, from /proc/stat
const watched = new Set<number>(cores);
for (const c of cores) {
	const s = readFileSync(`/sys/devices/system/cpu/cpu${c}/topology/thread_siblings_list`, 'utf8').trim();
	for (const part of s.split(',')) {
		const [a, b = a] = part.split('-').map(Number);
		for (let i = a!; i <= b!; i++) watched.add(i);
	}
}
const busy = () => {
	let total = 0;
	for (const line of readFileSync('/proc/stat', 'utf8').split('\n')) {
		const m = /^cpu(\d+) (.*)/.exec(line);
		if (!m || !watched.has(Number(m[1]))) continue;
		const [user, nice, system, , , irq, softirq, steal] = m[2]!.split(' ').map(Number);
		total += (user! + nice! + system! + irq! + softirq! + steal!) * 10;
	}
	return total;
};
const load = () => readFileSync('/proc/loadavg', 'utf8').split(' ')[0]!;
const cpu = (u: NodeJS.CpuUsage) => (u.user + u.system) / 1000;

const manifest = JSON.parse(readFileSync(join(bundle, 'kernel/manifest.json'), 'utf8'));
const scratch = mkdtempSync(join(tmpdir(), 'gmux-settings-'));
const files: string[] = [];
const registry = new Map<string, WebAssembly.Module>([[manifest.busybox, new WebAssembly.Module(read('kernel/busybox.wasm'))]]);
for (const b of builds)
	for (let l = 0; l < layouts; l++) {
		files.push(`/bin/kb-${b}-${l}=${join(bundle, `kb/${b}-${l}.raw.wasm`)}`);
		registry.set(sha256(read(`kb/${b}-${l}.raw.wasm`)), new WebAssembly.Module(read(`kb/${b}-${l}.wasm`)));
	}

const boot = async (arch: string) => {
	const initrd = join(scratch, `${arch}.cpio`);
	appendCpio(
		join(bundle, 'kernel/initramfs.bin'),
		initrd,
		[
			...files,
			...['sqlite3', 'bash', 'coreutils', 'busybox'].map((g) => `/g/${g}=${join(bundle, 'guests', arch, g)}`)
		]
	);
	let output = '';
	const m = new Machine({
		vmlinux: new WebAssembly.Module(read('kernel/vmlinux.wasm')),
		initrd: new Uint8Array(readFileSync(initrd)),
		cmdline: 'maxcpus=3 root=/dev/ram0 rootfstype=ramfs init=/init console=hvc console=ttyS0',
		registry,
		maximumPages: 4096,
		sha256,
		sharedKernel: true,
		write: (text) => (output += text)
	});
	const sleep = (ms: number) => new Promise((r) => setTimeout(r, Math.min(ms, 5)));
	await m.run(() => output.includes('# '), sleep, 60_000);
	// the text a command printed, and the host's wall and cpu ms from typing to its marker
	const run = async (cmd: string) => {
		const mark = `@@${Math.random().toString(36).slice(2)}`;
		const from = output.length;
		const c0 = process.cpuUsage();
		const t0 = performance.now();
		m.type(`${cmd}; echo "${mark.slice(0, 2)}""${mark.slice(2)} $?"\n`);
		const outcome = await m.run(
			() => output.indexOf(mark, from) >= 0 && /\n/.test(output.slice(output.indexOf(mark, from))),
			sleep,
			900_000
		);
		const wall = performance.now() - t0;
		const cpuMs = cpu(process.cpuUsage(c0));
		const at = output.indexOf(mark, from);
		const status = output.slice(at + mark.length).trim().split(/\s/)[0];
		if (outcome !== 'until' || status !== '0') throw new Error(`${cmd}: ${outcome}, status ${status}\n${output.slice(from).slice(-600)}`);
		return { text: output.slice(from, at), wall, cpuMs };
	};
	return { run };
};

const nativeRuns = Number(process.env.NATIVE_RUNS ?? 15);
const native = async (arch: string, name: string, input: string) => {
	if (arch !== process.arch.replace('x64', 'x86_64') || name === 'null') return '';
	const cmd = workloads[name]!
		.replaceAll('$K /g/', `${join(bundle, 'guests', arch)}/`)
		.replace('/tmp/in', input);
	let best = Infinity;
	for (let i = 0; i < nativeRuns; i++) {
		await takeLock();
		const t0 = performance.now();
		execFileSync('sh', ['-c', `${cmd} > /dev/null`], { stdio: 'ignore' });
		best = Math.min(best, performance.now() - t0);
		freeLock();
	}
	return best.toFixed(3);
};

writeFileSync(outFile, 'arch\tworkload\tarm\tlayout\tround\twall_ms\tcpu_ms\tother_ms\tload\tmd5\tnative_ms\n');
console.log(`node ${process.version}, V8 ${process.versions.v8}, cores ${[...watched].join(',')}`);
for (const arch of (process.env.ARCHES ?? 'x86_64,aarch64').split(',')) {
	for (const name of names) {
		const vm = await boot(arch);
		const lines = inputLines[name] ?? 1;
		await vm.run(`seq 1 ${lines} > /tmp/in`);
		const inputFile = join(scratch, 'in');
		writeFileSync(inputFile, Array.from({ length: lines }, (_, i) => i + 1).join('\n') + '\n');
		const nativeMs = await native(arch, name, inputFile);
		const cmdOf = (a: (typeof arms)[number], l: number) =>
			`${a.env} ${workloads[name]!.replace('$K', `/bin/kb-${a.build}-${l}`)} > /tmp/o`;
		let ref = '';
		for (let r = 0; r < rounds; r++)
			for (let l = 0; l < layouts; l++)
				for (const a of arms) {
					await takeLock();
					const b0 = busy();
					let s;
					try {
						s = await vm.run(cmdOf(a, l));
					} finally {
						freeLock();
					}
					const other = busy() - b0 - s.cpuMs;
					const md5 = (await vm.run('md5sum /tmp/o')).text.trim().split(/\s/).find((w) => /^[0-9a-f]{32}$/.test(w)) ?? '';
					if (!ref) ref = md5;
					if (md5 !== ref) console.error(`# ${arch} ${name}: ${a.name} layout ${l} output differs (${md5} vs ${ref})`);
					appendFileSync(outFile, `${arch}\t${name}\t${a.name}\t${l}\t${r}\t${s.wall.toFixed(1)}\t${s.cpuMs.toFixed(1)}\t${other.toFixed(1)}\t${load()}\t${md5}\t${nativeMs}\n`);
				}
		console.log(`${arch} ${name} done`);
	}
}
process.exit(0);
