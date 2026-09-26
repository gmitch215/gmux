import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { Session } from 'node:inspector/promises';
import { join } from 'node:path';
import { Machine } from '../../../src/worker/machine/machine.ts';

/**
 * Katybug against native x86-64: the same static amd64 binaries run natively and through Katybug in a
 * machine on the same host, timed between output markers by the host clock, and a CPU profile of the
 * Katybug run bucketed by phase.
 *
 * `prepare <bundle> <katybug-profile.wasm> <static busybox>` (needs python3 and wabt) stages build/,
 * the transcript binaries and a profiling Katybug (`-DKB_PROFILE`) into a bundle;
 * `run <bundle> [rounds]` times each workload natively and in the machine (an x86-64 Linux host);
 * `profile <bundle>` samples the machine run of each workload (node --no-wasm-inlining)
 */
const root = new URL('../../../', import.meta.url).pathname;
const [mode, bundle = '', ...rest] = process.argv.slice(2);
const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

const workloads: Record<string, string> = {
	factor: '$B/busybox-amd64 seq 1000000000000 1000000020000 | $B/coreutils --coreutils-prog=factor > /dev/null',
	gzip: '$B/busybox-amd64 gzip -9 -c /tmp/in > /tmp/in.gz',
	bzip2: '$B/busybox-amd64 bzip2 -9 -c /tmp/in > /tmp/in.bz2',
	sqlite: `$B/sqlite3 :memory: 'with recursive c(x) as (select 1 union all select x+1 from c where x<100000) select count(*), sum(x*x) % 1000003 from c;' > /dev/null`,
	bash: `$B/bash -c 'i=0; s=0; while [ $i -lt 20000 ]; do s=$((s+i*i%7)); i=$((i+1)); done; echo $s' > /dev/null`,
	curl: '$B/curl -s file:///tmp/in -o /tmp/in.copy',
	sha256: '$B/coreutils --coreutils-prog=sha256sum /tmp/in > /dev/null'
};
const setup = '$B/busybox-amd64 seq 1 400000 > /tmp/in';

// #region prepare
if (mode === 'prepare') {
	const [profileWasm = '', busyboxStatic = ''] = rest;
	const build = join(root, 'build');
	mkdirSync(join(bundle, 'bin'), { recursive: true });
	for (const name of ['bash', 'coreutils', 'curl', 'sqlite3'])
		copyFileSync(join(build, 'katybug/transcript/ubin', name), join(bundle, 'bin', name));
	copyFileSync(busyboxStatic, join(bundle, 'bin/busybox-amd64'));
	for (const name of ['vmlinux.wasm', 'busybox.wasm', 'katybug.wasm', 'manifest.json'])
		copyFileSync(join(build, 'kernel', name), join(bundle, name));
	copyFileSync(profileWasm, join(bundle, 'katybug-profile.raw.wasm'));
	execFileSync(join(root, 'scripts/wasm/instrument.sh'), [profileWasm, join(bundle, 'katybug-profile.wasm')], {
		env: { ...process.env, GMUX_NAMES: '1' }
	});
	const files = ['bash', 'coreutils', 'curl', 'sqlite3', 'busybox-amd64'].map((n) => `/bin/${n}=${join(bundle, 'bin', n)}`);
	const cpio = (out: string, extra: string[]) =>
		execFileSync('python3', [join(root, 'scripts/wasm/cpio-append.py'), join(build, 'kernel/initramfs.bin'), out, ...files, ...extra]);
	cpio(join(bundle, 'initrd.cpio'), []);
	// the later entry replaces the build's katybug stub
	cpio(join(bundle, 'initrd-profile.cpio'), [`/bin/katybug=${profileWasm}`]);
	// each katybug function's source file, for the phase buckets
	const files2: Record<string, string> = {};
	const dir = join(root, 'src/gmux/katybug');
	// the interpreter's names win a clash with a decoder's static helper (a64.c's flags)
	const sources = readdirSync(dir)
		.filter((f) => f.endsWith('.c'))
		.sort((a, b) => Number(a === 'run.c') - Number(b === 'run.c'));
	for (const file of sources)
		for (const m of readFileSync(join(dir, file), 'utf8').matchAll(/^[A-Za-z_][\w \t*]*?\b(\w+)\(/gm))
			files2[m[1]!] = file === 'run.c' ? file : (files2[m[1]!] ?? file);
	writeFileSync(join(bundle, 'functions.json'), JSON.stringify(files2));
	console.log(`staged ${bundle}`);
	process.exit(0);
}
// #endregion

const read = (name: string) => new Uint8Array(readFileSync(join(bundle, name)));
const manifest = JSON.parse(readFileSync(join(bundle, 'manifest.json'), 'utf8'));
const profiling = mode === 'profile';

function machine() {
	const registry = new Map<string, WebAssembly.Module>([[manifest.busybox, new WebAssembly.Module(read('busybox.wasm'))]]);
	if (profiling) registry.set(sha256(read('katybug-profile.raw.wasm')), new WebAssembly.Module(read('katybug-profile.wasm')));
	else registry.set(manifest.katybug, new WebAssembly.Module(read('katybug.wasm')));
	let output = '';
	const m = new Machine({
		vmlinux: new WebAssembly.Module(read('vmlinux.wasm')),
		initrd: read(profiling ? 'initrd-profile.cpio' : 'initrd.cpio'),
		cmdline: 'maxcpus=3 root=/dev/ram0 rootfstype=ramfs init=/init console=hvc console=ttyS0',
		registry,
		maximumPages: 4096,
		sha256,
		sharedKernel: true,
		write: (text) => (output += text)
	});
	const sleep = (ms: number) => new Promise((r) => setTimeout(r, Math.min(ms, 5)));
	/** types a command and waits for its marker; the host's milliseconds from typing to the marker */
	const run = async (cmd: string, before?: () => Promise<void>) => {
		const mark = `@@${Math.random().toString(36).slice(2)}`;
		const from = output.length;
		await before?.();
		const t = performance.now();
		m.type(`B=/bin; ${cmd}; echo "${mark.slice(0, 2)}""${mark.slice(2)} $?"\n`);
		const outcome = await m.run(() => output.indexOf(mark, from) >= 0 && /\n/.test(output.slice(output.indexOf(mark, from))), sleep, 600_000);
		const ms = performance.now() - t;
		const status = output.slice(output.indexOf(mark, from) + mark.length).trim().split(/\s/)[0];
		if (outcome !== 'until' || status !== '0') throw new Error(`${cmd}: ${outcome}, status ${status}\n${output.slice(from).slice(-600)}`);
		return ms;
	};
	return { m, run, booted: () => m.run(() => output.includes('# '), sleep, 60_000) };
}

const native = (cmd: string) => {
	const t = performance.now();
	execFileSync('sh', ['-c', `B=${join(bundle, 'bin')}; ${cmd}`], { stdio: 'inherit' });
	return performance.now() - t;
};
const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]!;
const pick = (process.env.ONLY ?? '').split(',').filter(Boolean);
const names = Object.keys(workloads).filter((k) => !pick.length || pick.includes(k));

const vm = machine();
await vm.booted();
await vm.run(setup);
native(setup);

// #region run
if (mode === 'run') {
	const rounds = Number(rest[0] ?? 3);
	console.log('| workload | native ms | Katybug in gmux, ms | r |');
	console.log('| --- | --- | --- | --- |');
	for (const name of names) {
		const n: number[] = [];
		const g: number[] = [];
		for (let i = 0; i < rounds; i++) {
			n.push(native(workloads[name]!));
			g.push(await vm.run(workloads[name]!));
		}
		const span = (xs: number[]) => `${Math.min(...xs).toFixed(0)}-${Math.max(...xs).toFixed(0)}`;
		console.log(`| ${name} | ${span(n)} | ${span(g)} | ${(median(g) / median(n)).toFixed(0)} |`);
	}
}
// #endregion

// #region profile
if (profiling) {
	const functions: Record<string, string> = JSON.parse(readFileSync(join(bundle, 'functions.json'), 'utf8'));
	const run = new Set(['step', 'kb_run', 'muldiv', 'string', 'mask', 'sext', 'kb_put']);
	const flag = new Set(['flags', 'kb_cond', 'plan_flags', 'parity', 'cond_reads', 'flags_may', 'flags_must', 'transparent']);
	const phase = (name: string, url: string, katybugUrl: string | undefined) => {
		const file = functions[name];
		if (file === 'run.c')
			return run.has(name) ? 'dispatch and execute' : flag.has(name) ? 'flags' : name === 'block' ? 'block lookup' : name === 'load' || name === 'store' ? 'memory lookup' : 'dispatch and execute';
		if (file === 'x86.c' || file === 'a64.c') return 'decode';
		if (file === 'mem.c') return 'memory lookup';
		if (file === 'x87.c' || file === 'f80.c') return 'x87';
		if (file === 'sse.c') return 'SSE';
		if (file === 'sys.c' || file === 'net.c' || file === 'fork.c' || file === 'sig.c') return 'syscalls (Katybug)';
		if (file) return 'startup';
		if (url && url === katybugUrl) return "Katybug's libc";
		if (url.startsWith('wasm://')) return 'kernel and other wasm';
		if (name === '(idle)' || name === '(program)' || name === '(garbage collector)') return name;
		return 'host JS';
	};
	const session = new Session();
	session.connect();
	await session.post('Profiler.enable');
	await session.post('Profiler.setSamplingInterval', { interval: 100 });
	const phases = ['decode', 'dispatch and execute', 'flags', 'memory lookup', 'block lookup', 'x87', 'SSE', 'syscalls (Katybug)', "Katybug's libc", 'kernel and other wasm', 'host JS', 'startup'];
	console.log(`| workload | samples | ${phases.join(' | ')} |`);
	console.log(`| --- | --- | ${phases.map(() => '---').join(' | ')} |`);
	for (const name of names) {
		await vm.run(workloads[name]!, () => session.post('Profiler.start'));
		const { profile } = await session.post('Profiler.stop');
		const byId = new Map(profile.nodes.map((node) => [node.id, node]));
		const clean = (fn: string) => fn.replace(/^\$/, '');
		const katybugUrl = profile.nodes.find((node) => functions[clean(node.callFrame.functionName)] && node.callFrame.url.startsWith('wasm://'))?.callFrame.url;
		const counts: Record<string, number> = {};
		for (const id of profile.samples ?? []) {
			const frame = byId.get(id)!.callFrame;
			const p = phase(clean(frame.functionName), frame.url, katybugUrl);
			counts[p] = (counts[p] ?? 0) + 1;
		}
		const total = Object.entries(counts).filter(([k]) => !k.startsWith('(')).reduce((a, [, v]) => a + v, 0);
		console.log(`| ${name} | ${total} | ${phases.map((p) => `${(((counts[p] ?? 0) * 100) / total).toFixed(1)}%`).join(' | ')} |`);
	}
}
// #endregion
process.exit(0);
