import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { Session } from 'node:inspector/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { appendCpio } from '../../../scripts/wasm/cpio-append.ts';
import { routerModules } from '../../../scripts/wasm/router-modules.ts';
import { Machine, type SyscallCall } from '../../../src/worker/machine/machine.ts';

/**
 * Syscalls of four workloads run inside a machine under Node, and the share of their CPU the kernel
 * takes. `configure` is a generated configure-shaped BusyBox script, `fork` 300 fork+exec, `lsl` the
 * `ls -l /bin` loop, `userland` Katybug amd64 bash and coreutils (build/katybug/transcript/ubin).
 *   MODE=count (default): MachineOptions.countSyscalls; prints one JSON object: counts by number,
 *     processes, open-to-close shapes, read-only opens of system files and their paths
 *   MODE=profile: --cpu-prof style sampling of the workload (counting off), samples by category
 *   MODE=stat: the system paths the workload opened (a counted run), their size, mtime and ctime
 *     before and after a second run in a fresh machine
 * GMUX_BUILD picks the build (default build/), VMLINUX a kernel with a name section, N the loop
 * count, NR_TABLE a file of `#define __NR_<name> <n>` lines for call names.
 * `node --no-warnings --experimental-strip-types experiments/syscall-cost/scripts/census.ts <workload>`
 */
const root = new URL('../../../', import.meta.url).pathname;
const [workload] = process.argv.slice(2);
if (!['configure', 'fork', 'lsl', 'userland'].includes(workload ?? ''))
	throw new Error('usage: census.ts <configure|fork|lsl|userland>');
const mode = process.env.MODE ?? 'count';
const build = process.env.GMUX_BUILD ?? join(root, 'build');
const kernel = join(build, 'kernel');
const work = mkdtempSync(join(tmpdir(), 'gmux-census-'));
const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const manifest = JSON.parse(readFileSync(join(kernel, 'manifest.json'), 'utf8'));
const n = Number(process.env.N ?? { configure: 300, fork: 300, lsl: 1000, userland: 40 }[workload!]);

const names = new Map<number, string>();
if (process.env.NR_TABLE)
	for (const line of readFileSync(process.env.NR_TABLE, 'utf8').split('\n')) {
		const m = /#define __NR(?:3264)?_(\w+)\s+(\d+)/.exec(line);
		if (m) names.set(Number(m[2]), m[1]!);
	}
const nameOf = (nr: number) => names.get(nr) ?? `nr${nr}`;

// the scripts the machine runs, one line per step (a typed line is cut near 1,020 bytes)
const scripts: Record<string, string> = {
	configure: `
cd /tmp
i=0
while [ $i -lt ${n} ]; do
	i=$((i+1))
	f=/usr/include/g$((i % 20)).h
	test -f $f && echo "checking for $f... yes" > /dev/null
	test -f /usr/include/nosuch$i.h || echo "checking for nosuch... no" > /dev/null
	test -x /bin/busybox && echo "checking for busybox... yes" > /dev/null
	expr $i + 1 > /dev/null
	grep -c define $f > /dev/null
	sed -n 1p $f > /dev/null
	cat $f > /dev/null
	echo "int main(void) { return $i; }" > conftest.c
	cat conftest.c > conftest.out
	rm -f conftest.c conftest.out
done
`,
	fork: `
i=0
while [ $i -lt ${n} ]; do
	i=$((i+1))
	/bin/true
done
`,
	lsl: `
i=0
while [ $i -lt ${n} ]; do
	i=$((i+1))
	ls -l /bin > /dev/null
done
`,
	userland: `
mkdir /u
for p in cat stat ls; do ln -s /bin/coreutils /u/$p; done
printf 'root:x:0:0\\nbin:x:1:1\\n' > /tmp/sample
cat > /work/u.sh << 'EOF'
i=0
while [ $i -lt ${n} ]; do
	i=$((i+1))
	/u/cat /tmp/sample > /dev/null
	/u/stat /tmp/sample > /dev/null
	/u/ls -l /etc > /dev/null
done
EOF
bash /work/u.sh
`
};
const runner = workload === 'userland' ? 'sh /work/setup.sh' : 'sh /work/w.sh';
writeFileSync(join(work, 'w.sh'), scripts[workload!]!);
writeFileSync(join(work, 'setup.sh'), scripts.userland!);
const files = [`/work/w.sh=${join(work, 'w.sh')}`, `/work/setup.sh=${join(work, 'setup.sh')}`];
// the machine has no headers, so configure's system-file probes get twenty small ones
for (let k = 0; k < 20; k++) {
	const text = Array.from({ length: 60 }, (_, l) => `#define G${k}_L${l} ${k * l}\n`).join('');
	writeFileSync(join(work, `g${k}.h`), text);
	files.push(`/usr/include/g${k}.h=${join(work, `g${k}.h`)}`);
}
if (workload === 'userland') {
	const ubin = join(root, 'build/katybug/transcript/ubin');
	files.push(`/bin/bash=${join(ubin, 'bash')}`, `/bin/coreutils=${join(ubin, 'coreutils')}`);
}
appendCpio(join(kernel, 'initramfs.bin'), join(work, 'initramfs.cpio'), files);

const registry = new Map<string, WebAssembly.Module>([
	[manifest.busybox, new WebAssembly.Module(readFileSync(join(kernel, 'busybox.wasm')))]
]);
if (manifest.katybug)
	registry.set(manifest.katybug, new WebAssembly.Module(readFileSync(join(kernel, 'katybug.wasm'))));
const vmlinux = new WebAssembly.Module(
	readFileSync(process.env.VMLINUX ?? join(kernel, 'vmlinux.wasm'))
);
const router = routerModules();
const initrd = new Uint8Array(readFileSync(join(work, 'initramfs.cpio')));

async function boot(count: boolean | ((call: SyscallCall) => void)) {
	let output = '';
	const machine = new Machine({
		vmlinux,
		initrd,
		cmdline: 'maxcpus=3 root=/dev/ram0 rootfstype=ramfs init=/init console=hvc console=ttyS0',
		registry,
		maximumPages: 4096,
		sha256,
		sharedKernel: true,
		...(count ? { router, countSyscalls: count } : {}),
		write: (text) => (output += text)
	});
	const run = async (until: () => boolean, limit = 1_800_000) => {
		const t = Date.now();
		await machine.run(
			() => until() || Date.now() - t > limit,
			(ms) => new Promise((r) => setTimeout(r, Math.min(ms, 5)))
		);
		if (!until()) throw new Error(`stuck: ${output.slice(-400)}`);
	};
	await run(() => output.includes('# '), 120_000);
	// a command typed on the machine's console, until its marker returns
	const exec = async (line: string) => {
		const start = output.length;
		machine.type(`${line}\necho "== done-$((6*7))"\n`);
		await run(() => output.slice(start).includes('== done-42'));
		return output.slice(start);
	};
	return { machine, exec, output: () => output };
}

const FD_CALLS = new Set([
	'read', 'write', 'pread64', 'pwrite64', 'readv', 'writev', 'lseek', 'fstat', 'fcntl', 'ioctl',
	'getdents64', 'fstatfs', 'flock', 'ftruncate', 'fsync', 'fdatasync', 'fadvise64', 'fchmod',
	'fchown', 'sendfile', 'fchdir'
]);
const STAT_CALLS = new Set(['newfstatat', 'fstat', 'statx', 'faccessat', 'faccessat2', 'statfs']);
const SYSTEM = ['/usr/', '/lib/', '/etc/', '/bin/', '/sbin/', '/opt/'];
const O_WRITE = 0o1 | 0o2 | 0o100 | 0o1000;
const O_DIRECTORY = 0o200000;
const pathClass = (path: string) =>
	SYSTEM.some((p) => path.startsWith(p))
		? 'system'
		: /^\/(proc|dev|sys)\b/.test(path)
			? 'proc/dev/sys'
			: path.startsWith('/tmp/')
				? 'tmp'
				: path.startsWith('/')
					? 'other abs'
					: 'relative';
const signature = (calls: string[]) => {
	const out: string[] = [];
	for (const c of calls) {
		const last = out[out.length - 1];
		if (last === c || last === `${c}*`) out[out.length - 1] = `${c}*`;
		else out.push(c);
	}
	return out.join(' ');
};
const bump = <K>(m: Map<K, number>, k: K, by = 1) => m.set(k, (m.get(k) ?? 0) + by);
const top = <K>(m: Map<K, number>, k: number) => [...m].sort((a, b) => b[1] - a[1]).slice(0, k);

// the shapes of run 1's census, read from the calls a machine's hook reports
function collector() {
	const open = new Map<string, { path: string; kind: string; calls: string[] }>();
	const txns = new Map<string, number>();
	const sysPaths = new Map<string, number>();
	const absent = new Map<string, number>();
	const tasks = new Set<number>();
	// every absolute system path opened, exec'd or stat'd
	const touched = new Set<string>();
	let events = 0;
	let execs = 0;
	let roSystem = 0;
	let roSystemPlain = 0;
	let listings = 0;
	let armed = false;
	const handler = (c: SyscallCall) => {
		if (!armed) return;
		const name = nameOf(c.nr);
		tasks.add(c.task);
		const note = (path: string) => pathClass(path) === 'system' && touched.add(path);
		if (c.ret === null) {
			if (name === 'execve') {
				execs++;
				note(c.string(c.args[0]!));
			}
			return;
		}
		events++;
		if (c.ret >= 0 && ['openat', 'statx', 'newfstatat', 'faccessat', 'faccessat2'].includes(name))
			note(c.string(c.args[1]!));
		if (c.ret < 0 && (STAT_CALLS.has(name) || name === 'openat') && c.ret === -2)
			bump(absent, name);
		const key = (fd: number) => `${c.task}:${fd}`;
		if (name === 'openat' && c.ret >= 0) {
			const path = c.string(c.args[1]!);
			const flags = c.args[2]!;
			const kind = flags & O_DIRECTORY ? 'dir' : flags & O_WRITE ? 'write' : 'ro';
			open.set(key(c.ret), { path, kind, calls: [] });
			return;
		}
		if (name === 'close') {
			const o = open.get(key(c.args[0]!));
			if (!o) return;
			open.delete(key(c.args[0]!));
			const cls = pathClass(o.path);
			bump(txns, `${cls}: openat[${o.kind}] > ${signature(o.calls)}${o.calls.length ? ' > ' : ''}close`);
			if (o.kind === 'dir') listings++;
			if (o.kind === 'ro' && cls === 'system') {
				roSystem++;
				bump(sysPaths, o.path);
				if (o.calls.every((x) => ['read', 'fstat', 'lseek', 'fcntl'].includes(x)))
					roSystemPlain++;
			}
			return;
		}
		if (FD_CALLS.has(name)) open.get(key(c.args[0]!))?.calls.push(name);
	};
	return {
		handler,
		arm: () => (armed = true),
		report: () => ({
			events,
			tasks: tasks.size,
			execs,
			transactions: [...txns.values()].reduce((a, b) => a + b, 0),
			listings,
			roSystem,
			roSystemPlain,
			roSystemDistinctPaths: sysPaths.size,
			roSystemPaths: [...sysPaths.keys()].sort(),
			touchedSystemPaths: [...touched].sort(),
			unclosed: open.size,
			absent: Object.fromEntries(absent),
			topShapes: top(txns, 15),
			topSystemPaths: top(sysPaths, 10)
		})
	};
}

if (mode === 'probe') {
	const m = await boot(false);
	console.log((await m.exec(process.env.PROBE!)).replace(/\r/g, ''));
	process.exit(0);
}

if (mode === 'count') {
	const col = collector();
	const m = await boot(col.handler);
	const base = { ...m.machine.stats.syscalls };
	col.arm();
	const t0 = performance.now();
	const out = await m.exec(`{ ${runner}; } < /dev/null`);
	const ms = performance.now() - t0;
	const counts: Record<number, number> = {};
	for (const [nr, calls] of Object.entries(m.machine.stats.syscalls))
		if (calls - (base[Number(nr)] ?? 0)) counts[Number(nr)] = calls - (base[Number(nr)] ?? 0);
	const total = Object.values(counts).reduce((a, b) => a + b, 0);
	const rows = Object.entries(counts)
		.map(([nr, calls]) => ({ nr: Number(nr), name: nameOf(Number(nr)), calls }))
		.sort((a, b) => b.calls - a.calls);
	const stat = rows.filter((r) => STAT_CALLS.has(r.name)).reduce((a, r) => a + r.calls, 0);
	console.log(
		JSON.stringify({
			workload,
			n,
			wallMs: Math.round(ms),
			total,
			counts,
			top15: rows.slice(0, 15).map((r) => ({ ...r, share: +((100 * r.calls) / total).toFixed(2) })),
			statFamily: stat,
			distinctNumbers: rows.length,
			crashed: String(m.machine.crashed),
			tail: out.replace(/\r/g, '').slice(-200),
			...col.report()
		})
	);
	process.exit(0);
}

if (mode === 'stat') {
	const col = collector();
	const first = await boot(col.handler);
	col.arm();
	await first.exec(`{ ${runner}; } < /dev/null`);
	const paths = col.report().touchedSystemPaths;
	const second = await boot(false);
	// size, mtime, ctime and atime, a few paths to a typed line (it is cut near 1,020 bytes)
	const snap = async () => {
		const seen = new Map<string, string>();
		for (let i = 0; i < paths.length; i += 12) {
			const list = paths.slice(i, i + 12).map((p) => `'${p}'`).join(' ');
			const text = await second.exec(`stat -L -c '%n %s %Y %Z %X' ${list} 2>&1`);
			for (const l of text.replace(/\r/g, '').split('\n'))
				if (/^\/\S* \d+ \d+ \d+ \d+$/.test(l)) seen.set(l.split(' ')[0]!, l);
		}
		return seen;
	};
	const before = await snap();
	await second.exec(`{ ${runner}; } < /dev/null`);
	const after = await snap();
	const first4 = (line: string | undefined) => line?.split(' ').slice(0, 4).join(' ');
	const changed = [...before].filter(([p, line]) => first4(after.get(p)) !== first4(line));
	const atimeMoved = [...before].filter(([p, line]) => after.get(p) !== line).length;
	console.log(
		JSON.stringify({
			workload,
			pathsOpened: paths.length,
			statted: before.size,
			changed: changed.length,
			atimeMoved,
			changedPaths: changed.map(([p, line]) => `${line} -> ${after.get(p)}`)
		})
	);
	process.exit(0);
}

// profile: samples of the workload alone, by what the leaf frame is and whether a syscall entry is
// on its stack
const m = await boot(false);
const session = new Session();
session.connect();
await session.post('Profiler.enable');
await session.post('Profiler.setSamplingInterval', { interval: 100 });
await session.post('Profiler.start');
const t0 = performance.now();
await m.exec(`{ ${runner}; } < /dev/null`);
const ms = performance.now() - t0;
const { profile } = await session.post('Profiler.stop');
type Node = { id: number; callFrame: { functionName: string; url: string }; children?: number[] };
const nodes = new Map<number, Node>(profile.nodes.map((x: Node) => [x.id, x]));
const parent = new Map<number, number>();
for (const x of nodes.values()) for (const c of x.children ?? []) parent.set(c, x.id);
// the module that holds wasm_syscall_* is the kernel
const kernelUrls = new Set<string>();
for (const x of nodes.values())
	if (/^wasm_syscall_\d$/.test(x.callFrame.functionName)) kernelUrls.add(x.callFrame.url);
const cats = new Map<string, number>();
const entries = new Map<string, number>();
const outside = new Map<string, number>();
const kernelLeaf = new Map<string, number>();
const hostLeaf = new Map<string, number>();
const userLeaf = new Map<string, number>();
const total = (profile.samples ?? []).length;
for (const id of profile.samples ?? []) {
	const f = nodes.get(id)!.callFrame;
	let cat: string;
	if (f.functionName === '(idle)') cat = 'idle';
	else if (f.functionName === '(garbage collector)') cat = 'host JS (gc)';
	else if (f.url.startsWith('wasm://') && kernelUrls.has(f.url)) {
		const stack: string[] = [];
		for (let at: number | undefined = id; at !== undefined; at = parent.get(at))
			stack.push(nodes.get(at)!.callFrame.functionName);
		const entry = stack.findLastIndex((name) => /^wasm_syscall_\d$/.test(name));
		cat = entry >= 0 ? 'vmlinux under wasm_syscall_*' : 'vmlinux, not under a syscall';
		// the kernel's name for the call (its __se_sys_ frame), else the frames under the entry
		if (entry >= 0)
			bump(
				entries,
				stack.findLast((name) => name.startsWith('__se_sys_'))?.slice(9) ??
					`? ${stack.slice(Math.max(entry - 2, 0), entry).reverse().join(' > ')}`
			);
		else bump(outside, stack.slice(-3).reverse().join(' > '));
		bump(kernelLeaf, f.functionName);
	} else if (f.url.startsWith('wasm://')) {
		cat = 'user programs (wasm)';
		bump(userLeaf, `${f.url.slice(-12)} ${f.functionName}`);
	} else {
		cat = 'host JS';
		bump(hostLeaf, f.functionName || f.url || '(anonymous)');
	}
	bump(cats, cat);
}
const busy = total - (cats.get('idle') ?? 0);
console.log(
	JSON.stringify({
		workload,
		n,
		wallMs: Math.round(ms),
		samples: total,
		busySamples: busy,
		kernelUrls: [...kernelUrls],
		categories: Object.fromEntries(
			[...cats].map(([k, v]) => [k, { samples: v, shareOfBusy: +((100 * v) / busy).toFixed(2) }])
		),
		topKernelLeaves: top(kernelLeaf, 12),
		topSyscallEntries: top(entries, 30),
		topOutsideSyscalls: top(outside, 10),
		topHostLeaves: top(hostLeaf, 25),
		topUserLeaves: top(userLeaf, 5),
		crashed: String(m.machine.crashed)
	})
);
process.exit(0);
