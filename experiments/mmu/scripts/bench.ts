import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Machine } from '../../../src/worker/machine/machine.ts';

/**
 * the cost of a code transform on census programs, all arms instrumented as the host runs them, on
 * build/kernel in Node, arms interleaved and timed by the host between output markers. ARMS picks them:
 * plain, mmu and inline (the software MMU, the lookup as a call and inlined), flat, eh and ehr (evacuation:
 * binaryen's flatten and -O2, the same with a checkpoint handler around every call, and with resume
 * variants too), guard and guardi (every store checked against a page owner table, the check
 * called and inlined), nostack
 * (plain without the stack pointer check, to price it), simd (the program from SIMD_CENSUS, a census
 * built with EXTRA_CFLAGS=-msimd128).
 * `node --experimental-strip-types experiments/mmu/scripts/bench.ts <census dir> [rounds]`
 */
const root = new URL('../../../', import.meta.url).pathname;
const census = process.argv[2] ?? '';
const rounds = Number(process.argv[3] ?? 3);
const work = join(tmpdir(), `gmux-g1-${process.pid}`);
mkdirSync(work, { recursive: true });
const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const sh = (cmd: string, args: string[]) => execFileSync(cmd, args, { stdio: ['ignore', 'ignore', 'inherit'] });

const all: Record<string, string> = {
	lua: `lua -e "local t={} for i=1,300000 do t[i]=i*2 end local s=0 for r=1,5 do for i=1,#t do s=s+t[i]%7 end end print(s)"`,
	gzip: 'gzip -9 -c /tmp/in > /tmp/in.gz; ls -l /tmp/in.gz | wc -c',
	bzip2: 'bzip2 -9 -c /tmp/in > /tmp/in.bz2; ls -l /tmp/in.bz2 | wc -c',
	sqlite: `sqlite :memory: "create table t(a,b); with recursive c(x) as (select 1 union all select x+1 from c limit 60000) insert into t select x, x%97 from c; select count(*), sum(b) from t group by b % 5;"`,
	sed: "sed -e 's/1/one/g; s/[0-9]*$/&x/' /tmp/in | wc -c",
	gawk: "gawk '{ s += $1 % 13 } END { print s }' /tmp/in"
};
const pick = (process.env.ONLY ?? '').split(',').filter(Boolean);
const workloads = Object.fromEntries(Object.entries(all).filter(([k]) => !pick.length || pick.includes(k)));
const arms = (process.env.ARMS ?? 'plain,mmu,inline').split(',');
/** a custom section naming the arm, so each arm's file in the image has its own hash */
function tagged(bytes: Uint8Array, arm: string): Uint8Array {
	const name = new TextEncoder().encode('gmux.arm');
	const payload = new TextEncoder().encode(arm);
	const body = [name.length, ...name, ...payload];
	return new Uint8Array([...bytes, 0, body.length, ...body]);
}
const files: string[] = [];
const registry = new Map<string, WebAssembly.Module>();
for (const name of Object.keys(workloads)) {
	const plain = join(census, `${name}.wasm`);
	sh('wasm2wat', ['--enable-threads', '--enable-exceptions', '--generate-names', plain, '-o', join(work, `${name}.wat`)]);
	for (const arm of arms) {
		const source = arm === 'simd' ? join(process.env.SIMD_CENSUS ?? '', `${name}.wasm`) : plain;
		// the kernel loads the file in the image, which keeps dylink.0; the host runs the rewritten module
		const image = join(work, `${name}.${arm}.image.wasm`);
		writeFileSync(image, arm === 'plain' || arm === 'simd' ? readFileSync(source) : tagged(readFileSync(plain), arm));
		const file = join(work, `${name}.${arm}.wasm`);
		if (arm === 'plain' || arm === 'nostack' || arm === 'simd') writeFileSync(file, readFileSync(source));
		else if (arm === 'flat' || arm === 'eh' || arm === 'ehr' || arm === 'eh1' || arm === 'ehn' || arm === 'eha') {
			const flag = { flat: ['--no-handlers'], eh: [], ehr: ['--resume'], eh1: ['--one-try'], ehn: ['--no-spill'], eha: ['--all-locals'] }[arm]!;
			sh('node', [join(root, 'experiments/evacuation/scripts/evacuate.mjs'), plain, file, ...flag]);
		} else if (arm === 'guard' || arm === 'guardi') {
			const wat = join(work, `${name}.${arm}.wat`);
			sh('python3', [join(root, 'scripts/wasm/guard-pass.py'), join(work, `${name}.wat`), wat, ...(arm === 'guardi' ? ['--inline'] : [])]);
			sh('wat2wasm', ['--enable-threads', '--enable-exceptions', '--enable-multi-memory', wat, '-o', file]);
		} else {
			const wat = join(work, `${name}.${arm}.wat`);
			sh('python3', [join(root, 'scripts/wasm/mmu-pass.py'), join(work, `${name}.wat`), wat, ...(arm === 'inline' ? ['--inline'] : [])]);
			sh('wat2wasm', ['--enable-threads', '--enable-exceptions', '--enable-multi-memory', wat, '-o', file]);
		}
		const fueled = join(work, `${name}.${arm}.fuel.wasm`);
		execFileSync(join(root, 'scripts/wasm/instrument.sh'), [file, fueled], {
			stdio: ['ignore', 'ignore', 'inherit'],
			env: { ...process.env, GMUX_NO_STACK_CHECK: arm === 'nostack' ? '1' : '' }
		});
		registry.set(sha256(readFileSync(image)), new WebAssembly.Module(readFileSync(fueled)));
		files.push(`/bin/${arm === 'plain' ? name : `${name}.${arm}`}=${image}`);
	}
}
const build = join(root, 'build');
const manifest = JSON.parse(readFileSync(join(build, 'kernel/manifest.json'), 'utf8'));
registry.set(manifest.busybox, new WebAssembly.Module(readFileSync(join(build, 'kernel/busybox.wasm'))));
const initrd = join(work, 'initramfs.cpio');
sh('python3', [join(root, 'scripts/wasm/cpio-append.py'), join(build, 'kernel/initramfs.bin'), initrd, ...files]);

let output = '';
const marks = new Map<string, number>();
// FAULTS=1: every page is absent until its first touch, brought in after a macrotask, as a lazy
// restore would fetch it; the program parks through JSPI meanwhile
const present = new Set<number>();
let parked = 0;
const pageIn = process.env.FAULTS
	? (page: number, canWait: boolean) => {
			if (present.has(page)) return undefined;
			present.add(page);
			if (!canWait) return undefined;
			parked++;
			return new Promise<void>((r) => setTimeout(r, 0));
		}
	: undefined;
const machine = new Machine({
	vmlinux: new WebAssembly.Module(readFileSync(join(build, 'kernel/vmlinux.wasm'))),
	initrd: new Uint8Array(readFileSync(initrd)),
	cmdline: 'maxcpus=1 root=/dev/ram0 rootfstype=ramfs init=/init console=hvc console=ttyS0',
	registry,
	maximumPages: 4096,
	sha256,
	sharedKernel: true,
	pageIn,
	write: (text) => {
		output += text;
		for (const m of output.matchAll(/@@(\w+)@@/g)) if (!marks.has(m[1]!)) marks.set(m[1]!, performance.now());
	}
});
const run = (until: () => boolean, limit = 600_000) => {
	const started = Date.now();
	return machine.run(
		() => until() || Date.now() - started > limit,
		(ms) => new Promise((r) => setTimeout(r, Math.min(ms, 20)))
	);
};
await run(() => output.includes('# '));
machine.type(`seq 1 400000 > /tmp/in; echo @@$((1+1))ready@@\n`);
await run(() => marks.has('2ready'));

const results: Record<string, Record<string, number[]>> = {};
let id = 0;
for (let round = 0; round < rounds; round++) {
	for (const [name, cmd] of Object.entries(workloads)) {
		const order = round % 2 ? [...arms].reverse() : arms;
		for (const arm of order) {
			const program = arm === 'plain' ? name : `${name}.${arm}`;
			const line = cmd.replace(new RegExp(`^${name}\\b`), program);
			const a = `a${id}`;
			const b = `b${id++}`;
			const sink = process.env.DEBUG ? '2>&1 | tail -3' : '> /tmp/out 2>&1';
			machine.type(`echo @@${a.slice(0, 1)}$((0))${a.slice(1)}@@; ${line} ${sink}; echo @@${b.slice(0, 1)}$((0))${b.slice(1)}@@\n`);
			await run(() => marks.has(`b0${b.slice(1)}`));
			const ms = marks.get(`b0${b.slice(1)}`)! - marks.get(`a0${a.slice(1)}`)!;
			((results[name] ??= {})[arm] ??= []).push(ms);
		}
	}
}
const median = (xs: number[]) => [...xs].sort((x, y) => x - y)[Math.floor(xs.length / 2)]!;
for (const [name, byArm] of Object.entries(results)) {
	const plain = median(byArm.plain!);
	const ratios = Object.fromEntries(
		arms.filter((a) => a !== 'plain').map((a) => [a, +(median(byArm[a]!) / plain).toFixed(3)])
	);
	console.log(JSON.stringify({ workload: name, plainMs: Math.round(plain), ...ratios }));
}
if (process.env.DEBUG) console.log(output.slice(-3000), String((machine.crashed as Error)?.stack ?? machine.crashed));
console.log(JSON.stringify({ mmuMisses: machine.stats.mmuMisses, pageFaults: machine.stats.pageFaults, parked, fuelYields: machine.stats.fuelYields }));
process.exit(0);
