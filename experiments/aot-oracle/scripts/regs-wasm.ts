import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { appendCpio } from '../../../scripts/wasm/cpio-append.ts';
import { Machine } from '../../../src/worker/machine/machine.ts';

/**
 * The precise form of lifted regions under V8: one katybug.wasm per workload and link order holds both
 * forms (lift.ts --regs --slots), and one machine runs the workload under KATYBUG_REGS=0, 1 and 2, alternating
 * which goes first each round so drift lands on both. `old<layout>` builds (regions lifted without
 * --regs) sit in machines of their own, as the control for what the second form's presence costs.
 *
 * `regs-wasm.ts <bundle> <variant dir> <rounds> <workload,...> <layout,...> [scale]`; the variants are
 * `katybug-regs<layout>-<workload>.wasm` and `katybug-old<layout>-<workload>.wasm`, each with its
 * `.inst.wasm` (ladder-wasm.sh builds and instruments them)
 */
const [bundle = '', dir = '', roundsArg = '3', workloadArg = '', layoutArg = '0', scaleArg = '1'] = process.argv.slice(2);
const rounds = Number(roundsArg);
const scale = Number(scaleArg);
const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const read = (path: string) => new Uint8Array(readFileSync(path));
const manifest = JSON.parse(readFileSync(join(bundle, 'manifest.json'), 'utf8'));

const workloads: Record<string, string> = {
	sha256: '$B/coreutils --coreutils-prog=sha256sum /tmp/in',
	factor: `$B/busybox-amd64 seq 1000000000000 ${1000000020000 + 20000 * (scale - 1)} | $B/coreutils --coreutils-prog=factor`,
	sqlite: `$B/sqlite3 :memory: 'with recursive c(x) as (select 1 union all select x+1 from c where x<${100000 * scale}) select count(*), sum(x*x) % 1000003 from c;'`,
	gzip: '$B/busybox-amd64 gzip -9 -c /tmp/in',
	bzip2: '$B/busybox-amd64 bzip2 -9 -c /tmp/in',
	bash: `$B/bash -c 'i=0; s=0; while [ $i -lt ${20000 * scale} ]; do s=$((s+i*i%7)); i=$((i+1)); done; echo $s'`
};
const setup = `$B/busybox-amd64 seq 1 ${400000 * scale} > /tmp/in`;

function machine(name: string, workload: string) {
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
console.log(`node ${process.version}, V8 ${process.versions.v8}, scale ${scale}, ${rounds} rounds after one warm run each`);
console.log('| workload | layout | arm | ms per run | median ms | spread | output md5 | load1 after each run |');
console.log('| --- | --- | --- | --- | --- | --- | --- | --- |');
for (const w of workloadArg.split(',').filter(Boolean)) {
	for (const layout of layoutArg.split(',').filter(Boolean)) {
		const arms: Arm[] = [];
		if (existsSync(join(dir, `katybug-regs${layout}-${w}.wasm`))) {
			const vm = machine(`regs${layout}`, w);
			await vm.booted();
			await vm.run(setup);
			arms.push({ label: 'regs=0', vm, env: 'KATYBUG_REGS=0 ' }, { label: 'regs=1', vm, env: 'KATYBUG_REGS=1 ' }, { label: 'regs=2', vm, env: 'KATYBUG_REGS=2 ' });
		}
		if (existsSync(join(dir, `katybug-old${layout}-${w}.wasm`))) {
			const vm = machine(`old${layout}`, w);
			await vm.booted();
			await vm.run(setup);
			arms.push({ label: 'old', vm, env: '' });
		}
		const md5 = new Map<string, string>();
		for (const a of arms) {
			const { text } = await a.vm.run(`{ ${a.env}${workloads[w]!}; } | $B/busybox md5sum`);
			md5.set(a.label, /[0-9a-f]{32}/.exec(text)?.[0]?.slice(0, 8) ?? 'none');
		}
		const ms = new Map<string, number[]>(arms.map((a) => [a.label, []]));
		const loads = new Map<string, string[]>(arms.map((a) => [a.label, []]));
		for (let r = 0; r < rounds; r++) {
			const order = r % 2 ? [...arms].reverse() : arms;
			for (const a of order) {
				ms.get(a.label)!.push((await a.vm.run(`${a.env}${workloads[w]!} > /dev/null`)).ms);
				loads.get(a.label)!.push(load1());
			}
		}
		for (const [label, xs] of ms) {
			const med = median(xs);
			console.log(`| ${w} | ${layout} | ${label} | ${xs.map((x) => x.toFixed(0)).join(' ')} | ${med.toFixed(0)} | ${((100 * (Math.max(...xs) - Math.min(...xs))) / med).toFixed(1)}% | ${md5.get(label)} | ${loads.get(label)!.join(' ')} |`);
		}
	}
}
process.exit(0);
