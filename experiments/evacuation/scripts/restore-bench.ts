import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { appendCpio } from '../../../scripts/wasm/cpio-append.ts';
import { Machine, type MachineOptions } from '../../../src/worker/machine/machine.ts';

/**
 * a census program's speed after a restore: each evacuable arm is checkpointed at the fuel yield
 * where AT (default 0.3) of the plain run's yields have passed, restored, and timed from the restore
 * to the end; the plain and the evacuable builds are timed uninterrupted from the same yield. warm
 * restores into the modules the run already used, cold into freshly compiled ones (as a new
 * isolate would), against a plain run on freshly compiled bytes. ARMS picks the evacuate.ts flags
 * (resume, fold; several joined by +, resume+try-sites), ONLY the programs, REENTER=ms the cold restores' `reenterAfterRestore`. Ratios are
 * medians over rounds against plain from the same yield, warm or cold. Every run's output is checked
 * against the plain run's.
 * `node --experimental-strip-types experiments/evacuation/scripts/restore-bench.ts <census dir> [rounds]`
 */
const root = new URL('../../../', import.meta.url).pathname;
const census = process.argv[2] ?? '';
const rounds = Number(process.argv[3] ?? 3);
const at = Number(process.env.AT ?? 0.3);
// WORK=<dir>: reuse what an earlier run built there, so a machine without the toolchain can time it
const work = process.env.WORK ?? join(tmpdir(), `gmux-restore-${process.pid}`);
const built = (file: string) => !!process.env.WORK && existsSync(file);
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
const workloads = Object.entries(all).filter(([k]) => !pick.length || pick.includes(k));
const arms = (process.env.ARMS ?? 'resume,fold').split(',');
// EVACUATE: another evacuate.ts, to compare two versions of it
const evacuate = process.env.EVACUATE ?? join(root, 'experiments/evacuation/scripts/evacuate.ts');
const reenter = process.env.REENTER === undefined ? undefined : Number(process.env.REENTER);
/** the bytes with a custom section naming `tag`, so V8 compiles them afresh */
function tagged(bytes: Uint8Array, tag: string): Uint8Array {
	const name = new TextEncoder().encode('gmux.arm');
	const payload = new TextEncoder().encode(tag);
	const body = [name.length, ...name, ...payload];
	return new Uint8Array([...bytes, 0, body.length, ...body]);
}
const build = process.env.GMUX_BUILD ?? join(root, 'build');
const kernel = (f: string) => join(build, 'kernel', f);
const manifest = JSON.parse(readFileSync(kernel('manifest.json'), 'utf8'));
const median = (xs: number[]) => [...xs].sort((x, y) => x - y)[Math.floor(xs.length / 2)]!;
const debug = (text: string) => process.env.DEBUG && console.error(text);
// SPLIT=1 adds constructMs and instantiateMs (medians over the cold restores) to the output
const split = !!process.env.SPLIT;
let coldModule: WebAssembly.Module | undefined;
let instantiated = 0;
if (split) {
	const Instance = WebAssembly.Instance;
	WebAssembly.Instance = class extends Instance {
		constructor(module: WebAssembly.Module, imports?: WebAssembly.Imports) {
			const t = performance.now();
			super(module, imports);
			if (module === coldModule) instantiated += performance.now() - t;
		}
	};
}

let fresh = 0;
for (const [name, cmd] of workloads) {
	const plain = join(census, `${name}.wasm`);
	const fueled = join(work, `${name}.fuel.wasm`);
	if (!built(`${fueled}.g`)) {
		sh(join(root, 'scripts/wasm/instrument.sh'), [plain, fueled]);
		sh(join(root, 'scripts/ts'), [join(root, 'scripts/wasm/export-globals.ts'), fueled, `${fueled}.g`, '--all-mutable']);
	}
	// the file the kernel loads keeps each arm's own hash; the host runs the rewritten bytes
	const programs: { arm: string; image: string; hash: string; bytes: Uint8Array }[] = [];
	for (const arm of ['plain', ...arms]) {
		const image = join(work, `${name}.${arm}.image.wasm`);
		writeFileSync(image, arm === 'plain' ? readFileSync(plain) : tagged(readFileSync(plain), arm));
		const out = join(work, `${name}.${arm}.wasm`);
		if (arm === 'plain') writeFileSync(out, readFileSync(fueled));
		else if (!built(out)) sh('node', [evacuate, `${fueled}.g`, out, ...arm.split('+').map((flag) => `--${flag}`)]);
		programs.push({ arm, image, hash: sha256(readFileSync(image)), bytes: new Uint8Array(readFileSync(out)) });
	}
	const registry = new Map<string, WebAssembly.Module>([[manifest.busybox, new WebAssembly.Module(readFileSync(kernel('busybox.async.wasm')))]]);
	for (const p of programs) registry.set(p.hash, new WebAssembly.Module(p.bytes));
	const warm = new Map(registry);
	const initrd = join(work, `${name}.cpio`);
	appendCpio(kernel('initramfs.bin'), initrd, programs.map((p) => `/bin/${p.arm === 'plain' ? name : `${name}.${p.arm}`}=${p.image}`));

	let output = '';
	const marks = new Map<string, number>();
	const options: MachineOptions = {
		vmlinux: new WebAssembly.Module(readFileSync(kernel('vmlinux.async.wasm'))),
		initrd: new Uint8Array(readFileSync(initrd)),
		cmdline: 'maxcpus=1 root=/dev/ram0 rootfstype=ramfs init=/init console=hvc console=ttyS0',
		registry,
		maximumPages: 4096,
		sha256,
		sharedKernel: true,
		asyncify: true,
		write: (text) => {
			output += text;
			for (const m of output.matchAll(/@@(\w+)@@/g)) if (!marks.has(m[1]!)) marks.set(m[1]!, performance.now());
		}
	};
	let machine = new Machine(options);
	const limit = Number(process.env.LIMIT ?? 600_000);
	const run = async (until: () => boolean) => {
		const started = Date.now();
		await machine.run(
			() => until() || Date.now() - started > limit || !!machine.crashed,
			(ms) => new Promise((r) => setTimeout(r, Math.min(ms, 20)))
		);
		if (!until()) throw new Error(`${name}: stalled ${machine.crashed ?? ''}\n${output.slice(-600)}`);
	};
	await run(() => output.includes('# '));
	debug(`${name}: booted`);
	machine.type(`seq 1 400000 > /tmp/in; echo @@$((1+1))ready@@\n`);
	await run(() => marks.has('2ready'));
	debug(`${name}: ready`);

	let id = 0;
	let expected = '';
	/** types the workload under `arm`: its end is mark b, and a checksum of its output follows */
	const start = (arm: string) => {
		const program = arm === 'plain' ? name : `${name}.${arm}`;
		// the marks are split in the typed line, so its echo does not match them
		const n = id++;
		machine.type(`${cmd.replace(new RegExp(`^${name}\\b`), program)} > /tmp/out 2>&1; echo @@b$((0))${n}@@; cksum < /tmp/out; echo @@c$((0))${n}@@\n`);
		return { b: `b0${n}`, n, from: machine.stats.fuelYields };
	};
	/** waits for the checksum of run n and checks it against the first plain run's */
	const check = async (arm: string, n: number) => {
		await run(() => marks.has(`c0${n}`));
		const sum = output.slice(output.indexOf(`@@b0${n}@@`) + `@@b0${n}@@`.length, output.indexOf(`@@c0${n}@@`)).trim();
		expected ||= sum;
		if (!sum || sum !== expected) throw new Error(`${name} ${arm}: output checksum ${sum} against ${expected}`);
	};
	const time = async (arm: string, k: number) => {
		const { b, n, from } = start(arm);
		let yieldAt = NaN;
		await run(() => {
			if (Number.isNaN(yieldAt) && machine.stats.fuelYields - from >= k) yieldAt = performance.now();
			return marks.has(b);
		});
		const yields = machine.stats.fuelYields - from;
		debug(`${name} ${arm}: ${yields} yields, ${Math.round(marks.get(b)! - yieldAt)} ms from yield ${k}`);
		const rest = marks.get(b)! - yieldAt;
		await check(arm, n);
		return { rest, yields };
	};
	/** runs `arm` to the k-th yield, checkpoints and restores (cold: into fresh modules), then times the rest */
	const restored = async (arm: string, k: number, cold: boolean) => {
		const { b, n, from } = start(arm);
		await run(() => machine.stats.fuelYields - from >= k || marks.has(b));
		if (marks.has(b)) throw new Error(`${name} ${arm}: finished before yield ${k}`);
		debug(`${name} ${arm}: checkpoint at yield ${machine.stats.fuelYields - from}`);
		const snapshot = await machine.checkpoint();
		const p = programs.find((x) => x.arm === arm)!;
		if (!snapshot.runners.some((r) => r.user?.hash === p.hash)) throw new Error(`${name} ${arm}: not running at the checkpoint`);
		if (cold) {
			const bytes = tagged(p.bytes, `cold${fresh++}`);
			const t0 = performance.now();
			coldModule = new WebAssembly.Module(bytes);
			if (split) push(`${arm}Construct`, performance.now() - t0);
			instantiated = 0;
			registry.set(p.hash, coldModule);
		}
		const into = cold && reenter !== undefined ? { ...options, reenterAfterRestore: reenter } : options;
		debug(`${name} ${arm}: checkpointed, restoring`);
		machine = await Machine.restore(into, { ...snapshot, memory: snapshot.memory.slice() });
		debug(`${name} ${arm}: restored`);
		const t = performance.now();
		await run(() => marks.has(b));
		registry.set(p.hash, warm.get(p.hash)!);
		if (!marks.has(b)) throw new Error(`${name} ${arm}: no end after the restore ${machine.crashed ?? ''}`);
		if (reenter !== undefined) debug(`${name} ${arm}: ${machine.stats.reentries} re-entries`);
		const rest = marks.get(b)! - t;
		if (split && cold) push(`${arm}Instantiate`, instantiated);
		await check(`${arm} restored`, n);
		return rest;
	};

	const total = (await time('plain', 0)).yields;
	const k = Math.max(1, Math.floor(total * at));
	const results: Record<string, number[]> = {};
	const push = (key: string, v: number) => (results[key] ??= []).push(v);
	for (let round = 0; round < rounds; round++) {
		push('plain', (await time('plain', k)).rest);
		const plainHash = programs[0]!.hash;
		registry.set(plainHash, new WebAssembly.Module(tagged(programs[0]!.bytes, `cold${fresh++}`)));
		push('plainCold', (await time('plain', k)).rest);
		registry.set(plainHash, warm.get(plainHash)!);
		for (const arm of round % 2 ? [...arms].reverse() : arms) {
			push(arm, (await time(arm, k)).rest);
			push(`${arm}Warm`, await restored(arm, k, false));
			push(`${arm}Cold`, await restored(arm, k, true));
		}
	}
	const base = median(results.plain!);
	const cold = median(results.plainCold!);
	const r: Record<string, number> = {};
	for (const arm of arms) {
		r[arm] = +(median(results[arm]!) / base).toFixed(3);
		r[`${arm}Warm`] = +(median(results[`${arm}Warm`]!) / base).toFixed(3);
		r[`${arm}Cold`] = +(median(results[`${arm}Cold`]!) / cold).toFixed(3);
		if (split)
			for (const key of ['', 'Warm', 'Cold', 'Construct', 'Instantiate']) {
				const xs = [...results[`${arm}${key}`]!].sort((x, y) => x - y);
				r[`${arm}${key}Ms`] = +median(xs).toFixed(1);
				r[`${arm}${key}Min`] = +xs[0]!.toFixed(1);
				r[`${arm}${key}Max`] = +xs[xs.length - 1]!.toFixed(1);
			}
	}
	if (split)
		for (const key of ['plain', 'plainCold']) {
			const xs = [...results[key]!].sort((x, y) => x - y);
			r[`${key}Min`] = +xs[0]!.toFixed(1);
			r[`${key}Max`] = +xs[xs.length - 1]!.toFixed(1);
		}
	console.log(JSON.stringify({ workload: name, yields: total, at: k, plainRestMs: Math.round(base), plainColdRestMs: Math.round(cold), ...r }));
}
process.exit(0);
