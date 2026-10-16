import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { loadavg } from 'node:os';
import { join } from 'node:path';
import { appendCpio } from '../../../scripts/wasm/cpio-append.ts';
import { Machine, type MachineOptions } from '../../../src/worker/machine/machine.ts';

/**
 * Katybug's block cache with lifted regions inside a machine under V8: gzip -9 of `seq 1 400000` three times in one
 * machine with KATYBUG_CACHE=/tmp/kbc (run 1 cold, run 2 from the file run 1 left), then a third run checkpointed
 * after CUT ms, restored into a fresh machine of the same modules and finished there, then a fourth run in the
 * restored machine. Per run: decoded and from-the-cache blocks and traces (KATYBUG_STATS), the guest instructions,
 * the lifted share and region entries (a -DKB_COUNT build, KATYBUG_COUNT), the output md5 against WANT, wall.
 * The katybug builds are the machine's checkpointable ones: katybug-<arm>.wasm, its fuel build
 * katybug-<arm>.inst.wasm (scripts/wasm/instrument.sh), and the resumable build this script makes beside them.
 * `WANT=<md5 prefix of the binary's output> [CUT=700] regions-cache-wasm.ts <build/kernel> <variant dir> <arm>...`
 * e.g. arms fncc-gzip (regions) and intc-gzip (none), busybox-amd64 in the variant dir
 * `WORKLOADS=gzip,bzip2,sqlite,bash,sha256,ls WANTS=gzip=<md5>,bzip2=<md5>,... [RUNS=2]` runs those programs of the variant
 * dir (busybox-amd64, sqlite3, bash, coreutils) in one machine instead: runs 1 and 2 of each, the checkpoint and restore
 * of runs 3 and 4 only when RUNS is not 2 (and then only for the first workload). NORESUME=1 runs the fuel build as it is,
 * for a check with no checkpoint
 */
const [kernel = '', dir = '', ...arms] = process.argv.slice(2);
const wants = new Map<string, string>(
	process.env.WANTS
		? process.env.WANTS.split(',').map((p) => p.split('=') as [string, string])
		: [['gzip', process.env.WANT ?? '']]
);
const workloads = (process.env.WORKLOADS ?? 'gzip').split(',');
const runs = Number(process.env.RUNS ?? 4);
if (!kernel || !dir || !arms.length || workloads.some((w) => !wants.get(w))) {
	console.error('usage: WANT=<md5 prefix of the binary output> [CUT=ms] regions-cache-wasm.ts <build/kernel> <variant dir> <arm>...');
	process.exit(2);
}
const cut = Number(process.env.CUT ?? 700);
const root = new URL('../../../', import.meta.url).pathname;
const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const read = (path: string) => new Uint8Array(readFileSync(path));
const manifest = JSON.parse(readFileSync(join(kernel, 'manifest.json'), 'utf8'));

/** the resumable build of an arm's fuel build, once */
function resumable(arm: string) {
	const inst = join(dir, `katybug-${arm}.inst.wasm`);
	const globals = join(dir, `katybug-${arm}.g.wasm`);
	const evac = join(dir, `katybug-${arm}.evac.wasm`);
	if (process.env.NORESUME) return inst;
	if (!existsSync(evac)) {
		execFileSync(join(root, 'scripts/ts'), [join(root, 'scripts/wasm/export-globals.ts'), inst, globals, '--all-mutable'], { stdio: 'inherit' });
		execFileSync(process.execPath, [join(root, 'experiments/evacuation/scripts/evacuate.ts'), globals, evac, '--resume'], { stdio: 'inherit' });
	}
	return evac;
}

function options(arm: string, sink: { text: string }): MachineOptions {
	const plain = join(dir, `katybug-${arm}.wasm`);
	const cpio = join(dir, `${arm}.cpio`);
	const programs = ['busybox-amd64', 'sqlite3', 'bash', 'coreutils'].filter((p) => existsSync(join(dir, p)));
	appendCpio(join(kernel, 'initramfs.bin'), cpio, [`/bin/katybug=${plain}`, ...programs.map((p) => `/bin/${p}=${join(dir, p)}`)]);
	return {
		vmlinux: new WebAssembly.Module(read(join(kernel, 'vmlinux.async.wasm'))),
		initrd: read(cpio),
		cmdline: 'maxcpus=3 root=/dev/ram0 rootfstype=ramfs init=/init console=hvc console=ttyS0',
		registry: new Map([
			[manifest.busybox, new WebAssembly.Module(read(join(kernel, 'busybox.async.wasm')))],
			[sha256(read(plain)), new WebAssembly.Module(read(resumable(arm)))]
		]),
		maximumPages: 4096,
		sha256,
		sharedKernel: true,
		asyncify: true,
		write: (text) => (sink.text += text)
	};
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, Math.min(ms, 5)));
const until = (m: Machine, test: () => boolean, ms = 300_000) => {
	const t = Date.now();
	return m.run(() => test() || Date.now() - t > ms, sleep);
};
const programs: Record<string, string> = {
	gzip: '/bin/busybox-amd64 gzip -9 -c /tmp/in',
	bzip2: '/bin/busybox-amd64 bzip2 -9 -c /tmp/in',
	sqlite: `/bin/sqlite3 :memory: "with recursive c(x) as (select 1 union all select x+1 from c where x<100000) select count(*), sum(x*x) % 1000003 from c;"`,
	bash: `/bin/bash -c 'i=0; s=0; while [ $i -lt 20000 ]; do s=$((s+i*i%7)); i=$((i+1)); done; echo $s'`,
	sha256: '/bin/coreutils --coreutils-prog=sha256sum < /tmp/in',
	seq: '/bin/busybox-amd64 seq 1 50000'
};
/** the shell line for one run of a workload, its results echoed with the label split so the typed line does not match */
const shell = (w: string, n: number) =>
	`h=$(KATYBUG_STATS=1 KATYBUG_COUNT=/tmp/c${n} KATYBUG_CACHE=/tmp/kbc-${w} ${programs[w]} 2> /tmp/s${n} | /bin/busybox md5sum); ` +
	`echo "R""${n} md5 $h"; echo "R""${n} stats $(cat /tmp/s${n})"; echo "R""${n} count $(cat /tmp/c${n})"; echo "R""${n} done"\n`;

function parse(text: string, n: number) {
	const line = (what: string) => new RegExp(`R${n} ${what} (.*)`).exec(text)?.[1] ?? '';
	const stats = line('stats');
	const count = line('count');
	const field = (s: string, re: RegExp) => Number(re.exec(s)?.[1] ?? NaN);
	const insns = field(count, /\binsns (\d+)/);
	return {
		md5: line('md5').slice(0, 8),
		decoded: field(stats, /(\d+) decoded/),
		cache: field(stats, /(\d+) from the cache/),
		traces: field(stats, /(\d+) traces/),
		insns,
		lifted: insns ? (100 * field(count, /\blifted (\d+)/)) / insns : NaN,
		entries: field(count, /\bentries (\d+)/)
	};
}

console.log(`node ${process.version}, V8 ${process.versions.v8}, cut ${cut} ms, want ${[...wants].map(([k, v]) => `${k} ${v}`).join(', ')}`);
console.log('| arm | run | decoded | from cache | traces | guest insns | lifted | region entries | output | wall ms | load1 |');
console.log('| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |');
let failed = 0;
for (const arm of arms) {
	const sink = { text: '' };
	const opts = options(arm, sink);
	let m = new Machine(opts);
	await until(m, () => sink.text.includes('# '), 120_000);
	let w = 'gzip';
	const row = (label: string, n: number, ms: number) => {
		const r = parse(sink.text, n);
		const ok = r.md5 === wants.get(w);
		if (!ok) failed++;
		console.log(`| ${arm} | ${w} ${label} | ${r.decoded} | ${r.cache} | ${r.traces} | ${r.insns} | ${Number.isNaN(r.lifted) ? '-' : r.lifted.toFixed(1) + '%'} | ${Number.isNaN(r.entries) ? '-' : r.entries} | ${ok ? 'exact' : `${r.md5} DIFFERS`} | ${ms.toFixed(0)} | ${loadavg()[0]!.toFixed(2)} |`);
		return r;
	};
	const go = async (n: number) => {
		const t = performance.now();
		m.type(shell(w, n));
		await until(m, () => sink.text.includes(`R${n} done`));
		return performance.now() - t;
	};
	m.type(`/bin/busybox seq 1 400000 > /tmp/in; mkdir ${workloads.map((x) => `/tmp/kbc-${x}`).join(' ')}; echo "S""etup done"\n`);
	await until(m, () => sink.text.includes('Setup done'));
	for (const [i, name] of workloads.entries()) {
		w = name;
		const base = i * 10;
		row('1 (cold)', base + 1, await go(base + 1));
		row('2 (cache)', base + 2, await go(base + 2));
		if (runs > 2 && i === 0) await checkpointRuns(base);
	}
	async function checkpointRuns(base: number) {
	// run 3: checkpointed in the middle, finished in a fresh machine of the same modules
	const t3 = performance.now();
	m.type(shell(w, base + 3));
	await until(m, () => false, cut);
	const mid = await m.checkpoint();
	const t1 = performance.now();
	m = await Machine.restore(opts, { ...mid, memory: mid.memory.slice() });
	await until(m, () => sink.text.includes(`R${base + 3} done`));
	const r3 = row(`3 (checkpoint at ${cut} ms, restored)`, base + 3, performance.now() - t3);
	console.log(`# ${arm}: checkpoint ${(t1 - t3 - cut).toFixed(0)} ms, snapshot ${(mid.memory.byteLength / 1048576).toFixed(0)} MiB, restored crashed=${m.crashed}`);
	row('4 (restored machine, cache)', base + 4, await go(base + 4));
	if (r3.entries === 0 && arm.startsWith('fnc')) failed++;
	}
}
process.exit(failed ? 1 : 0);
