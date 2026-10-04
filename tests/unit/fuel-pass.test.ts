import binaryen from 'binaryen';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// wasm2wat --generate-names layout, which scripts/wasm/fuel-pass.ts reads line by line
const TOY = `(module
  (type $t0 (func))
  (import "env" "yield" (func $yield (type $t0)))
  (func $set (export "set") (param $p0 i32)
    local.get $p0
    global.set $gmux.budget)
  (func $fall (export "fall") (param $p0 i32) (result i32)
    (local $l1 i32)
    loop $L0
      local.get $l1
      i32.const 3
      i32.add
      local.set $l1
      local.get $p0
      i32.const -1
      i32.add
      local.tee $p0
      br_if $L0
    end
    local.get $l1)
  (func $brif (export "brif") (param $p0 i32) (result i32)
    (local $l1 i32)
    block $B0
      loop $L1
        local.get $l1
        i32.const 1
        i32.add
        local.tee $l1
        local.get $p0
        i32.ge_u
        br_if $B0
        br $L1
      end
    end
    local.get $l1)
  (func $br (export "br") (param $p0 i32) (result i32)
    (local $l1 i32)
    block $B0
      loop $L1
        local.get $l1
        i32.const 1
        i32.add
        local.tee $l1
        local.get $p0
        i32.ge_u
        if
          br $B0
        end
        br $L1
      end
    end
    local.get $l1)
  (func $table (export "table") (param $p0 i32) (result i32)
    (local $l1 i32)
    block $B0
      block $B1
        loop $L2
          local.get $l1
          i32.const 1
          i32.add
          local.tee $l1
          local.get $p0
          i32.ge_u
          local.get $p0
          i32.const 1
          i32.and
          i32.const 1
          i32.add
          i32.mul
          br_table $L2 $B1 $B0 $L2
        end
      end
      local.get $l1
      i32.const 100
      i32.add
      return
    end
    local.get $l1)
  (func $return (export "return") (param $p0 i32) (result i32)
    (local $l1 i32)
    loop $L0
      local.get $l1
      i32.const 1
      i32.add
      local.tee $l1
      local.get $p0
      i32.ge_u
      if
        local.get $l1
        i32.const 2
        i32.mul
        return
      end
      br $L0
    end
    unreachable)
  (func $nested (export "nested") (param $p0 i32) (result i32)
    (local $l1 i32) (local $l2 i32)
    block $B0
      loop $L1
        i32.const 0
        local.set $l2
        loop $L2
          local.get $l1
          i32.const 1
          i32.add
          local.set $l1
          local.get $l2
          i32.const 1
          i32.add
          local.tee $l2
          i32.const 4
          i32.lt_u
          br_if $L2
        end
        local.get $l1
        local.get $p0
        i32.ge_u
        br_if $B0
        br $L1
      end
    end
    local.get $l1)
  (func $outer (export "outer") (param $p0 i32) (result i32)
    (local $l1 i32) (local $l2 i32)
    loop $L0
      call $yield
      i32.const 0
      local.set $l2
      loop $L1
        local.get $l1
        i32.const 1
        i32.add
        local.set $l1
        local.get $l2
        i32.const 1
        i32.add
        local.tee $l2
        i32.const 5
        i32.lt_u
        br_if $L1
      end
      local.get $p0
      i32.const -1
      i32.add
      local.tee $p0
      br_if $L0
    end
    local.get $l1)
  (func $typed (export "typed") (param $p0 i32) (result i32)
    (local $l1 i32)
    block $B0 (result i32)
      loop $L1
        local.get $l1
        i32.const 1
        i32.add
        local.set $l1
        i32.const 77
        local.get $l1
        local.get $p0
        i32.ge_u
        br_if $B0
        drop
        br $L1
      end
      unreachable
    end
    local.get $l1
    i32.add)
  (func $trap (export "trap") (param $p0 i32) (result i32)
    (local $l1 i32)
    loop $L0
      local.get $l1
      i32.const 1
      i32.add
      local.tee $l1
      local.get $p0
      i32.eq
      if
        unreachable
      end
      br $L0
    end
    local.get $l1)
  (func $last (export "last") (param $p0 i32)
    loop $L0
      local.get $p0
      i32.const -1
      i32.add
      local.tee $p0
      br_if $L0
    end)
  (export "budget" (global $gmux.budget)))
`;

const CASES = ['fall', 'brif', 'br', 'table', 'return', 'nested', 'outer', 'typed', 'trap', 'last'];
// budgets that leave a yield early, mid-loop and never in a short run
const BUDGETS = [1, 3, 9, 100000];
const RUNS = [1, 2, 5, 8, 9, 40];

const dir = mkdtempSync(join(tmpdir(), 'gmux-fuel-'));
writeFileSync(join(dir, 'in.wat'), TOY);

/** the toy through the fuel pass, with the counts the pass prints */
function fueled(local: boolean) {
	const out = join(dir, local ? 'local.wat' : 'global.wat');
	const printed = execFileSync(
		'scripts/ts',
		['scripts/wasm/fuel-pass.ts', join(dir, 'in.wat'), out],
		{
			env: { ...process.env, GMUX_FUEL_LOCAL: local ? '1' : '' },
			encoding: 'utf8'
		}
	);
	const module = binaryen.parseText(readFileSync(out, 'utf8'));
	module.setFeatures(binaryen.Features.MutableGlobals);
	expect(module.validate()).toBe(1);
	const bytes = module.emitBinary();
	module.dispose();
	return { wat: readFileSync(out, 'utf8'), printed, module: new WebAssembly.Module(bytes) };
}

/** what a run returns, how often it yielded and the budget global it leaves */
function run(module: WebAssembly.Module, name: string, budget: number, n: number) {
	let yields = 0;
	const x = new WebAssembly.Instance(module, {
		env: {
			yield: () => {},
			// every yield refills with 5, as the host's does with its own budget
			__gmux_fuel: () => (yields++, 5)
		}
	}).exports as Record<string, any>;
	x.set(budget);
	let result: number | string;
	try {
		result = x[name](n);
	} catch {
		result = 'trap';
	}
	return { result, yields, budget: x.budget.value as number };
}

describe('fuel-pass.ts', () => {
	const global = fueled(false);
	const local = fueled(true);

	it('keeps a local count only for loops with no call in them', () => {
		expect(global.printed).toBe('instrumented 12 loops\n');
		// every loop but the one in $outer that calls
		expect(local.printed).toBe('instrumented 12 loops, 11 with a local count\n');
		expect(local.wat).toContain('(local $gmux.b i32)');
	});

	it('is the same text without GMUX_FUEL_LOCAL', () => {
		expect(global.wat).not.toMatch(/\$gmux\.b\b/);
	});

	for (const name of CASES) {
		it(`${name}: results, yield counts and the budget after it equal the global count's`, () => {
			for (const budget of BUDGETS)
				for (const n of RUNS) {
					const want = run(global.module, name, budget, n);
					const got = run(local.module, name, budget, n);
					// a trap leaves the global where the loop was entered: the process is gone
					if (name === 'trap' && want.result === 'trap') {
						expect(got.result).toBe('trap');
						expect(got.yields).toBe(want.yields);
					} else expect(got, `${name}(${n}) at budget ${budget}`).toEqual(want);
				}
		});
	}

	it('yields where the global count does, over a long loop', () => {
		for (const name of ['fall', 'nested', 'typed', 'table']) {
			const want = run(global.module, name, 100000, 250000);
			expect(want.yields).toBeGreaterThan(0);
			expect(run(local.module, name, 100000, 250000)).toEqual(want);
		}
	});
});
