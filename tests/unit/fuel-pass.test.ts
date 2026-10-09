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
  (func $loopres (export "loopres") (param $p0 i32) (result i32)
    (local $l1 i32)
    loop $L0 (result i32)
      local.get $l1
      i32.const 1
      i32.add
      local.tee $l1
      local.get $p0
      i32.lt_u
      br_if $L0
      local.get $l1
    end)
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

const CASES = [
	'fall',
	'brif',
	'br',
	'table',
	'return',
	'nested',
	'outer',
	'typed',
	'loopres',
	'trap',
	'last'
];
// budgets that leave a yield early, mid-loop and never in a short run
const BUDGETS = [1, 3, 9, 100000];
const RUNS = [1, 2, 5, 8, 9, 40];

const dir = mkdtempSync(join(tmpdir(), 'gmux-fuel-'));
writeFileSync(join(dir, 'in.wat'), TOY);

/** the toy through the fuel pass, with the counts the pass prints */
function fueled(tag: string, env: Record<string, string | undefined> = {}, wat = 'in.wat') {
	const out = join(dir, `${tag}.wat`);
	const printed = execFileSync('scripts/ts', ['scripts/wasm/fuel-pass.ts', join(dir, wat), out], {
		env: { ...process.env, GMUX_FUEL_LOCAL: '0', GMUX_FUEL_FORM: '', ...env },
		encoding: 'utf8'
	});
	const module = binaryen.parseText(readFileSync(out, 'utf8'));
	module.setFeatures(binaryen.Features.MutableGlobals);
	expect(module.validate()).toBe(1);
	const bytes = module.emitBinary();
	module.dispose();
	return { wat: readFileSync(out, 'utf8'), printed, module: new WebAssembly.Module(bytes) };
}

/** what a run returns, how often it yielded, the budget global at each yield and the one it leaves */
function run(module: WebAssembly.Module, name: string, budget: number, n: number) {
	let yields = 0;
	const atYield: number[] = [];
	const x = new WebAssembly.Instance(module, {
		env: {
			yield: () => {},
			// every yield refills with 5, as the host's does with its own budget
			__gmux_fuel: () => (yields++, atYield.push(x.budget.value), 5)
		}
	}).exports as Record<string, any>;
	x.set(budget);
	let result: number | string;
	try {
		result = x[name](n);
	} catch {
		result = 'trap';
	}
	return { result, yields, atYield, budget: x.budget.value as number };
}

describe('fuel-pass.ts', () => {
	const global = fueled('global');
	const local = fueled('local', { GMUX_FUEL_LOCAL: '1' });
	const forms = {
		local,
		callout: fueled('callout', { GMUX_FUEL_FORM: 'callout' }),
		'callout+local': fueled('callout-local', {
			GMUX_FUEL_LOCAL: '1',
			GMUX_FUEL_FORM: 'callout'
		})
	};

	it('keeps a local count only for loops with no call in them', () => {
		expect(global.printed).toBe('instrumented 13 loops\n');
		// every loop but the one in $outer that calls
		expect(local.printed).toBe('instrumented 13 loops, 12 with a local count\n');
		expect(local.wat).toContain('(local $gmux.b i32)');
	});

	it('keeps no local count in a function longer than GMUX_FUEL_LOCAL_MAXFN', () => {
		const capped = fueled('capped', { GMUX_FUEL_LOCAL: '1', GMUX_FUEL_LOCAL_MAXFN: '3' });
		expect(capped.printed).toBe('instrumented 13 loops, 0 with a local count\n');
		const roomy = fueled('roomy', { GMUX_FUEL_LOCAL: '1', GMUX_FUEL_LOCAL_MAXFN: '100000' });
		expect(roomy.wat).toBe(local.wat);
	});

	it('is the same text without GMUX_FUEL_LOCAL', () => {
		expect(global.wat).not.toMatch(/\$gmux\.b\b/);
	});

	it('wraps every loop without params or results in the call-out form', () => {
		// $loopres has a result type and keeps today's inline check
		expect(forms.callout.printed).toBe('instrumented 13 loops, 12 in the call-out form\n');
		expect(forms.callout.wat).toContain('br_if $gmux.yield.1');
		expect(forms.callout.wat).not.toMatch(/\$gmux\.b\b/);
		expect(forms['callout+local'].printed).toBe(
			'instrumented 13 loops, 12 with a local count, 12 in the call-out form\n'
		);
	});

	for (const [form, built] of Object.entries(forms))
		for (const name of CASES) {
			it(`${form} ${name}: results, yield counts and the budget after it equal the global count's`, () => {
				for (const budget of BUDGETS)
					for (const n of RUNS) {
						const want = run(global.module, name, budget, n);
						const got = run(built.module, name, budget, n);
						// a local count leaves the global where the loop was entered at a trap: the process is gone
						if (name === 'trap' && want.result === 'trap' && form !== 'callout') {
							expect(got.result).toBe('trap');
							expect(got.yields).toBe(want.yields);
						} else expect(got, `${name}(${n}) at budget ${budget}`).toEqual(want);
					}
			});
		}

	for (const [form, built] of Object.entries(forms))
		it(`${form} yields where the global count does, over a long loop`, () => {
			for (const name of ['fall', 'nested', 'typed', 'table']) {
				const want = run(global.module, name, 100000, 250000);
				expect(want.yields).toBeGreaterThan(0);
				expect(run(built.module, name, 100000, 250000)).toEqual(want);
			}
		});

	it('decides the local count by loop shape when GMUX_FUEL_LOCAL is unset, and 0 and 1 force it', () => {
		const calls = (n: number) =>
			`(module
  (type $t0 (func))
  (import "env" "yield" (func $yield (type $t0)))
${Array.from(
	{ length: n },
	(_, k) => `  (func $c${k} (export "c${k}") (param $p0 i32)
    loop $L0
      call $yield
      local.get $p0
      i32.const -1
      i32.add
      local.tee $p0
      br_if $L0
    end)`
).join('\n')}
  (export "budget" (global $gmux.budget)))
`;
		writeFileSync(join(dir, 'calls.wat'), calls(3));
		// 11 of 12 outermost loops make no call: on
		expect(fueled('rule-on', { GMUX_FUEL_LOCAL: undefined }).printed).toBe(
			'instrumented 13 loops, 12 with a local count\n'
		);
		// every loop calls: off
		expect(fueled('rule-off', { GMUX_FUEL_LOCAL: undefined }, 'calls.wat').printed).toBe(
			'instrumented 3 loops\n'
		);
		expect(fueled('forced-on', { GMUX_FUEL_LOCAL: '1' }, 'calls.wat').printed).toBe(
			'instrumented 3 loops, 0 with a local count\n'
		);
		expect(fueled('forced-off', { GMUX_FUEL_LOCAL: '0' }).printed).toBe(global.printed);
	});

	it('refuses a numeric label inside a wrapped loop', () => {
		const wat = TOY.replace('br_if $L2\n        end', 'br_if 0\n        end').replace(
			'br $L1\n      end\n    end\n    local.get $l1)\n  (func $outer',
			'br 1\n      end\n    end\n    local.get $l1)\n  (func $outer'
		);
		expect(wat).not.toBe(TOY);
		writeFileSync(join(dir, 'numeric.wat'), wat);
		expect(() => fueled('numeric', { GMUX_FUEL_FORM: 'callout' }, 'numeric.wat')).toThrow(
			/numeric label/
		);
	});
});
