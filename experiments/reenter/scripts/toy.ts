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
export function prepareToy(source: string, out: string, sets: Record<string, string[]>, nativeEnd = true) {
	mkdirSync(out, { recursive: true });
	const wasm = join(out, 'guest.wasm');
	writeFileSync(wasm, wasmTools(['parse', source, '-o', '/dev/stdout']));
	writeFileSync(join(out, 'sets.json'), JSON.stringify(sets));
	execFileSync(node[0]!, [...node.slice(1), ladder, 'prepare', wasm, join(out, 'rungs'), join(out, 'sets.json')], {
		env: { ...process.env, LADDER_OPEN: '1', LADDER_NATIVE_END: nativeEnd ? '1' : '0' },
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
	attempt('guest memory counter equals v8', () => same('counter', new DataView(vm.shim.memory.buffer).getInt32(g.memory().base + 256, true), new DataView(ref.memory.buffer).getInt32(256, true)));
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
	attempt('after the trap: guest memory counter equals v8', () => same('counter', new DataView(vm.shim.memory.buffer).getInt32(g.memory().base + 256, true), new DataView(ref.memory.buffer).getInt32(256, true)));
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

if (process.argv[1] === new URL(import.meta.url).pathname) {
	const [wasm3 = '', out = '', mode = 'glued', what = 'toy'] = process.argv.slice(2);
	if (!wasm3 || !out) throw new Error('usage: toy.ts <re-entry wasm3.wasm> <out dir> [glued | direct] [toy | grow]');
	if (what === 'grow') {
		prepareToy(join(here, '../toy-grow.wat'), out, { mixed: ['callGrow'] }, false);
	} else {
		prepareToy(join(here, '../toy.wat'), out, { mixed: ['hotA', 'leafH', 'viaTab', 'callTrap'] });
	}
	const checks = what === 'grow' ? await runGrow(wasm3, out) : await runToy(wasm3, out, mode as 'glued' | 'direct');
	for (const c of checks) console.log(`${c.ok ? 'PASS' : 'FAIL'} ${c.name}: ${c.detail}`);
	console.log(`${checks.filter((c) => c.ok).length} of ${checks.length} passed`);
	process.exitCode = checks.every((c) => c.ok) ? 0 : 1;
}
