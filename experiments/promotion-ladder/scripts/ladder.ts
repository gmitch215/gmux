import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * The promotion-coverage ladder: a guest's hottest functions made native by hand while wasm3 interprets
 * the rest, measured end to end against V8 and against Amdahl.
 *
 * `prepare <guest.wasm> <out dir>` (needs wasm-tools) counts each function's dynamic instructions by
 * running an instrumented copy in V8 (burrow's law: interpreted cost per instruction is near flat, so
 * the count stands in for interpreted CPU), picks the smallest set of functions reaching 0, 90, 95, 99,
 * 99.5, 99.9 and 100% of it, closes each set under direct calls (native code never calls back into
 * wasm3, which is not re-entrant), and writes two modules per rung: `interp` for wasm3, where each
 * promoted function is a thunk to a host import, and `native`, which imports wasm3's memory and adds
 * the guest's base to every load and store. The stack pointer crosses as the thunk's first argument.
 *
 * `run <out dir> <burrow dist> [rounds]` times `run(n)` and `run(2n)` per rung and keeps the difference.
 */
const [mode = '', a1 = '', a2 = '', a3 = ''] = process.argv.slice(2);

export interface Fn {
	name: string;
	header: string;
	locals: string[];
	body: string[];
	params: number;
	result: boolean;
	/** takes or returns something other than i32, which a burrow import cannot carry */
	wide: boolean;
}

export function parse(text: string) {
	// wasm-tools quotes the names it had to disambiguate ($"#func91 name") and annotates them
	const wat = text.replace(/ \(@name "[^"]*"\)/g, '').replace(/\$"([^"]*)"/g, (_, s: string) => `$${s.replace(/[^A-Za-z0-9_.]/g, '_')}`);
	const lines = wat.split('\n');
	const head: string[] = [];
	const tail: string[] = [];
	const fns: Fn[] = [];
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i]!;
		const m = line.match(/^ {2}\(func \$(\S+) \(;\d+;\) \(type \d+\)(.*)$/);
		if (!m) {
			(fns.length ? tail : head).push(line);
			continue;
		}
		const sig = m[2]!;
		const params = (sig.match(/\(param ([^)]*)\)/)?.[1] ?? '').split(/\s+/).filter(Boolean).length;
		const result = /\(result/.test(sig);
		const fn: Fn = { name: m[1]!, header: line, locals: [], body: [], params, result, wide: /\b(i64|f32|f64)\b/.test(sig) };
		if ((line.match(/\(/g) ?? []).length === (line.match(/\)/g) ?? []).length) {
			// an empty body printed on one line, e.g. (func $f (type 1) (param i32 i32))
			fn.header = line.replace(/\)$/, '');
			fns.push(fn);
			continue;
		}
		for (i++; i < lines.length && lines[i] !== '  )'; i++) {
			const l = lines[i]!;
			if (/^\s*\(local /.test(l) && !fn.body.length) fn.locals.push(l);
			else fn.body.push(l);
		}
		fns.push(fn);
	}
	return { head, tail, fns };
}

const sigOf = (fn: Fn) => fn.header.replace(/^ {2}\(func \$\S+ \(;\d+;\) \(type \d+\)/, '').trim();
const paramList = (fn: Fn) => Array.from({ length: fn.params }, (_, i) => `    local.get ${i}`);
export const emit = (fn: Fn) => [fn.header, ...fn.locals, ...fn.body, '  )'];
export const wasmTools = (args: string[], input?: string) => execFileSync('wasm-tools', args, { input, maxBuffer: 1 << 28 });

// #region prepare
if (mode === 'prepare') {
	const [guest, out] = [a1, a2];
	mkdirSync(out, { recursive: true });
	const wat = wasmTools(['print', guest]).toString();
	const { head, tail, fns } = parse(wat);

	// counting: a counter per function, bumped at every straight-line segment by its length
	const boundary = /^\s*(block|loop|if|else|end|br_if|br_table|call|call_indirect)\b/;
	const counted = fns.map((fn) => {
		const body: string[] = [];
		const bump = (k: number) => (k ? [`    global.get $cnt_${fn.name}`, `    i64.const ${k}`, '    i64.add', `    global.set $cnt_${fn.name}`] : []);
		let segment: string[] = [];
		const flush = () => {
			body.push(...bump(segment.length), ...segment);
			segment = [];
		};
		for (const l of fn.body) {
			segment.push(l);
			if (boundary.test(l)) {
				// the boundary instruction ends its segment; what follows starts a new one
				body.push(...bump(segment.length), ...segment);
				segment = [];
			}
		}
		flush();
		return { ...fn, body };
	});
	const counters = fns.map((fn) => `  (global $cnt_${fn.name} (export "cnt_${fn.name}") (mut i64) i64.const 0)`);
	const countWat = [...head, ...counted.flatMap(emit), ...counters, ...tail].join('\n');
	const countBytes = wasmTools(['parse', '-o', '/dev/stdout'], countWat);
	const inst = new WebAssembly.Instance(new WebAssembly.Module(countBytes)).exports as Record<string, WebAssembly.Global | ((n: number) => number)>;
	// per deflate, as `run` times it: run(2) less run(1), so the input generation cancels here too
	const read = () => fns.map((fn) => Number((inst[`cnt_${fn.name}`] as WebAssembly.Global).value));
	(inst.run as (n: number) => number)(1);
	const one = read();
	for (const fn of fns) (inst[`cnt_${fn.name}`] as WebAssembly.Global).value = 0n;
	(inst.run as (n: number) => number)(2);
	const two = read();
	const counts = Object.fromEntries(fns.map((fn, i) => [fn.name, two[i]! - one[i]!]));
	const total = Object.values(counts).reduce((s, v) => s + v, 0);

	// direct callees, for closing a set
	const callees = new Map(fns.map((fn) => [fn.name, new Set(fn.body.map((l) => l.match(/^\s*call \$(\S+)/)?.[1]).filter(Boolean) as string[])]));
	// bottom-up: a function can go native once every function it calls directly is native, so native
	// code never calls back into wasm3; each step promotes the hottest eligible one
	const shareOf = (set: Set<string>) => [...set].reduce((s, n) => s + counts[n]!, 0) / total;
	const rungs = [{ target: 0, set: new Set<string>(), share: 0, label: 'interpreted' }];
	const done = new Set<string>();
	// a sets file ({label: [function, ...]}) replaces the ladder: the empty set, each given set, every function
	const given = a3 ? (JSON.parse(readFileSync(a3, 'utf8')) as Record<string, string[]>) : null;
	if (given) {
		for (const [label, names] of Object.entries(given)) rungs.push({ target: 0, set: new Set(names), share: shareOf(new Set(names)), label });
		// LADDER_NATIVE_END=0 leaves out the all-native rung, which cannot be built from a function that grows memory
		if (process.env.LADDER_NATIVE_END !== '0') rungs.push({ target: 1, set: new Set(fns.filter((fn) => !fn.wide).map((fn) => fn.name)), share: 1, label: 'native' });
		for (const r of rungs) r.target = r.share;
	}
	for (; !given; ) {
		const eligible = fns.filter((fn) => !done.has(fn.name) && [...callees.get(fn.name)!].every((c) => done.has(c) || c === fn.name));
		if (!eligible.length) break;
		const next = eligible.sort((x, y) => counts[y.name]! - counts[x.name]!)[0]!;
		done.add(next.name);
		const share = shareOf(done);
		// a rung per step that moves the share, and the last, which holds every function
		if (share > rungs.at(-1)!.share + 1e-4 || done.size === fns.length) rungs.push({ target: share, set: new Set(done), share, label: "" });
	}

	const byName = new Map(fns.map((fn) => [fn.name, fn]));
	// LADDER_OPEN=1: a promoted function may call an interpreted one; the native module then holds a wrapper for it that
	// enters wasm3 through the host's call_at import, and wasm3 exports an entry stub (ie_<name>) per such function
	const open = process.env.LADDER_OPEN === '1';
	const elemRefs = new Set([...head, ...tail].filter((l) => /^\s*\(elem\b/.test(l)).flatMap((l) => [...l.matchAll(/\$([A-Za-z0-9_.]+)/g)].map((m) => m[1]!)));
	// imports go right after the types, ahead of the table, memory and globals wasm-tools prints next
	const importAt = head.findLastIndex((l) => /^ {2}\(type/.test(l)) + 1;
	const manifest = rungs.map((rung, k) => {
		const promoted = [...rung.set].sort();
		// a wide function has no all-i32 thunk, so it is promoted only with every direct caller and is never entered from wasm3
		for (const fn of fns)
			for (const c of callees.get(fn.name)!)
				if (byName.get(c)?.wide && rung.set.has(c) && !rung.set.has(fn.name)) throw new Error(`rung ${k}: ${fn.name} is interpreted and calls the promoted wide function ${c}`);
		const entered = promoted.filter((n) => !byName.get(n)!.wide);
		// the interpreted functions native code reaches: a direct callee of a promoted function, or a table entry
		const cold = open
			? fns
					.filter((fn) => !rung.set.has(fn.name) && (elemRefs.has(fn.name) || [...rung.set].some((p) => callees.get(p)!.has(fn.name))))
					.map((fn) => {
						if (fn.wide) throw new Error(`rung ${k}: native code reaches the interpreted wide function ${fn.name}`);
						return fn.name;
					})
			: [];
		// wasm3's side: each entered function becomes a thunk passing the stack pointer first
		const interpHead = [...head];
		interpHead.splice(
			importAt,
			0,
			...entered.map((n) => {
				const fn = byName.get(n)!;
				const params = ['i32', ...Array.from({ length: fn.params }, () => 'i32')].join(' ');
				return `  (import "native" "${n}" (func $nat_${n} (param ${params})${fn.result ? ' (result i32)' : ''}))`;
			})
		);
		const interpFns = fns.map((fn) =>
			entered.includes(fn.name) ? { ...fn, locals: [], body: ['    global.get $__stack_pointer', ...paramList(fn), `    call $nat_${fn.name}`] } : fn
		);
		// an entry stub per interpreted function native code reaches: it sets the stack pointer to native's and puts it back
		const stubs = cold.flatMap((n) => {
			const fn = byName.get(n)!;
			if (fn.params > 7) throw new Error(`${n}: ${fn.params} parameters, call_at takes eight arguments with the stack pointer`);
			const params = ['i32', ...Array.from({ length: fn.params }, () => 'i32')].join(' ');
			return [
				`  (func $ie_${n} (export "ie_${n}") (param ${params})${fn.result ? ' (result i32)' : ''}`,
				'    (local $save i32) (local $r i32)',
				'    global.get $__stack_pointer',
				'    local.set $save',
				'    local.get 0',
				'    global.set $__stack_pointer',
				...Array.from({ length: fn.params }, (_, i) => `    local.get ${i + 1}`),
				`    call $${n}`,
				...(fn.result ? ['    local.set $r'] : []),
				'    local.get $save',
				'    global.set $__stack_pointer',
				...(fn.result ? ['    local.get $r'] : []),
				'  )'
			];
		});
		writeFileSync(join(out, `rung${k}.interp.wasm`), wasmTools(['parse', '-o', '/dev/stdout'], [...interpHead, ...interpFns.flatMap(emit), ...stubs, ...tail].join('\n')));

		// the native side: wasm3's memory, every access at base + address, entries that set the stack pointer
		const own = (l: string) => !/^ {2}\((memory|export|data) /.test(l);
		const coldImports = cold.length
			? ['  (import "interp" "call_at" (func $call_at (param i32 i32 i32 i32 i32 i32 i32 i32 i32) (result i32)))', ...cold.map((n) => `  (import "interp" "h_${n}" (global $h_${n} i32))`)]
			: [];
		const nativeHead = [...head.slice(0, importAt), '  (import "env" "memory" (memory 1))', '  (import "env" "base" (global $gbase i32))', ...coldImports, ...head.slice(importAt).filter(own)];
		// an interpreted function the native side calls is a wrapper that enters wasm3 at the live frame's top
		const wrapper = (fn: Fn): Fn => ({
			...fn,
			locals: [],
			body: [
				`    global.get $h_${fn.name}`,
				'    global.get $__stack_pointer',
				...paramList(fn),
				...Array.from({ length: 7 - fn.params }, () => '    i32.const 0'),
				'    call $call_at',
				...(fn.result ? [] : ['    drop'])
			]
		});
		const rebased = fns.filter((fn) => !open || rung.set.has(fn.name) || cold.includes(fn.name)).map((fn) => {
			if (open && !rung.set.has(fn.name)) return wrapper(fn);
			const body: string[] = [];
			for (const l of fn.body) {
				if (/^\s*memory\.(size|grow|copy|fill)/.test(l)) throw new Error(`${fn.name}: ${l.trim()} cannot be rebased`);
				const load = l.match(/^\s*(i32|i64|f32|f64)\.load/);
				const store = l.match(/^\s*(i32|i64|f32|f64)\.store/);
				if (load) body.push('    global.get $gbase', '    i32.add', l);
				else if (store) body.push(`    local.set $tv_${store[1]}`, '    global.get $gbase', '    i32.add', `    local.get $tv_${store[1]}`, l);
				else body.push(l);
			}
			return { ...fn, locals: [...fn.locals, '    (local $tv_i32 i32) (local $tv_i64 i64) (local $tv_f32 f32) (local $tv_f64 f64)'], body };
		});
		const entries = entered.map((n) => {
			const fn = byName.get(n)!;
			const params = ['i32', ...Array.from({ length: fn.params }, () => 'i32')].join(' ');
			return [
				`  (func $ent_${n} (export "f_${n}") (param ${params})${fn.result ? ' (result i32)' : ''}`,
				'    local.get 0',
				'    global.set $__stack_pointer',
				...Array.from({ length: fn.params }, (_, i) => `    local.get ${i + 1}`),
				`    call $${n}`,
				'  )'
			];
		});
		const nativeTail = tail.filter(own);
		writeFileSync(
			join(out, `rung${k}.native.wasm`),
			wasmTools(['parse', '-o', '/dev/stdout'], [...nativeHead, ...rebased.flatMap(emit), ...entries.flat(), ...nativeTail].join('\n'))
		);
		return {
			rung: k,
			label: rung.label,
			target: rung.target,
			share: rung.share,
			promoted,
			cold,
			imports: Object.fromEntries(entered.map((n) => [n, `${byName.get(n)!.result ? 'i' : 'v'}(${'i'.repeat(byName.get(n)!.params + 1)})`]))
		};
	});
	writeFileSync(join(out, 'rungs.json'), JSON.stringify({ total, counts, rungs: manifest }, null, '\t'));
	writeFileSync(join(out, 'guest.wasm'), readFileSync(guest));
	for (const r of manifest)
		console.log(`rung ${r.rung}: target ${(100 * r.target).toFixed(1)}%, closed share ${(100 * r.share).toFixed(3)}%, ${r.promoted.length} functions: ${r.promoted.join(' ')}`);
}
// #endregion

// #region run
if (mode === 'run') {
	const [out, burrowDist, roundsArg = '3'] = [a1, a2, a3];
	const rounds = Number(roundsArg);
	const { rungs } = JSON.parse(readFileSync(join(out, 'rungs.json'), 'utf8'));
	if (rungs.some((r: { cold?: string[] }) => r.cold?.length)) throw new Error('this directory has open rungs: run it with experiments/reenter/scripts/mixed.ts');
	const { createInterpreter } = await import(`${burrowDist}/interpret.js`);
	const wasm3Module = new WebAssembly.Module(readFileSync(`${burrowDist}/vendor/wasm3.wasm`));
	const n = Number(process.env.N ?? 2);
	const median = (xs: number[]) => [...xs].sort((x, y) => x - y)[Math.floor(xs.length / 2)]!;
	const time = (f: () => number) => {
		const t = performance.now();
		const v = f() >>> 0;
		return { ms: performance.now() - t, v };
	};

	const v8 = new WebAssembly.Instance(new WebAssembly.Module(readFileSync(join(out, 'guest.wasm')))).exports as Record<string, (n: number) => number>;
	const reference = v8.run!(2 * n) >>> 0;
	const v8ms = median(Array.from({ length: rounds }, () => time(() => v8.run!(2 * n)).ms - time(() => v8.run!(n)).ms));

	const rows: { rung: number; label: string; target: number; share: number; ms: number; crossings: number }[] = [];
	for (const r of rungs) {
		const vm = await createInterpreter({ module: wasm3Module });
		let native: Record<string, (...a: number[]) => number> = {};
		let crossings = 0;
		const lean = process.env.LADDER_GLUE === 'lean';
		const imports = Object.fromEntries(
			Object.entries(r.imports as Record<string, string>).map(([name, signature]) => {
				let entry: ((...a: number[]) => number) | undefined;
				return [
				name,
				{
					signature,
					// LADDER_GLUE=lean drops the crossing counter, the name lookup and the rest arguments (crossings read 0)
					fn: lean
						? (a: number, b: number, c: number, d: number, e: number) => (entry ??= native[`f_${name}`]!)(a, b, c, d, e)
						: (...args: number[]) => {
								crossings++;
								return native[`f_${name}`]!(...args);
							}
				}
			];
			})
		);
		const guest = vm.load(new Uint8Array(readFileSync(join(out, `rung${r.rung}.interp.wasm`))), { imports: { native: imports } });
		// burrow keeps the interpreter's memory private; the rig reaches it to share guest memory natively
		const memory = (vm as unknown as { shim: { memory: WebAssembly.Memory } }).shim.memory;
		const base = new WebAssembly.Global({ value: 'i32', mutable: false }, guest.memory().byteOffset);
		native = new WebAssembly.Instance(new WebAssembly.Module(readFileSync(join(out, `rung${r.rung}.native.wasm`))), {
			env: { memory, base }
		}).exports as typeof native;
		const diffs: number[] = [];
		let perRun = 0;
		for (let k = 0; k < rounds; k++) {
			crossings = 0;
			const one = time(() => guest.call('run', n));
			const c1 = crossings;
			const two = time(() => guest.call('run', 2 * n));
			if (two.v !== reference) throw new Error(`rung ${r.rung}: ${two.v.toString(16)} against v8 ${reference.toString(16)}`);
			diffs.push(two.ms - one.ms);
			perRun = crossings - 2 * c1;
		}
		rows.push({ rung: r.rung, label: r.label ?? '', target: r.target, share: r.share, ms: median(diffs), crossings: Math.max(perRun, 0) });
	}
	if (process.env.LADDER_JSON) writeFileSync(process.env.LADDER_JSON, JSON.stringify({ node: process.version, v8: process.versions.v8, n, rounds, v8ms, rows }, null, '\t'));
	const rI = rows[0]!.ms / v8ms;
	const rN = rows.at(-1)!.ms / v8ms;
	console.log(`V8 ${process.versions.v8} (node ${process.version}): ${v8ms.toFixed(1)} ms per ${n} deflates; all interpreted r ${rI.toFixed(2)}, all native through one crossing r ${rN.toFixed(2)}`);
	console.log('| rung | label | target | closed share | ms | r | Amdahl r | crossings per deflate |');
	console.log('| --- | --- | --- | --- | --- | --- | --- | --- |');
	for (const row of rows) {
		const r = row.ms / v8ms;
		const amdahl = (1 - row.share) * rI + row.share * rN;
		console.log(
			`| ${row.rung} | ${row.label} | ${(100 * row.target).toFixed(1)}% | ${(100 * row.share).toFixed(3)}% | ${row.ms.toFixed(1)} | ${r.toFixed(2)} | ${amdahl.toFixed(2)} | ${(row.crossings / n).toFixed(0)} |`
		);
	}
}
// #endregion
