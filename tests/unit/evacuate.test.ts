import binaryen from 'binaryen';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const fuel = `
		(global.set $budget (i32.sub (global.get $budget) (i32.const 1)))
		(if (i32.lt_s (global.get $budget) (i32.const 0)) (then (global.set $budget (call $fuel))))`;
// nested loops with scripts/wasm/fuel-pass.ts's check first in each, and values derived from the
// parameter (p = n + 16, q = p << 2) kept across every call
const PROGRAM = `(module
	(import "env" "__gmux_fuel" (func $fuel (result i32)))
	(import "env" "out" (func $out (param i32)))
	(memory (export "memory") 1)
	(global $budget (export "budget") (mut i32) (i32.const 0))
	(global (export "__stack_pointer") (mut i32) (i32.const 4096))
	(func $emit (param $v i32) (call $out (local.get $v)))
	(func (export "run") (param $n i32) (result i32) (local $i i32) (local $j i32) (local $s i32) (local $p i32) (local $q i32)
		(local.set $p (i32.add (local.get $n) (i32.const 16)))
		(local.set $q (i32.shl (local.get $p) (i32.const 2)))
		(loop $outer ${fuel}
			(local.set $j (i32.const 0))
			(loop $inner ${fuel}
				(local.set $s (i32.add (local.get $s) (i32.mul (local.get $i) (local.get $j))))
				(br_if $inner (i32.lt_u (local.tee $j (i32.add (local.get $j) (i32.const 1))) (i32.const 3))))
			(call $emit (i32.add (local.get $s) (local.get $q)))
			(call $emit (local.get $p))
			(br_if $outer (i32.lt_u (local.tee $i (i32.add (local.get $i) (i32.const 1))) (local.get $n))))
		(i32.add (local.get $s) (local.get $p))))`;

const script = new URL('../../experiments/evacuation/scripts/evacuate.ts', import.meta.url)
	.pathname;
const plainBytes = (() => {
	const module = binaryen.parseText(PROGRAM);
	module.setFeatures(binaryen.Features.MutableGlobals);
	const bytes = module.emitBinary();
	module.dispose();
	return bytes;
})();

function evacuate(flags: string[]) {
	const dir = mkdtempSync(join(tmpdir(), 'gmux-evacuate-'));
	writeFileSync(join(dir, 'in.wasm'), plainBytes);
	const out = execFileSync(
		process.execPath,
		[script, join(dir, 'in.wasm'), join(dir, 'out.wasm'), '--program', ...flags],
		{ encoding: 'utf8' }
	);
	return {
		module: new WebAssembly.Module(readFileSync(join(dir, 'out.wasm'))),
		stats: JSON.parse(out.trim().split('\n').pop()!) as Record<string, number>
	};
}

type Exports = {
	run(n: number): number;
	run$resume(): number;
	memory: WebAssembly.Memory;
	budget: WebAssembly.Global;
	__stack_pointer: WebAssembly.Global;
	gmux_fp: WebAssembly.Global;
	gmux_unwinding: WebAssembly.Global;
	gmux_ckpt: WebAssembly.Tag;
};
interface Snapshot {
	memory: Uint8Array;
	globals: number[];
}

/**
 * an instance whose every import call is a tick (fuel refills nothing, so every check yields); onTick
 * may start an unwind, as the machine does: set gmux_unwinding and return, the call not completed
 */
function instance(module: WebAssembly.Module, out: number[], onTick: (x: Exports) => void) {
	const box: { x?: Exports } = {};
	const i = new WebAssembly.Instance(module, {
		env: {
			__gmux_fuel: () => (onTick(box.x!), 0),
			out: (v: number) => {
				onTick(box.x!);
				if (!box.x!.gmux_unwinding?.value) out.push(v);
			}
		}
	});
	box.x = i.exports as unknown as Exports;
	return box.x;
}

/** runs start until the at-th tick, evacuates there and returns the machine as bytes, or the result */
function checkpoint(
	module: WebAssembly.Module,
	start: (x: Exports) => number,
	out: number[],
	at: number
) {
	let ticks = 0;
	const x = instance(module, out, (x) => {
		if (++ticks !== at) return;
		x.gmux_fp.value = x.memory.grow(1) * 0x10000;
		x.gmux_unwinding.value = 1;
	});
	try {
		return { done: start(x) };
	} catch (e) {
		if (!(e instanceof WebAssembly.Exception) || !e.is(x.gmux_ckpt)) throw e;
		const snap: Snapshot = {
			memory: new Uint8Array(x.memory.buffer).slice(),
			globals: [x.__stack_pointer.value, x.gmux_fp.value, x.budget.value]
		};
		return { snap };
	}
}

function restore(snap: Snapshot) {
	return (x: Exports) => {
		x.memory.grow(snap.memory.byteLength / 0x10000 - x.memory.buffer.byteLength / 0x10000);
		new Uint8Array(x.memory.buffer).set(snap.memory);
		[x.__stack_pointer.value, x.gmux_fp.value, x.budget.value] = snap.globals;
		return x['run$resume']();
	};
}

describe('evacuate.ts', () => {
	const refOut: number[] = [];
	let refTicks = 0;
	const reference = instance(new WebAssembly.Module(plainBytes), refOut, () => refTicks++).run(4);

	const arms = [
		['--resume'],
		['--resume', '--as-written'],
		['--fold'],
		['--resume', '--as-written', '--no-remat'],
		['--fold', '--no-remat'],
		['--resume', '--try-sites'],
		['--fold', '--try-sites']
	];
	for (const flags of arms) {
		describe(flags.join(' '), () => {
			const { module, stats } = evacuate(flags);

			it('runs as the plain program without a checkpoint', () => {
				const out: number[] = [];
				expect(instance(module, out, () => {}).run(4)).toBe(reference);
				expect(out).toEqual(refOut);
			});

			it('resumes from every tick, and again from inside the resumed run', () => {
				expect(refTicks).toBeGreaterThan(20);
				for (let at = 1; at <= refTicks; at++) {
					const out: number[] = [];
					const first = checkpoint(module, (x) => x.run(4), out, at);
					expect(first.snap, `tick ${at}`).toBeDefined();
					// the resumed innermost frame calls its import again, so the second counts from there
					const second = checkpoint(
						module,
						restore(first.snap!),
						out,
						Math.max(2, (refTicks - at) >> 1)
					);
					const result = second.snap
						? checkpoint(module, restore(second.snap), out, 0).done
						: second.done;
					expect({ at, out, result }).toEqual({ at, out: refOut, result: reference });
				}
			});

			it('enters each loop at its fuel yield and recomputes the derived values', () => {
				expect(stats.headEntries).toBeGreaterThan(0);
				if (flags.includes('--no-remat')) expect(stats.rematerialized).toBe(0);
				else expect(stats.rematerialized).toBeGreaterThan(0);
			});

			it('spills a host import site inline unless asked to keep its handler', () => {
				if (flags.includes('--try-sites')) expect(stats.inlinedSites).toBe(0);
				else expect(stats.inlinedSites).toBeGreaterThan(0);
			});
		});
	}

	it('saves fewer locals when it recomputes', () => {
		const on = evacuate(['--resume', '--as-written']).stats;
		const off = evacuate(['--resume', '--as-written', '--no-remat']).stats;
		expect(on.saved + on.rematerialized).toBe(off.saved);
	});
});
