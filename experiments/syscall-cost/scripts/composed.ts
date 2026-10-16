import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * The composed host path's table: V8 CPU profiles of the site's machine (census.ts or serve.ts with SITE=1
 * and CPUPROF/PROFILE) sorted into categories, a sample to the first rule its stack matches from the leaf
 * up. Every busy sample lands in exactly one row, so a column sums to 100.
 *   node --no-warnings --experimental-strip-types composed.ts <dir> <build dir> [cell ...]
 * <dir> holds <cell>-prof-r<n>.cpuprofile with its <cell>-prof-r<n>.json (the rig's last line), and
 * <cell>-boot-r<n>.cpuprofile for the boot; <build dir>/kernel names the kernel module's exports.
 * Wasm frames carry no names in the shipped build, so the kernel module is told from the user modules by the url
 * its `kernelUrl` field records, and its syscall entries by the function indexes of its `wasm_syscall_N` exports.
 */
interface Frame {
	id: number;
	callFrame: { functionName: string; url: string; lineNumber: number };
	children?: number[];
}
interface Profile {
	nodes: Frame[];
	samples: number[];
	timeDeltas: number[];
}

const [dir, build, ...only] = process.argv.slice(2);
if (!dir || !build) throw new Error('usage: composed.ts <dir> <build dir> [cell ...]');
const root = new URL('../../../', import.meta.url).pathname;

// export function indexes of the kernel, from its binary
function exportIndexes(file: string): Map<string, number> {
	const bytes = readFileSync(file);
	let at = 8;
	const leb = () => {
		let result = 0;
		let shift = 0;
		for (;;) {
			const b = bytes[at++]!;
			result |= (b & 0x7f) << shift;
			if (!(b & 0x80)) return result >>> 0;
			shift += 7;
		}
	};
	const out = new Map<string, number>();
	while (at < bytes.length) {
		const id = bytes[at++]!;
		const size = leb();
		const end = at + size;
		if (id === 7) {
			for (let n = leb(); n > 0; n--) {
				const len = leb();
				const name = bytes.subarray(at, at + len).toString('utf8');
				at += len;
				const kind = bytes[at++]!;
				const index = leb();
				if (kind === 0) out.set(name, index);
			}
		}
		at = end;
	}
	return out;
}
const exportsOf = exportIndexes(join(build, 'kernel/vmlinux.async.wasm'));
const syscallEntries = new Set(
	[0, 1, 2, 3, 4, 5, 6].map((n) => exportsOf.get(`wasm_syscall_${n}`)).filter((x) => x !== undefined)
);
const machineSource = readFileSync(join(root, 'src/worker/machine/machine.ts'), 'utf8').split('\n');
// V8's line numbers start at 0
const fuelLine = machineSource.findIndex((l) => l.includes('__gmux_fuel: new WebAssembly.Suspending('));

const PROCESS_START = new Set([
	'Instance', 'Table', 'Global', 'imports', 'customSections', 'instantiateUser', 'userEnv', 'program',
	'recycledProgram', 'enterProgram', 'userChain', 'startTask', 'dlProcess', 'DlProcess', 'stubHash',
	'moduleFacts', 'dylinkInfo', 'boundStack', 'stackLimits', 'retire', 'abandon', 'finished',
	'adoptVforkChild', 'vforkStart', 'wasm_load_executable', 'wasm_release_task', 'leb', 'base', 'decodeUTF8',
	'cstring'
]);
const CONSOLE = new Set(['drainConsole', 'type', 'wasm_driver_hvc_get', 'wasm_driver_hvc_put', 'wasm_console_irq']);
const SCHEDULER = new Set([
	'pump', 'pickIdle', 'park', 'reenter', 'run', 'now', 'exp', 'lookup', 'handleSignal', 'userInterrupt',
	'wasm_cpu_clock_get_monotonic', 'promising', 'Suspending', 'resume', 'task.resume', 'raise', 'view'
]);
const NET = new Set(['next', 'send', 'end', 'listen', 'lend', 'reclaim', 'connect', 'raiseNet']);

export const ROWS = [
	['process start: instantiation leaves', 'profile leaf Instance, Table, Global, imports, customSections, instantiateUser, userEnv'],
	['(program) native leaf, no JS parent (unsplit)', 'profile leaf (program): stack switches and builtins in every cell, plus part of process start in the exec cells; the table notes say how it was split'],
	['process start: exec and exit path in the host', 'profile frames program, enterProgram, userChain, startTask, dlProcess, retire, abandon, load_executable, release_task'],
	['kernel under a syscall', 'vmlinux leaf with a wasm_syscall_N export frame on its stack'],
	['kernel outside syscalls', 'vmlinux leaf with none (interrupts, idle loops, ret_from_fork, scheduler)'],
	['scheduler in the host: pump, park, pickIdle, clock, signals', 'profile frames pump, pickIdle, park, reenter, handleSignal, clock import'],
	['guest CPU: user wasm self time', 'profile leaf in a module that is not the kernel (BusyBox, Katybug; the fuel check is inside it)'],
	['fuel: the __gmux_fuel import', 'profile frame at the Suspending callback of __gmux_fuel (its resume is counted under scheduler)'],
	['hvc and input: console ring', 'profile frames drainConsole, type, the hvc imports'],
	['watch and cache: router hook', 'no sample is attributable; hook calls come from the counts table (sync calls only at the watch route)'],
	['send and copy: ingress imports and events', 'profile frames in ingress.ts and raiseNet'],
	['async persistence: syncFile, keeper', 'not on the profiled path; the counts table has fileSyncs and one checkpoint'],
	['garbage collector', 'profile leaf (garbage collector)'],
	['harness: rig code and Node runtime', 'profile frames in serve.ts, census.ts and node internals'],
	['unattributed rest', 'every other sample (the top frames are listed below the table)']
] as const;

function classify(chain: Frame[], kernelUrl: string): number {
	const leaf = chain[0]!;
	const name = leaf.callFrame.functionName;
	if (name === '(idle)') return -1;
	if (name === '(garbage collector)') return 12;
	if (name === '(program)') return 1;
	if (leaf.callFrame.url.startsWith('wasm://')) {
		if (leaf.callFrame.url !== kernelUrl) return 6;
		const entry = chain.some((f) => {
			if (f.callFrame.url !== kernelUrl) return false;
			const m = /wasm-function\[(\d+)\]/.exec(f.callFrame.functionName);
			return m && syscallEntries.has(Number(m[1]));
		});
		return entry ? 3 : 4;
	}
	for (const f of chain) {
		const { functionName: fn, url, lineNumber } = f.callFrame;
		if (url.endsWith('/machine.ts') && fn === '' && lineNumber === fuelLine) return 7;
		if (url.endsWith('/ingress.ts') || fn === 'raiseNet' || (NET.has(fn) && url.endsWith('/machine.ts'))) return 10;
		if (['Instance', 'Table', 'Global', 'imports', 'customSections', 'instantiateUser', 'userEnv'].includes(fn)) return 0;
		if (PROCESS_START.has(fn)) return 2;
		if (CONSOLE.has(fn)) return 8;
		if (SCHEDULER.has(fn)) return 5;
		if (/\/(serve|census|cost|exec-split)\.ts$/.test(url) || url.startsWith('node:') || fn === '(root)')
			return 13;
	}
	return 14;
}

interface Run {
	busy: number;
	busyMs: number;
	rows: number[];
	top: Map<string, number>;
	sidecar: Record<string, any>;
}

function readRun(file: string, sidecar: Record<string, any>): Run {
	const profile: Profile = JSON.parse(readFileSync(file, 'utf8'));
	const byId = new Map(profile.nodes.map((n) => [n.id, n]));
	const parent = new Map<number, number>();
	for (const n of profile.nodes) for (const c of n.children ?? []) parent.set(c, n.id);
	const kernelUrl = String(sidecar.kernelUrl ?? '');
	const rows = new Array<number>(ROWS.length).fill(0);
	const top = new Map<string, number>();
	let busy = 0;
	let busyMs = 0;
	profile.samples.forEach((id, i) => {
		const chain: Frame[] = [];
		for (let at: number | undefined = id; at !== undefined; at = parent.get(at)) chain.push(byId.get(at)!);
		const row = classify(chain, kernelUrl);
		if (row < 0) return;
		busy++;
		busyMs += (profile.timeDeltas[i] ?? 0) / 1000;
		rows[row]!++;
		if (row === 14) {
			const f = chain[0]!.callFrame;
			const key = `${f.functionName || '(anonymous)'} ${f.url.split('/').slice(-1)[0] ?? ''}`;
			top.set(key, (top.get(key) ?? 0) + 1);
		}
	});
	return { busy, busyMs, rows, top, sidecar };
}

const stat = (xs: number[]) => {
	const mean = xs.reduce((a, b) => a + b, 0) / xs.length;
	return { mean, min: Math.min(...xs), max: Math.max(...xs) };
};
const fmt = (xs: number[], digits = 1) => {
	const s = stat(xs);
	return `${s.mean.toFixed(digits)} (${s.min.toFixed(digits)}-${s.max.toFixed(digits)})`;
};

const files = readdirSync(dir);
const cells = [...new Set(files.filter((f) => /-prof-r\d+\.cpuprofile$/.test(f)).map((f) => f.replace(/-prof-r\d+\.cpuprofile$/, '')))]
	.filter((c) => !only.length || only.includes(c))
	.sort();
for (const cell of cells) {
	const runs: Run[] = [];
	for (const f of files.filter((x) => x.startsWith(`${cell}-prof-r`) && x.endsWith('.cpuprofile')).sort()) {
		const sidecar = JSON.parse(
			readFileSync(join(dir, f.replace('.cpuprofile', '.json')), 'utf8').trim().split('\n').at(-1)!
		);
		runs.push(readRun(join(dir, f), sidecar));
	}
	// a unit is a request (serving) or a thousand processes (configure)
	const unit = (r: Run) =>
		r.sidecar.rounds ? Number(r.sidecar.rounds) : Number(r.sidecar.programs ?? 1) / 1000;
	const unitName = runs[0]!.sidecar.rounds ? 'request' : '1,000 processes';
	console.log(`\n### ${cell} (${runs.length} runs; unit ${unitName})\n`);
	console.log(
		`busy samples ${fmt(runs.map((r) => r.busy), 0)}; main-thread busy ms per ${unitName} ${fmt(runs.map((r) => r.busyMs / unit(r)), 3)}\n`
	);
	console.log(`| row | instrument | percent of busy samples | ms per ${unitName} |\n| --- | --- | --- | --- |`);
	ROWS.forEach(([name, how], i) => {
		console.log(
			`| ${name} | ${how} | ${fmt(runs.map((r) => (100 * r.rows[i]!) / r.busy), 1)} | ${fmt(runs.map((r) => (r.busyMs * r.rows[i]!) / r.busy / unit(r)), 3)} |`
		);
	});
	const sums = runs.map((r) => r.rows.reduce((a, b) => a + b, 0) === r.busy);
	console.log(`\ncolumn sums to busy samples in every run: ${sums.every(Boolean)}`);
	const top = new Map<string, number>();
	for (const r of runs) for (const [k, v] of r.top) top.set(k, (top.get(k) ?? 0) + v);
	console.log(
		`top unattributed frames (all runs): ${[...top].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([k, v]) => `${k} ${v}`).join('; ') || 'none'}`
	);
	const bootWall = runs.map((r) => Number(r.sidecar.boot?.wallMs)).filter(Number.isFinite);
	const bootCpu = runs.map((r) => Number(r.sidecar.boot?.cpuMs)).filter(Number.isFinite);
	if (bootWall.length) console.log(`boot to the ready prompt: wall ${fmt(bootWall)} ms, CPU ${fmt(bootCpu)} ms`);
	// counts and timers: other instruments than the profile, each in its own units
	const stats = (key: string) =>
		runs.map((r) =>
			r.sidecar.statsPerRequest
				? Number(r.sidecar.statsPerRequest[key] ?? 0)
				: Number(r.sidecar.stats?.[key] ?? 0) / unit(r)
		);
	console.log(`\ncounts per ${unitName} (the machine's own counters, profiled runs):\n`);
	console.log('| counter | per unit |\n| --- | --- |');
	for (const key of ['fuelYields', 'userExecs', 'switches', 'idles', 'pumpSteps', 'consoleDrains', 'consoleDrainBytes', 'fileSyncs', 'syncWalks', 'netEvents', 'netSends', 'netBytesOut', 'netBorrowed', 'statxHits'])
		console.log(`| ${key} | ${fmt(stats(key), 3)} |`);
	const persisted = runs.map((r) => r.sidecar.persist).filter((p) => p?.checkpointCpuMs !== undefined);
	if (persisted.length)
		console.log(
			`\ncheckpoint (one, after the run, written as the keeper writes it): CPU ${fmt(persisted.map((p) => p.checkpointCpuMs))} ms, wall ${fmt(persisted.map((p) => p.checkpointWallMs))} ms, ${fmt(persisted.map((p) => p.changed), 0)} pages changed, interval the cadence picks after it ${fmt(persisted.map((p) => p.intervalMs), 0)} ms; amortised (one checkpoint per interval of machine time) ${fmt(persisted.map((p) => (100 * p.checkpointCpuMs) / p.intervalMs), 2)} percent of CPU; file syncs in the run ${fmt(runs.map((r) => Number(r.sidecar.persist?.fileSyncs ?? 0)), 0)}`
		);
	const timed = files.filter((x) => x.startsWith(`${cell}-imports-r`) && x.endsWith('.json')).sort();
	if (timed.length) {
		const rowsOf = timed.map((f) => {
			const s = JSON.parse(readFileSync(join(dir, f), 'utf8').trim().split('\n').at(-1)!);
			const u = s.rounds ? Number(s.rounds) : Number(s.programs ?? 1) / 1000;
			const m: Record<string, { us: number; calls: number }> = s.importsPerRequest ?? s.imports ?? {};
			const scale = s.rounds ? 1 : 1 / u;
			return Object.fromEntries(Object.entries(m).map(([k, v]) => [k, { us: v.us * scale, calls: v.calls * scale }]));
		});
		const names = [...new Set(rowsOf.flatMap((r) => Object.keys(r)))];
		const busyUnit = stat(runs.map((r) => r.busyMs / unit(r))).mean;
		console.log(`\ntimers around each plain kernel import (IMPORTS=1 runs, ${timed.length}; the timer's own cost sits inside each):\n`);
		console.log(`| import | calls per ${unitName} | us per ${unitName} | percent of main-thread busy ms |\n| --- | --- | --- | --- |`);
		for (const n of names.sort())
			console.log(
				`| ${n} | ${fmt(rowsOf.map((r) => r[n]?.calls ?? 0), 1)} | ${fmt(rowsOf.map((r) => r[n]?.us ?? 0), 1)} | ${fmt(rowsOf.map((r) => (100 * (r[n]?.us ?? 0)) / 1000 / busyUnit), 2)} |`
			);
	}
	// the plain arm: process CPU per unit with no profiler or timers; a sample whose quiet reading is above 0.5 is smoke
	const plain = files.filter((x) => x.startsWith(`${cell}-plain-r`) && x.endsWith('.json')).sort();
	if (plain.length) {
		const rows = plain.map((f) => {
			const s = JSON.parse(readFileSync(join(dir, f), 'utf8').trim().split('\n').at(-1)!);
			const q = Number(readFileSync(join(dir, f.replace('.json', '.quiet')), 'utf8').trim().split(/\s+/)[1]);
			const u = s.rounds ? 1 : Number(s.programs ?? 1) / 1000;
			return { cpu: s.rounds ? Number(s.cpuMs.mean) : Number(s.cpuMs) / u, wall: s.rounds ? Number(s.wallMs.mean) : Number(s.wallMs) / u, q };
		});
		const good = rows.filter((r) => r.q <= 0.5);
		console.log(
			`\nplain arm, process CPU ms per ${unitName} (no profiler, no timers): all ${rows.length} samples ${fmt(rows.map((r) => r.cpu), 3)}; quiet <= 0.5 ${good.length} samples ${good.length ? fmt(good.map((r) => r.cpu), 3) : 'none'}; wall ${fmt(rows.map((r) => r.wall), 3)}; quiet readings ${rows.map((r) => r.q).join(', ')}`
		);
		const server = /^(httpd|lighttpd)-(small|big)$/.exec(cell);
		if (process.env.NATIVE && server) {
			const size = server[2] === 'small' ? '1k' : 'big';
			const native = readFileSync(process.env.NATIVE, 'utf8')
				.trim()
				.split('\n')
				.map((l) => JSON.parse(l))
				.filter((r) => r.server === server[1] && r.size === size);
			const ms = native.map((r) => Number(r.msPerRequest));
			const clean = native.filter((r) => Number(r.quiet) <= 0.5).map((r) => Number(r.msPerRequest));
			console.log(
				`native ${server[1]} (capped container, cgroup CPU per request, ${native.length} runs): ${fmt(ms, 4)} ms; quiet <= 0.5 ${clean.length} runs; machine over native (means) ${(stat(rows.map((r) => r.cpu)).mean / stat(ms).mean).toFixed(1)}x`
			);
		}
	}
	const boots = files
		.filter((x) => x.startsWith(`${cell}-boot-r`) && x.endsWith('.cpuprofile'))
		.sort()
		.map((f) =>
			readRun(
				join(dir, f),
				JSON.parse(readFileSync(join(dir, f.replace('-boot-', '-prof-').replace('.cpuprofile', '.json')), 'utf8').trim().split('\n').at(-1)!)
			)
		);
	if (boots.length) {
		console.log(`\nboot window (machine creation to the prompt), percent of busy samples, ${boots.length} runs; busy samples ${fmt(boots.map((r) => r.busy), 0)}\n`);
		console.log('| row | percent of busy samples |\n| --- | --- |');
		ROWS.forEach(([name], i) => {
			if (boots.some((r) => r.rows[i]))
				console.log(`| ${name} | ${fmt(boots.map((r) => (100 * r.rows[i]!) / r.busy), 1)} |`);
		});
	}
}
