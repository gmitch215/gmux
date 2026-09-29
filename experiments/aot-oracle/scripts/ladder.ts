import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { appendCpio } from '../../../scripts/wasm/cpio-append.ts';
import { Machine } from '../../../src/worker/machine/machine.ts';

/**
 * The representation ladder under V8: each arm's Katybug (katybug.wasm built with that rung's lifted
 * regions) runs a workload in a machine; the arms sit in machines of their own, and the timed runs
 * go round the arms, so drift lands on all of them. The native algorithm (F) is the same source built
 * for wasm32-linux, run in the same machine.
 *
 * `ladder.ts <bundle> <variant dir> <rounds> <workload,...> <arm,...> [scale]`; the bundle is a
 * katybug-profile/bench.ts one (vmlinux.wasm, busybox.wasm, manifest.json, initrd.cpio, bin/), the
 * variants `katybug-<arm>-<workload>.wasm` and, for F, `f-<workload>.wasm` (sha256, factor, sqlite)
 */
const [bundle = '', dir = '', roundsArg = '3', workloadArg = '', armArg = '', scaleArg = '1'] = process.argv.slice(2);
const rounds = Number(roundsArg);
const scale = Number(scaleArg);
const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const read = (path: string) => new Uint8Array(readFileSync(path));
const manifest = JSON.parse(readFileSync(join(bundle, 'manifest.json'), 'utf8'));

const workloads: Record<string, string> = {
	sha256: '$B/coreutils --coreutils-prog=sha256sum /tmp/in',
	factor: `$B/busybox-amd64 seq 1000000000000 ${1000000020000 + 20000 * (scale - 1)} | $B/coreutils --coreutils-prog=factor`,
	sqlite: `$B/sqlite3 :memory: 'with recursive c(x) as (select 1 union all select x+1 from c where x<${100000 * scale}) select count(*), sum(x*x) % 1000003 from c;'`
};
// the native algorithm, built for wasm32-linux: busybox.wasm's seq feeds factor
const native: Record<string, string> = {
	sha256: '/bin/f-sha256 /tmp/in',
	factor: `$B/busybox seq 1000000000000 ${1000000020000 + 20000 * (scale - 1)} | /bin/f-factor`,
	sqlite: `/bin/f-sqlite :memory: 'with recursive c(x) as (select 1 union all select x+1 from c where x<${100000 * scale}) select count(*), sum(x*x) % 1000003 from c;'`
};
const setup = `$B/busybox-amd64 seq 1 ${400000 * scale} > /tmp/in`;

function machine(name: string, workload: string) {
	const registry = new Map<string, WebAssembly.Module>([[manifest.busybox, new WebAssembly.Module(read(join(bundle, 'busybox.wasm')))]]);
	const files: string[] = [];
	if (name === 'F' || name === 'shipped') {
		// the kernel finds a program by the hash of its file; the host runs the instrumented build
		if (name === 'F') {
			const path = join(dir, `f-${workload}.wasm`);
			registry.set(sha256(read(path)), new WebAssembly.Module(read(path.replace(/\.wasm$/, '.inst.wasm'))));
			files.push(`/bin/f-${workload}=${path}`);
		}
		registry.set(manifest.katybug, new WebAssembly.Module(read(join(bundle, 'katybug.wasm'))));
	} else {
		const path = join(dir, `katybug-${name}-${workload}.wasm`);
		registry.set(sha256(read(path)), new WebAssembly.Module(read(path.replace(/\.wasm$/, '.inst.wasm'))));
		files.push(`/bin/katybug=${path}`);
	}
	const cpio = join(dir, `${name}-${workload}.cpio`);
	appendCpio(join(bundle, 'initrd.cpio'), cpio, files);
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

const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]!;
const arms = armArg.split(',').filter(Boolean);
console.log(`node ${process.version}, V8 ${process.versions.v8}, scale ${scale}, ${rounds} rounds after one warm run`);
console.log('| workload | arm | ms per run | median ms | spread | output md5 |');
console.log('| --- | --- | --- | --- | --- | --- |');
for (const w of workloadArg.split(',').filter(Boolean)) {
	const vms = new Map<string, ReturnType<typeof machine>>();
	const ms = new Map<string, number[]>();
	const md5 = new Map<string, string>();
	for (const a of arms) {
		if (a !== 'F' && a !== 'shipped' && !existsSync(join(dir, `katybug-${a}-${w}.wasm`))) continue;
		const vm = machine(a, w);
		await vm.booted();
		await vm.run(setup);
		const cmd = a === 'F' ? native[w]! : workloads[w]!;
		// one warm run that also hashes the output
		const { text } = await vm.run(`{ ${cmd}; } | $B/busybox md5sum`);
		md5.set(a, /[0-9a-f]{32}/.exec(text)?.[0]?.slice(0, 8) ?? 'none');
		vms.set(a, vm);
		ms.set(a, []);
	}
	for (let r = 0; r < rounds; r++)
		for (const [a, vm] of vms) ms.get(a)!.push((await vm.run(`${a === 'F' ? native[w]! : workloads[w]!} > /dev/null`)).ms);
	for (const [a, xs] of ms) {
		const med = median(xs);
		console.log(`| ${w} | ${a} | ${xs.map((x) => x.toFixed(0)).join(' ')} | ${med.toFixed(0)} | ${((100 * (Math.max(...xs) - Math.min(...xs))) / med).toFixed(1)}% | ${md5.get(a)} |`);
	}
}
process.exit(0);
