import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { dispatchWat, entriesOf, linkRung, openRung, type Rung } from './link.ts';
import { createVm } from './vm.ts';

const here = dirname(new URL(import.meta.url).pathname);
const ladder = join(here, '../../promotion-ladder/scripts/ladder.ts');
const node = [process.execPath, '--no-warnings', '--experimental-strip-types'];
const wasmTools = (args: string[], input?: string) => execFileSync('wasm-tools', args, { input, maxBuffer: 1 << 28 });

export interface Check {
	name: string;
	ok: boolean;
	detail: string;
}

/** assembles a toy and prepares its rungs with the given sets (open: the promoted set need not be closed under calls) */
export function prepareToy(source: string, out: string, sets: Record<string, string[]>, nativeEnd = true, extraEnv: Record<string, string> = {}) {
	mkdirSync(out, { recursive: true });
	const wasm = join(out, 'guest.wasm');
	writeFileSync(wasm, wasmTools(['parse', source, '-o', '/dev/stdout']));
	writeFileSync(join(out, 'sets.json'), JSON.stringify(sets));
	execFileSync(node[0]!, [...node.slice(1), ladder, 'prepare', wasm, join(out, 'rungs'), join(out, 'sets.json')], {
		env: { ...process.env, LADDER_OPEN: '1', LADDER_NATIVE_END: nativeEnd ? '1' : '0', ...extraEnv },
		stdio: ['ignore', 'ignore', 'inherit']
	});
	return JSON.parse(readFileSync(join(out, 'rungs', 'rungs.json'), 'utf8')) as { rungs: (Rung & { label: string })[] };
}

/** the rung's dispatcher assembled, which a host without wasm-tools cannot do for itself */
const dispatcherBytes = (rung: Rung) => new Uint8Array(wasmTools(['parse', '-o', '/dev/stdout'], dispatchWat(entriesOf(rung), true)));

const v8 = (wasm: string) => new WebAssembly.Instance(new WebAssembly.Module(readFileSync(wasm))).exports as Record<string, (...a: number[]) => number> & { memory: WebAssembly.Memory };
const same = (name: string, got: number, want: number): Check => ({ name, ok: (got | 0) === (want | 0), detail: `${got | 0} against v8 ${want | 0}` });

/**
 * The toy: a promoted function calls an interpreted one that calls a promoted one again (to depth 1,000), callbacks through
 * a table both ways, and a trap in an interpreted callee. Every answer is compared with V8 running the unsplit module.
 */
export async function runToy(wasm3: string, dir: string, mode: 'glued' | 'direct', depth = 1000): Promise<Check[]> {
	const { rungs } = JSON.parse(readFileSync(join(dir, 'rungs', 'rungs.json'), 'utf8')) as { rungs: (Rung & { label: string })[] };
	const mixed = rungs.find((r) => r.label === 'mixed')!;
	const { vm, linked } = await openRung(wasm3, join(dir, 'rungs'), mixed, mode, mode === 'direct' ? dispatcherBytes(mixed) : undefined);
	const g = linked.guest;
	const ref = v8(join(dir, 'guest.wasm'));
	const checks: Check[] = [];
	const attempt = (name: string, f: () => Check) => {
		try {
			checks.push(f());
		} catch (e) {
			checks.push({ name, ok: false, detail: `threw ${String(e).slice(0, 120)}` });
		}
	};
	const both = (name: string, fn: string, ...args: number[]) => attempt(name, () => same(name, g.call(fn, ...args), ref[fn]!(...args)));

	both('nested entry: hotA(3, 5)', 'hotA', 3, 5);
	both('nested entry: coldB(4, 9)', 'coldB', 4, 9);
	both(`mixed recursion depth ${depth} from the promoted side`, 'hotA', depth, 7);
	both(`mixed recursion depth ${depth} from the interpreted side`, 'coldB', depth, 7);
	both(`mixed recursion depth ${depth + 1}`, 'hotA', depth + 1, 3);
	both('table: promoted calls the promoted entry', 'viaTab', 0, 6);
	both('table: promoted calls the interpreted entry', 'viaTab', 1, 6);
	both('table: interpreted calls the promoted entry', 'viaTabC', 0, 9);
	both('table: interpreted calls the interpreted entry', 'viaTabC', 1, 9);
	attempt('guest memory counter equals v8', () => same('counter', new DataView((vm.guest ?? vm.shim.memory).buffer).getInt32(g.memory().base + 256, true), new DataView(ref.memory.buffer).getInt32(256, true)));
	both('run(40)', 'run', 40);

	attempt('trap in an interpreted callee', () => {
		let text = '';
		try {
			g.call('callTrap', 0);
		} catch (e) {
			text = String(e);
		}
		return { name: 'trap', ok: /integer divide by zero/.test(text), detail: text.slice(0, 120) };
	});
	attempt('after the trap: stack base is the origin', () => {
		const room = vm.stackState(g.index, 0);
		const limit = vm.stackState(g.index, 1);
		return { name: 'stack', ok: room > 0 && room === limit, detail: `room ${room} slots, limit ${limit} slots` };
	});
	both('after the trap: callTrap(4)', 'callTrap', 4);
	both(`after the trap: mixed recursion depth ${depth}`, 'hotA', depth, 11);
	both('after the trap: run(25)', 'run', 25);
	attempt('after the trap: guest memory counter equals v8', () => same('counter', new DataView((vm.guest ?? vm.shim.memory).buffer).getInt32(g.memory().base + 256, true), new DataView(ref.memory.buffer).getInt32(256, true)));
	return checks;
}

/** memory grows inside a nested call: the interpreter's stack limit must stay at the end of its buffer */
export async function runGrow(wasm3: string, dir: string): Promise<Check[]> {
	const { rungs } = JSON.parse(readFileSync(join(dir, 'rungs', 'rungs.json'), 'utf8')) as { rungs: (Rung & { label: string })[] };
	const mixed = rungs.find((r) => r.label === 'mixed')!;
	const vm = await createVm(wasm3);
	let live = -1;
	let index = -1;
	let room = 0;
	// read just before the nested entry: the live frame's offset is what an unfixed resize would add to the limit
	const linked = linkRung(vm, join(dir, 'rungs'), mixed, { jsUp: true, beforeUp: () => (live = room - vm.stackState(index, 0)) });
	const g = linked.guest;
	index = g.index;
	room = vm.stackState(index, 0);
	const before = { room, limit: vm.stackState(g.index, 1), base: g.memory().base };
	const old = g.call('callGrow', 1);
	const after = { room: vm.stackState(g.index, 0), limit: vm.stackState(g.index, 1), base: g.memory().base, size: g.memory().size };
	return [
		{ name: 'grow returns the old page count', ok: old === 1, detail: `${old}` },
		{ name: 'memory is two pages', ok: after.size === 131072, detail: `${after.size} bytes` },
		{ name: 'stack limit stays at the buffer end after a resize under a host call', ok: after.limit === before.room && after.room === before.room, detail: `limit ${after.limit}, room ${after.room}, expected ${before.room}; live frame offset at the call ${live}; the guest's memory base ${before.base === after.base ? 'did not move' : `moved ${before.base} to ${after.base}`}` }
	];
}

export type Step = [fn: string, ...args: number[]];

/** the promoted functions of toy-mem.wat: every n_* and the native caller of the interpreter */
export const memSets = { mixed: ['n_size', 'n_grow', 'n_ld8', 'n_ld32', 'n_ld32off', 'n_st8', 'n_st32', 'n_copy', 'n_fill', 'nCallI'] };

const PAGE = 65536;

/** what toy-mem.wat's scenarios do, as steps over exports; `native` steps call a function the test promoted */
export const memScenarios: { name: string; steps: Step[] }[] = [
	{ name: 'zero growth', steps: [['n_grow', 0], ['i_grow', 0], ['n_size'], ['i_size'], ['i_st32', 8, 5], ['n_ld32', 8], ['n_st32', 12, 6], ['i_ld32', 12]] },
	{ name: 'interpreter growth, then native reads and writes the new pages', steps: [['i_grow', 2], ['n_st32', PAGE + 8, 123], ['i_ld32', PAGE + 8], ['n_ld32', 2 * PAGE + 16], ['n_st8', 3 * PAGE - 1, 9], ['i_ld8', 3 * PAGE - 1], ['n_size']] },
	{ name: 'native growth, then the interpreter reads', steps: [['n_grow', 1], ['i_st32', PAGE + 4, 9], ['i_ld32', PAGE + 4], ['n_ld32', PAGE + 4], ['i_ld8', 2 * PAGE - 1]] },
	{ name: 'native growth, then the interpreter asks the size', steps: [['n_grow', 2], ['i_size'], ['i_grow', 1], ['n_size']] },
	{ name: 'native to interpreter to grow to native return', steps: [['nCallI', 1], ['n_ld32', PAGE], ['i_size'], ['nCallI', 1], ['n_size']] },
	{ name: 'interpreter to native to grow to interpreter return', steps: [['iCallN', 1], ['i_ld32', PAGE], ['n_size'], ['iCallN', 1], ['i_size']] },
	{ name: 'a grow past the declared maximum fails in both tiers', steps: [['i_grow', 2], ['n_grow', 2], ['i_grow', 2], ['n_size'], ['n_grow', 1], ['i_grow', 1], ['i_size'], ['n_grow', 0]] },
	{ name: 'accesses at the end of memory, in both tiers', steps: [['i_grow', 1], ['i_ld32', 2 * PAGE - 4], ['n_ld32', 2 * PAGE - 4], ['i_ld32', 2 * PAGE - 3], ['n_ld32', 2 * PAGE - 3], ['i_ld8', 2 * PAGE - 1], ['n_ld8', 2 * PAGE - 1], ['i_ld8', 2 * PAGE], ['n_ld8', 2 * PAGE], ['i_st32', 2 * PAGE - 4, 5], ['n_st32', 2 * PAGE - 3, 1], ['i_st32', 2 * PAGE - 3, 1], ['n_st8', 2 * PAGE, 1], ['i_st8', 2 * PAGE, 1], ['n_ld32', 2 * PAGE - 4]] },
	{ name: 'an address plus an offset past 2^32 traps in both tiers', steps: [['i_ld32off', 8], ['n_ld32off', 8], ['i_ld32off', 0], ['n_ld32off', 0], ['i_ld32', -1], ['n_ld32', -1], ['i_ld32off', -4], ['n_ld32off', -4]] },
	{ name: 'overlapping copies and fills, both directions', steps: [['i_st32', 200, 0x04030201], ['i_st32', 204, 0x08070605], ['i_copy', 202, 200, 8], ['n_copy', 198, 200, 8], ['n_copy', 300, 200, 8], ['n_copy', 201, 200, 11], ['i_copy', 200, 201, 11], ['i_fill', 400, 0xab, 33], ['n_fill', 405, 0xcd, 17], ['i_copy', PAGE - 4, 0, 8], ['n_copy', PAGE - 4, 0, 8], ['n_copy', 0, PAGE - 4, 8], ['i_fill', PAGE, 1, 0], ['n_fill', PAGE + 1, 1, 0], ['i_fill', PAGE - 2, 7, 3]] },
	{ name: 'an active data segment', steps: [['i_ld32', 100], ['n_ld32', 100], ['i_ld8', 107], ['n_ld8', 107], ['n_ld32', 104], ['i_ld32', 108]] },
	{ name: 'a trap in the interpreter leaves the native view intact', steps: [['n_st32', 500, 11], ['i_ld32', -8], ['n_ld32', 500], ['n_st32', 504, 12], ['i_ld32', 504], ['i_grow', 1], ['n_size']] },
	{ name: 'a trap in native code leaves the interpreter view intact', steps: [['i_st32', 500, 21], ['n_ld32', -8], ['i_ld32', 500], ['i_st32', 504, 22], ['n_ld32', 504], ['n_grow', 1], ['i_size']] }
];

type Outcome = { v: number } | { trap: string };

/**
 * toy-mem.wat's scenarios over a rung of the guest memory build against V8 on the unsplit module (`refMax` pages instead of the
 * declared 4 when the test caps the interpreter's memory with maxMemoryBytes): every step's answer or trap, then the size and every byte.
 * The cases whose names start with "native growth" and "native called from JavaScript" have native code grow memory behind the
 * interpreter's back; the last one has JavaScript call a native export itself.
 */
export async function runMemory(wasm3: string, dir: string, mode: 'glued' | 'direct', options: { memoryLimitPages?: number; refMax?: number; only?: string[] } = {}): Promise<Check[]> {
	const { rungs } = JSON.parse(readFileSync(join(dir, 'rungs', 'rungs.json'), 'utf8')) as { rungs: (Rung & { label: string })[] };
	const mixed = rungs.find((r) => r.label === 'mixed')!;
	const source = readFileSync(join(here, '../toy-mem.wat'), 'utf8').replace('(memory (export "memory") 1 4)', `(memory (export "memory") 1 ${options.refMax ?? 4})`);
	const refBytes = new Uint8Array(wasmTools(['parse', '-o', '/dev/stdout'], source));
	const checks: Check[] = [];
	const run = (f: () => number): Outcome => {
		try {
			return { v: f() | 0 };
		} catch (e) {
			const text = String(e);
			if (!/trap|RuntimeError|out of bounds|unreachable/i.test(text)) throw e;
			return { trap: 'trap' };
		}
	};
	const scenarios = memScenarios.filter((s) => !options.only || options.only.includes(s.name));
	for (const s of scenarios) {
		const { vm, linked } = await openRung(wasm3, join(dir, 'rungs'), mixed, mode, mode === 'direct' ? dispatcherBytes(mixed) : undefined, options.memoryLimitPages ? { memoryLimit: options.memoryLimitPages * PAGE } : {});
		const g = linked.guest;
		const ref = new WebAssembly.Instance(new WebAssembly.Module(refBytes)).exports as Record<string, (...a: number[]) => number> & { memory: WebAssembly.Memory };
		const bad: string[] = [];
		s.steps.forEach(([fn, ...args], k) => {
			const want = run(() => ref[fn]!(...args));
			const got = run(() => g.call(fn, ...args));
			if (JSON.stringify(got) !== JSON.stringify(want)) bad.push(`step ${k} ${fn}(${args.join(', ')}): ${JSON.stringify(got)} against v8 ${JSON.stringify(want)}`);
		});
		const mine = new Uint8Array(vm.guest!.buffer);
		const theirs = new Uint8Array(ref.memory.buffer);
		if (mine.length !== theirs.length) bad.push(`memory is ${mine.length} bytes, v8's ${theirs.length}`);
		else if (Buffer.compare(mine, theirs) !== 0) bad.push('memory bytes differ from v8');
		checks.push({ name: `${s.name}${options.memoryLimitPages ? ` (maxMemoryBytes ${options.memoryLimitPages} pages)` : ''} (${mode})`, ok: bad.length === 0, detail: bad.length ? bad.slice(0, 3).join('; ') : `${s.steps.length} steps and ${mine.length} bytes equal v8's` });
	}
	if (!options.only || options.only.includes('native growth, then the interpreter reads')) {
		// JavaScript grows memory through a native export with no host call in the interpreter's path, then enters the interpreter
		const { linked } = await openRung(wasm3, join(dir, 'rungs'), mixed, mode, mode === 'direct' ? dispatcherBytes(mixed) : undefined);
		const ref = new WebAssembly.Instance(new WebAssembly.Module(refBytes)).exports as Record<string, (...a: number[]) => number>;
		ref.n_grow!(1);
		const native = linked.native.f_n_grow!(PAGE, 1);
		const got = run(() => linked.guest.call('i_size'));
		const want = run(() => ref.i_size!());
		checks.push({ name: `native called from JavaScript grows, then an interpreted entry (${mode})`, ok: native === 1 && JSON.stringify(got) === JSON.stringify(want), detail: `native grow ${native}, interpreter size ${JSON.stringify(got)} against v8 ${JSON.stringify(want)}` });
	}
	return checks;
}

if (process.argv[1] === new URL(import.meta.url).pathname) {
	const [wasm3 = '', out = '', mode = 'glued', what = 'toy'] = process.argv.slice(2);
	if (!wasm3 || !out) throw new Error('usage: toy.ts <re-entry wasm3.wasm> <out dir> [glued | direct] [toy | grow | mem]');
	if (what === 'grow') {
		prepareToy(join(here, '../toy-grow.wat'), out, { mixed: ['callGrow'] }, false);
	} else if (what === 'mem') {
		prepareToy(join(here, '../toy-mem.wat'), out, memSets, false, { LADDER_MEM0: '1' });
	} else {
		prepareToy(join(here, '../toy.wat'), out, { mixed: ['hotA', 'leafH', 'viaTab', 'callTrap'] });
	}
	const checks = what === 'grow' ? await runGrow(wasm3, out) : what === 'mem' ? await runMemory(wasm3, out, mode as 'glued' | 'direct') : await runToy(wasm3, out, mode as 'glued' | 'direct');
	for (const c of checks) console.log(`${c.ok ? 'PASS' : 'FAIL'} ${c.name}: ${c.detail}`);
	console.log(`${checks.filter((c) => c.ok).length} of ${checks.length} passed`);
	process.exitCode = checks.every((c) => c.ok) ? 0 : 1;
}
