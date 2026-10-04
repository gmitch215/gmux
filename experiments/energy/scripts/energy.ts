import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { appendCpio } from '../../../scripts/wasm/cpio-append.ts';
import { siteOptions } from '../../../src/worker/site-machine.ts';
import { booted, loop, type Arm } from '../src/drive.ts';
import { net as netOf, quantile, span as rapl, wants, type Snap } from '../src/rapl.ts';

/**
 * joules per census job on one machine, the arms interleaved: native Linux, gmux in node (JSPI and
 * asyncify builds), Katybug running the native binaries in gmux, and gmux in a local `workerd serve`.
 * The package counter is RAPL's, read around each window with the idle power of the 2 s before it
 * subtracted; a window whose other-tenant CPU (the machine's busy cores minus this rig's own) is over
 * OTHER_MAX is discarded and taken again. A `null` arm sleeps one window and must net zero.
 *
 * `WORK=<dir> node energy.ts run [rounds]` appends to $WORK/samples.jsonl; `... summarize` prints
 * the table. WORK holds bin/ (native.sh), stage/ (stage.sh) and kernel/ (build/kernel).
 * ARMS (native,node,async,katybug,workerd), ONLY (workloads), WINDOW_MS, OTHER_MAX; a cell (workload
 * and arm) takes samples until it holds KEEP kept ones (default 5) or has tried ATTEMPTS (15);
 * `quiet` reads idle windows only;
 * the workerd arm needs WORKER_URL (the full URL) and WORKERD_PID (its pid, for its CPU).
 */
const here = new URL('.', import.meta.url).pathname;
const [mode = '', arg = ''] = process.argv.slice(2);
const work = process.env.WORK;
if (!work || !['run', 'summarize', 'pick', 'quiet'].includes(mode)) {
	console.error('usage: WORK=<dir> node --experimental-strip-types energy.ts run [rounds] | summarize | pick | quiet [windows]');
	process.exit(2);
}
const RAPL = process.env.RAPL ?? '/sys/class/powercap/intel-rapl:0';
const TICK = Number(execFileSync('getconf', ['CLK_TCK']).toString());
const samplesFile = join(work, 'samples.jsonl');
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]!;
const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

// #region counters
const num = (path: string) => Number(readFileSync(path, 'utf8'));
const wrap = existsSync(`${RAPL}/max_energy_range_uj`) ? num(`${RAPL}/max_energy_range_uj`) : 0;
const busyJiffies = () => {
	const f = readFileSync('/proc/stat', 'utf8').split('\n')[0]!.split(/\s+/).slice(1).map(Number);
	return f.slice(0, 8).reduce((x, y) => x + y, 0) - f[3]! - f[4]!;
};
const cpuOf = (pid: number | 'self') => {
	const s = readFileSync(`/proc/${pid}/stat`, 'utf8');
	const f = s.slice(s.lastIndexOf(')') + 2).split(' ');
	return f.slice(11, 15).reduce((x, y) => x + Number(y), 0);
};
const workerd = Number(process.env.WORKERD_PID ?? 0);
const snap = (): Snap => ({
	t: performance.now(),
	uj: num(`${RAPL}/energy_uj`),
	busy: busyJiffies(),
	own: cpuOf('self') + (workerd ? cpuOf(workerd) : 0)
});
const span = (a: Snap, b: Snap) => rapl(a, b, wrap, TICK);
// #endregion

if (mode === 'pick') {
	// the two least busy logical cpus on different physical cores, over one second
	const read = () =>
		readFileSync('/proc/stat', 'utf8')
			.split('\n')
			.filter((l) => /^cpu\d/.test(l))
			.map((l) => l.split(/\s+/).slice(1).map(Number));
	const a = read();
	await sleep(1000);
	const b = read();
	const load = b.map((f, i) => f.slice(0, 8).reduce((x, y) => x + y, 0) - f[3]! - f[4]! - (a[i]!.slice(0, 8).reduce((x, y) => x + y, 0) - a[i]![3]! - a[i]![4]!));
	const half = load.length / 2;
	const core = load.map((l, i) => ({ i, l: l + load[(i + half) % load.length]! })).filter((c) => c.i < half).sort((x, y) => x.l - y.l);
	console.log(`${core[0]!.i},${core[1]!.i}`);
	process.exit(0);
}

if (mode === 'quiet') {
	// idle windows with the rig doing nothing: the other-tenant cores and the idle watts of each
	const n = Number(arg || 30);
	const windowMs = Number(process.env.WINDOW_MS ?? 3000);
	const otherMax = Number(process.env.OTHER_MAX ?? 0.3);
	const other: number[] = [];
	const watts: number[] = [];
	for (let i = 0; i < n; i++) {
		const a = snap();
		await sleep(windowMs);
		const w = span(a, snap());
		other.push(w.other);
		watts.push(w.j / w.s);
		console.log(`window ${i + 1}: other ${w.other.toFixed(3)} cores, ${(w.j / w.s).toFixed(2)} W, load1 ${readFileSync('/proc/loadavg', 'utf8').split(' ')[0]}`);
	}
	const under = other.filter((x) => x <= otherMax).length;
	console.log(`other-tenant cores over ${n} windows of ${windowMs} ms: median ${quantile(other, 0.5).toFixed(3)}, p90 ${quantile(other, 0.9).toFixed(3)}, max ${Math.max(...other).toFixed(3)}`);
	console.log(`windows at or under ${otherMax} cores: ${under}/${n} (${((100 * under) / n).toFixed(0)}%)`);
	console.log(`idle watts: median ${quantile(watts, 0.5).toFixed(2)}, range ${Math.min(...watts).toFixed(2)}-${Math.max(...watts).toFixed(2)}`);
	process.exit(0);
}

// #region workloads
// IN and OUT are the machine's /tmp/in and /tmp/out, and a tmpfs path natively
const workloads: Record<string, string> = {
	lua: `lua -e "local t={} for i=1,300000 do t[i]=i*2 end local s=0 for r=1,5 do for i=1,#t do s=s+t[i]%7 end end print(s)"`,
	gzip: 'gzip -9 -c IN | wc -c',
	bzip2: 'bzip2 -9 -c IN | wc -c',
	sqlite: `sqlite :memory: "create table t(a,b); with recursive c(x) as (select 1 union all select x+1 from c limit 60000) insert into t select x, x%97 from c; select count(*), sum(b) from t group by b % 5;"`,
	sed: "sed -e 's/1/one/g; s/[0-9]*$/&x/' IN | wc -c",
	gawk: "gawk '{ s += $1 % 13 } END { print s }' IN"
};
const pick = (process.env.ONLY ?? '').split(',').filter(Boolean);
const names = Object.keys(workloads).filter((k) => !pick.length || pick.includes(k));
// #endregion

// #region arms
const shm = join('/dev/shm', `energy-${process.pid}`);
const native: Arm = {
	name: 'native',
	async exec(cmd, k, out) {
		mkdirSync(shm, { recursive: true });
		if (!existsSync(join(shm, 'in'))) execFileSync('sh', ['-c', `seq 1 400000 > ${join(shm, 'in')}`]);
		const line = loop(cmd, k, { IN: join(shm, 'in'), OUT: join(shm, 'out') }, out);
		const t = performance.now();
		const got = execFileSync('sh', ['-c', line], { env: { PATH: `${join(work, 'bin')}:/usr/bin:/bin`, LC_ALL: 'C' } });
		return { ms: performance.now() - t, out: got.toString() };
	}
};
const nullArm: Arm = {
	name: 'null',
	async exec() {
		const t = performance.now();
		await sleep(Number(process.env.WINDOW_MS ?? 3000));
		return { ms: performance.now() - t, out: '' };
	}
};

const kernel = (f: string) => new Uint8Array(readFileSync(join(work, 'kernel', f)));
const manifest = JSON.parse(readFileSync(join(work, 'kernel/manifest.json'), 'utf8')) as { busybox: string; katybug: string };

const guardedBuild = new WebAssembly.Module(kernel('busybox.guard.wasm'));
async function nodeArm(): Promise<Arm> {
	const registry = new Map<string, WebAssembly.Module>([[manifest.busybox, new WebAssembly.Module(kernel('busybox.wasm'))]]);
	const files: string[] = [];
	for (const n of names) {
		const image = join(work, 'stage', `${n}.wasm`);
		registry.set(sha256(readFileSync(image)), new WebAssembly.Module(readFileSync(join(work, 'stage', `${n}.node.wasm`))));
		files.push(`/bin/${n}=${image}`);
	}
	const initrd = join(work, 'initrd.node.cpio');
	appendCpio(join(work, 'kernel/initramfs.bin'), initrd, files);
	return booted(
		{ vmlinux: new WebAssembly.Module(kernel('vmlinux.wasm')), initrd: new Uint8Array(readFileSync(initrd)), cmdline: 'maxcpus=3 root=/dev/ram0 rootfstype=ramfs init=/init console=hvc console=ttyS0', registry, maximumPages: 4096, sha256, sharedKernel: true },
		'node'
	);
}
async function asyncArm(): Promise<Arm> {
	const files: string[] = [];
	const extra = new Map<string, WebAssembly.Module>();
	for (const n of names) {
		const image = join(work, 'stage', `${n}.wasm`);
		extra.set(sha256(readFileSync(image)), new WebAssembly.Module(readFileSync(join(work, 'stage', `${n}.async.wasm`))));
		files.push(`/bin/${n}=${image}`);
	}
	const initrd = join(work, 'initrd.async.cpio');
	appendCpio(join(work, 'kernel/initramfs.bin'), initrd, files);
	const options = siteOptions(
		{ vmlinux: new WebAssembly.Module(kernel('vmlinux.async.wasm')), busybox: new WebAssembly.Module(kernel('busybox.async.wasm')), busyboxGuard: guardedBuild, katybug: new WebAssembly.Module(kernel('katybug.wasm')), initrd: new Uint8Array(readFileSync(initrd)), manifest },
		{ sha256, write: () => {} }
	);
	for (const [k, v] of extra) options.registry.set(k, v);
	options.maximumPages = 4096;
	return booted(options, 'async');
}
async function katybugArm(): Promise<Arm> {
	const files = names.map((n) => `/bin/${n}=${join(work, 'bin', n)}`);
	const initrd = join(work, 'initrd.katybug.cpio');
	const dir = process.env.KB_KERNEL ?? 'kernel';
	const own = (f: string) => new Uint8Array(readFileSync(join(work, dir, f)));
	const katybug = JSON.parse(readFileSync(join(work, dir, 'manifest.json'), 'utf8')).katybug as string;
	appendCpio(join(work, dir, 'initramfs.bin'), initrd, files);
	const registry = new Map<string, WebAssembly.Module>([
		[manifest.busybox, new WebAssembly.Module(own('busybox.wasm'))],
		[katybug, new WebAssembly.Module(own('katybug.wasm'))]
	]);
	return booted(
		{ vmlinux: new WebAssembly.Module(own('vmlinux.wasm')), initrd: new Uint8Array(readFileSync(initrd)), cmdline: 'maxcpus=3 root=/dev/ram0 rootfstype=ramfs init=/init console=hvc console=ttyS0', registry, maximumPages: 4096, sha256, sharedKernel: true },
		'katybug'
	);
}
function workerdArm(): Arm {
	const base = process.env.WORKER_URL;
	if (!base) {
		console.error('usage: the workerd arm needs WORKER_URL (the full URL of `workerd serve`) and WORKERD_PID');
		process.exit(2);
	}
	return {
		name: 'workerd',
		async exec(cmd, k, out) {
			const t = performance.now();
			const res = await fetch(`${base}/exec`, { method: 'POST', body: JSON.stringify({ cmd, k, out }) });
			const body = await res.text();
			if (!res.ok) throw new Error(`workerd: ${res.status} ${body.slice(0, 400)}`);
			return { ms: performance.now() - t, out: body };
		}
	};
}
// #endregion

// #region run
if (mode === 'run') {
	const rounds = Number(arg || 3);
	const windowMs = Number(process.env.WINDOW_MS ?? 3000);
	const otherMax = Number(process.env.OTHER_MAX ?? 0.3);
	const budget = Number(process.env.ATTEMPTS ?? 15);
	const want = Number(process.env.KEEP ?? 5);
	const cells = new Map<string, { kept: number; tried: number }>();
	const idleMs = Number(process.env.IDLE_MS ?? 2000);
	const settleMs = Number(process.env.SETTLE_MS ?? 2000);
	const armNames = (process.env.ARMS ?? 'native,node,async,katybug').split(',');
	const arms: Arm[] = [];
	for (const a of armNames) {
		const built = a === 'native' ? native : a === 'node' ? await nodeArm() : a === 'async' ? await asyncArm() : a === 'katybug' ? await katybugArm() : a === 'workerd' ? workerdArm() : undefined;
		if (!built) throw new Error(`unknown arm ${a}`);
		arms.push(built);
		console.log(`booted ${a}`);
	}
	// warm-up: the output must equal native's, and its time sets how many runs fill a window
	const k = new Map<string, number>();
	for (const w of names) {
		const reference = (await native.exec(workloads[w]!, 1, true)).out.trim();
		console.log(`${w}: native -> ${reference}`);
		for (const arm of arms) {
			await arm.exec(workloads[w]!, 1, false);
			const first = await arm.exec(workloads[w]!, 1, true);
			const timed = await arm.exec(workloads[w]!, 1, false);
			if (first.out.trim() !== reference) throw new Error(`${arm.name} ${w}: output ${JSON.stringify(first.out.slice(0, 200))} is not native's ${JSON.stringify(reference)}`);
			k.set(`${arm.name}/${w}`, Math.min(400, Math.max(1, Math.ceil(windowMs / timed.ms))));
			console.log(`${w}: ${arm.name} ${timed.ms.toFixed(0)} ms/job, k=${k.get(`${arm.name}/${w}`)}`);
		}
	}
	const sample = async (arm: Arm, w: string, round: number) => {
		const cell = cells.get(`${arm.name}/${w}`) ?? { kept: 0, tried: 0 };
		cells.set(`${arm.name}/${w}`, cell);
		for (let attempt = 1; wants(cell, want, budget); attempt++) {
			cell.tried++;
			const jobs = arm.name === 'null' ? 1 : k.get(`${arm.name}/${w}`)!;
			// idle read straight after a window came out high (the null arm netted negative)
			await sleep(settleMs);
			const i0 = snap();
			await sleep(idleMs);
			const i1 = snap();
			const idle = span(i0, i1);
			const r0 = snap();
			const got = await arm.exec(workloads[w] ?? '', jobs, false);
			const r1 = snap();
			const run = span(r0, r1);
			const idleW = idle.j / idle.s;
			const net = netOf(run.j, run.s, idleW);
			const kept = idle.other <= otherMax && run.other <= otherMax;
			const row = { round, attempt, arm: arm.name, workload: w, jobs, kept, wallMs: +(got.ms / jobs).toFixed(3), windowS: +run.s.toFixed(3), grossJ: +run.j.toFixed(4), idleW: +idleW.toFixed(3), netJ: +net.toFixed(4), netJPerJob: +(net / jobs).toFixed(6), otherCores: +run.other.toFixed(3), idleOtherCores: +idle.other.toFixed(3), load1: readFileSync('/proc/loadavg', 'utf8').split(' ')[0] };
			appendFileSync(samplesFile, `${JSON.stringify(row)}\n`);
			if (kept) {
				cell.kept++;
				return;
			}
		}
	};
	for (let round = 0; round < rounds; round++)
		for (const w of names) {
			const order = [...arms, nullArm];
			const shift = round % order.length;
			for (const arm of [...order.slice(shift), ...order.slice(0, shift)]) await sample(arm, w, round);
			console.log(`round ${round} ${w} done`);
		}
	console.log(`samples in ${samplesFile}`);
	process.exit(0);
}
// #endregion

// #region summarize
const rows = readFileSync(samplesFile, 'utf8').trim().split('\n').map((l) => JSON.parse(l) as Record<string, any>);
const spread = (xs: number[]) => (xs.length ? `${((100 * (Math.max(...xs) - Math.min(...xs))) / median(xs)).toFixed(0)}%` : '-');
const armsSeen = [...new Set(rows.map((r) => r.arm as string))];
const idleKept = rows.filter((r) => r.kept).map((r) => r.idleW as number);
console.log(`idle baseline: median ${median(idleKept).toFixed(2)} W, range ${Math.min(...idleKept).toFixed(2)}-${Math.max(...idleKept).toFixed(2)} W over ${idleKept.length} kept windows`);
const want = Number(process.env.KEEP ?? 5);
const dropped = (xs: Record<string, any>[]) => {
	const o = xs.map((r) => Math.max(r.otherCores as number, r.idleOtherCores as number));
	return o.length ? `${quantile(o, 0.5).toFixed(2)}/${Math.max(...o).toFixed(2)}` : '-';
};
console.log('| workload | arm | n kept/taken | jobs | J/job median | J/job min-max | spread | ms/job median | W net | J ratio | time ratio | load1 median | discarded other cores median/max |');
console.log('| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |');
for (const w of [...new Set(rows.map((r) => r.workload as string))]) {
	const base = rows.filter((r) => r.workload === w && r.arm === 'native' && r.kept);
	for (const arm of armsSeen) {
		const all = rows.filter((r) => r.workload === w && r.arm === arm);
		const kept = all.filter((r) => r.kept);
		if (!kept.length) {
			console.log(`| ${w} | ${arm} | 0/${all.length} (n<${want}) | - | - | - | - | - | - | - | - | - | ${dropped(all)} |`);
			continue;
		}
		const j = kept.map((r) => r.netJPerJob as number);
		const ms = kept.map((r) => r.wallMs as number);
		const watts = kept.map((r) => (r.netJ as number) / (r.windowS as number));
		const ratio = (xs: number[], ys: number[]) => (ys.length && arm !== 'null' ? (median(xs) / median(ys)).toFixed(1) : '-');
		console.log(`| ${w} | ${arm} | ${kept.length}/${all.length}${kept.length < want ? ` (n<${want})` : ''} | ${kept[0]!.jobs} | ${median(j).toFixed(4)} | ${Math.min(...j).toFixed(4)}-${Math.max(...j).toFixed(4)} | ${spread(j)} | ${median(ms).toFixed(1)} | ${median(watts).toFixed(1)} | ${ratio(j, base.map((r) => r.netJPerJob))} | ${ratio(ms, base.map((r) => r.wallMs))} | ${median(kept.map((r) => Number(r.load1))).toFixed(2)} | ${dropped(all.filter((r) => !r.kept))} |`);
	}
}
// #endregion
