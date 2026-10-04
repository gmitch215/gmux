import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { appendCpio } from '../../../scripts/wasm/cpio-append.ts';
import { Machine } from '../../../src/worker/machine/machine.ts';

/**
 * Two Katybug builds of one tree under V8, one machine each: `off<layout>` and `on<layout>` (variants.sh builds
 * them, instrument.sh prepares them). Each round runs the workload on both, alternating which goes first, and
 * the output md5 of every arm is checked against the same command run natively on this host.
 *
 * `epoch-wasm.ts <bundle> <variant dir> <rounds> <workload,...> <layout,...> [scale] [arm,...]`; the variants are
 * `katybug-<arm><layout>.wasm` with a `.inst.wasm` each. The rows print in regs-table.ts's format.
 */
const [bundle = '', dir = '', roundsArg = '5', workloadArg = '', layoutArg = '0', scaleArg = '1', armArg = 'off,on'] = process.argv.slice(2);
if (!bundle || !dir || !workloadArg) {
	console.error('usage: epoch-wasm.ts <bundle> <variant dir> <rounds> <workload,...> <layout,...> [scale] [arm,...]');
	process.exit(2);
}
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

function machine(name: string) {
	const registry = new Map<string, WebAssembly.Module>([[manifest.busybox, new WebAssembly.Module(read(join(bundle, 'busybox.wasm')))]]);
	const path = join(dir, `katybug-${name}.wasm`);
	registry.set(sha256(read(path)), new WebAssembly.Module(read(path.replace(/\.wasm$/, '.inst.wasm'))));
	const cpio = join('/tmp', `epoch-${name}.cpio`);
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
		if (outcome !== 'until' || status !== '0') throw new Error(`${name}: ${cmd}: ${outcome}, status ${status}\n${output.slice(from).slice(-600)}`);
		return { ms, text: output.slice(from, output.indexOf(mark, from)) };
	};
	return { run, booted: () => m.run(() => output.includes('# '), sleep, 120_000) };
}

const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]!;
const load1 = () => {
	try {
		return readFileSync('/proc/loadavg', 'utf8').split(' ')[0]!;
	} catch {
		return '?';
	}
};
const nativeMd5 = (cmd: string) => {
	const out = execFileSync('sh', ['-c', `B=${join(bundle, 'bin')}; ${cmd.replaceAll('$B/busybox md5sum', 'md5sum')}`], { encoding: 'utf8' });
	return /[0-9a-f]{32}/.exec(out)?.[0]?.slice(0, 8) ?? 'none';
};
const arms = armArg.split(',');
console.log(`node ${process.version}, V8 ${process.versions.v8}, scale ${scale}, ${rounds} rounds after one warm run each`);
console.log('| workload | layout | arm | ms per run | median ms | spread | output md5 | load1 after each run |');
console.log('| --- | --- | --- | --- | --- | --- | --- | --- |');
for (const w of workloadArg.split(',').filter(Boolean)) {
	execFileSync('sh', ['-c', `B=${join(bundle, 'bin')}; ${setup}`]);
	for (const layout of layoutArg.split(',').filter(Boolean)) {
		const vms = new Map<string, ReturnType<typeof machine>>();
		for (const a of arms) {
			if (!existsSync(join(dir, `katybug-${a}${layout}.wasm`))) continue;
			const vm = machine(`${a}${layout}`);
			await vm.booted();
			await vm.run(setup);
			vms.set(a, vm);
		}
		const md5 = new Map<string, string>();
		for (const [a, vm] of vms) {
			const { text } = await vm.run(`{ ${workloads[w]!}; } | $B/busybox md5sum`);
			md5.set(a, /[0-9a-f]{32}/.exec(text)?.[0]?.slice(0, 8) ?? 'none');
			await vm.run(`${workloads[w]!} > /dev/null`);
		}
		const ms = new Map<string, number[]>([...vms.keys()].map((a) => [a, []]));
		const loads = new Map<string, string[]>([...vms.keys()].map((a) => [a, []]));
		for (let r = 0; r < rounds; r++) {
			const order = r % 2 ? [...vms.keys()].reverse() : [...vms.keys()];
			for (const a of order) {
				ms.get(a)!.push((await vms.get(a)!.run(`${workloads[w]!} > /dev/null`)).ms);
				loads.get(a)!.push(load1());
			}
		}
		for (const [a, xs] of ms) {
			const med = median(xs);
			console.log(`| ${w} | ${layout} | ${a} | ${xs.map((x) => x.toFixed(0)).join(' ')} | ${med.toFixed(0)} | ${((100 * (Math.max(...xs) - Math.min(...xs))) / med).toFixed(1)}% | ${md5.get(a)} | ${loads.get(a)!.join(' ')} |`);
		}
		console.log(`| ${w} | ${layout} | native | 0 | 0 | 0.0% | ${nativeMd5(`{ ${workloads[w]!}; } | $B/busybox md5sum`)} | - |`);
	}
}
process.exit(0);
