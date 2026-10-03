import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
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
 * (arm:form), the variants are `katybug-<arm>-<workload>.wasm` with their `.inst.wasm`
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
	bzip2: '$B/busybox-amd64 bzip2 -9 -c /tmp/in'
};
const setup = `$B/busybox-amd64 seq 1 ${400000 * scale} > /tmp/in`;

function machine(name: string) {
	const registry = new Map<string, WebAssembly.Module>([[manifest.busybox, new WebAssembly.Module(read(join(bundle, 'busybox.wasm')))]]);
	const path = join(dir, `katybug-${name}-${workload}.wasm`);
	registry.set(sha256(read(path)), new WebAssembly.Module(read(path.replace(/\.wasm$/, '.inst.wasm'))));
	const cpio = join(dir, `${name}-${workload}.cpio`);
	appendCpio(join(bundle, 'initrd.cpio'), cpio, [`/bin/katybug=${path}`]);
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
	vm: ReturnType<typeof machine>;
	env: string;
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
const mib = (n: number) => (n / 1048576).toFixed(0);
console.log(`node ${process.version}, V8 ${process.versions.v8}, flags [${process.execArgv.join(' ')}], scale ${scale}, ${rounds} rounds after the first run`);
console.log('| workload | arm | first run ms | later ms | median ms | spread | output md5 | load1 after each run | rss MiB after first run, after all |');
console.log('| --- | --- | --- | --- | --- | --- | --- | --- | --- |');
const arms: Arm[] = [];
const vms = new Map<string, ReturnType<typeof machine>>();
for (const spec of wanted) {
	const [name, form] = spec.split(':') as [string, string | undefined];
	if (!existsSync(join(dir, `katybug-${name}-${workload}.wasm`))) continue;
	if (!vms.has(name)) {
		const vm = machine(name);
		await vm.booted();
		await vm.run(setup);
		vms.set(name, vm);
	}
	arms.push({ label: spec, vm: vms.get(name)!, env: form === undefined ? '' : `KATYBUG_REGS=${form} ` });
}
const first = new Map<string, number>();
const md5 = new Map<string, string>();
const rssFirst = new Map<string, number>();
for (const a of arms) {
	const t = await a.vm.run(`{ ${a.env}${workloads[workload]!}; } | $B/busybox md5sum`);
	first.set(a.label, t.ms);
	md5.set(a.label, /[0-9a-f]{32}/.exec(t.text)?.[0]?.slice(0, 8) ?? 'none');
	rssFirst.set(a.label, process.memoryUsage().rss);
}
const ms = new Map<string, number[]>(arms.map((a) => [a.label, []]));
const loads = new Map<string, string[]>(arms.map((a) => [a.label, []]));
for (let r = 0; r < rounds; r++) {
	for (const a of r % 2 ? [...arms].reverse() : arms) {
		ms.get(a.label)!.push((await a.vm.run(`${a.env}${workloads[workload]!} > /dev/null`)).ms);
		loads.get(a.label)!.push(load1());
	}
}
for (const [label, xs] of ms) {
	const med = median(xs);
	console.log(
		`| ${workload} | ${label} | ${first.get(label)!.toFixed(0)} | ${xs.map((x) => x.toFixed(0)).join(' ')} | ${med.toFixed(0)} | ${((100 * (Math.max(...xs) - Math.min(...xs))) / med).toFixed(1)}% | ${md5.get(label)} | ${loads.get(label)!.join(' ')} | ${mib(rssFirst.get(label)!)}, ${mib(process.memoryUsage().rss)} |`
	);
}
const heap = v8.getHeapStatistics();
console.log(`heap at the end: physical ${mib(heap.total_physical_size)} MiB, malloced ${mib(heap.malloced_memory)} MiB, external ${mib(heap.external_memory)} MiB`);
process.exit(0);
