"""Writes a wasm module (wasm-ops.wat) that exports every integer instruction form katybug's wasm
frontend decodes, and the calls to make on it (wasm-ops.calls, one "export arg..." per line, hex).
V8 (wasm-ops.mjs) and katybug --wasm run the same calls; the two outputs must be equal.
`python3 wasm-ops.py <out dir>`"""
import random
import sys

random.seed(215)
out = sys.argv[1]
E32 = [0, 1, 2, 3, 7, 0x1f, 0x20, 0x21, 0x7f, 0x80, 0xff, 0x7fff, 0x8000, 0xffff, 0x7fffffff,
       0x80000000, 0x80000001, 0xfffffffe, 0xffffffff, 0x12345678, 0xdeadbeef]
E32 += [random.getrandbits(32) for _ in range(6)]
E64 = [0, 1, 2, 63, 64, 65, 0x7fffffff, 0x80000000, 0xffffffff, 0x100000000, 0x7fffffffffffffff,
       0x8000000000000000, 0x8000000000000001, 0xfffffffffffffffe, 0xffffffffffffffff,
       0x123456789abcdef0, 0xfedcba9876543210]
E64 += [random.getrandbits(64) for _ in range(6)]

funcs, calls = [], []


def fn(name, params, results, body, inputs):
    p = ' '.join(f'(param {t})' for t in params)
    r = ' '.join(f'(result {t})' for t in results)
    funcs.append(f'  (func (export "{name}") {p} {r}\n    {body})')
    for args in inputs:
        calls.append(name + ''.join(f' {a:x}' for a in args))


def pairs(edges, n=60):
    return [(random.choice(edges), random.choice(edges)) for _ in range(n)]


BIN = ['add', 'sub', 'mul', 'div_s', 'div_u', 'rem_s', 'rem_u', 'and', 'or', 'xor', 'shl', 'shr_s',
       'shr_u', 'rotl', 'rotr']
CMP = ['eq', 'ne', 'lt_s', 'lt_u', 'gt_s', 'gt_u', 'le_s', 'le_u', 'ge_s', 'ge_u']
for t, edges in (('i32', E32), ('i64', E64)):
    for op in BIN + CMP:
        rt = 'i32' if op in CMP else t
        fn(f'{t}.{op}', [t, t], [rt], f'({t}.{op} (local.get 0) (local.get 1))', pairs(edges))
    for op in ['clz', 'ctz', 'popcnt', 'eqz']:
        rt = 'i32' if op == 'eqz' else t
        fn(f'{t}.{op}', [t], [rt], f'({t}.{op} (local.get 0))', [(e,) for e in edges])
    for op in ['extend8_s', 'extend16_s'] + (['extend32_s'] if t == 'i64' else []):
        fn(f'{t}.{op}', [t], [t], f'({t}.{op} (local.get 0))', [(e,) for e in edges])
fn('i32.wrap_i64', ['i64'], ['i32'], '(i32.wrap_i64 (local.get 0))', [(e,) for e in E64])
fn('i64.extend_i32_s', ['i32'], ['i64'], '(i64.extend_i32_s (local.get 0))', [(e,) for e in E32])
fn('i64.extend_i32_u', ['i32'], ['i64'], '(i64.extend_i32_u (local.get 0))', [(e,) for e in E32])
fn('select', ['i64', 'i64', 'i32'], ['i64'], '(select (local.get 0) (local.get 1) (local.get 2))',
   [(a, b, c) for a, b in pairs(E64, 8) for c in (0, 1, 0x80000000)])

# memory: every width and sign, stores then loads, at the edges of the one page and past it
ADDRS = [0, 1, 7, 0x100, 0xfff8, 0xfffc, 0xfffe, 0xffff, 0x10000, 0xffffffff]
LOADS = {'i32.load': 4, 'i32.load8_s': 1, 'i32.load8_u': 1, 'i32.load16_s': 2, 'i32.load16_u': 2,
         'i64.load': 8, 'i64.load8_s': 1, 'i64.load8_u': 1, 'i64.load16_s': 2, 'i64.load16_u': 2,
         'i64.load32_s': 4, 'i64.load32_u': 4}
STORES = {'i32.store': 'i32', 'i32.store8': 'i32', 'i32.store16': 'i32', 'i64.store': 'i64',
          'i64.store8': 'i64', 'i64.store16': 'i64', 'i64.store32': 'i64'}
for st, vt in STORES.items():
    fn(st.replace('.', '_'), ['i32', vt], [], f'({st} offset=3 (local.get 0) (local.get 1))',
       [(a, random.choice(E32 if vt == 'i32' else E64)) for a in ADDRS])
for ld in LOADS:
    rt = ld[:3]
    fn(ld.replace('.', '_'), ['i32'], [rt], f'({ld} offset=1 (local.get 0))', [(a,) for a in ADDRS])
fn('memory_size', [], ['i32'], '(memory.size)', [()])

# control flow, calls, globals
funcs.append('''  (func $fib (export "fib") (param i32) (result i32)
    (if (result i32) (i32.lt_u (local.get 0) (i32.const 2))
      (then (local.get 0))
      (else (i32.add (call $fib (i32.sub (local.get 0) (i32.const 1)))
                     (call $fib (i32.sub (local.get 0) (i32.const 2)))))))''')
calls += [f'fib {n:x}' for n in (0, 1, 2, 10, 20)]
funcs.append('''  (func (export "sum") (param i32) (result i64) (local i64)
    (block (loop
      (br_if 1 (i32.eqz (local.get 0)))
      (local.set 1 (i64.add (local.get 1) (i64.extend_i32_u (local.get 0))))
      (local.set 0 (i32.sub (local.get 0) (i32.const 1)))
      (br 0)))
    (local.get 1))''')
calls += [f'sum {n:x}' for n in (0, 1, 1000, 65536)]
funcs.append('''  (func (export "carry") (param i32) (result i32)
    (i32.add (i32.const 100)
      (block (result i32)
        (drop (br_if 0 (i32.const 7) (i32.eq (local.get 0) (i32.const 1))))
        (block (result i32) (br 1 (i32.const 9)))
        (drop) (i32.const 11))))''')
calls += [f'carry {n:x}' for n in (0, 1, 2)]
funcs.append('''  (func (export "table") (param i32) (result i32)
    (block (block (block (block
      (br_table 0 1 2 3 (local.get 0)))
      (return (i32.const 10)))
      (return (i32.const 20)))
      (return (i32.const 30)))
    (i32.const 40))''')
calls += [f'table {n:x}' for n in (0, 1, 2, 3, 4, 0xffffffff)]
funcs.append('''  (func (export "multi") (param i32 i32) (result i32 i32)
    (local.get 0) (local.get 1)
    (block (param i32 i32) (result i32 i32)
      (br_if 0 (i32.eqz (local.get 0)))
      (i32.sub)
      (i32.const 1))
    )''')
calls += ['multi 0 5', 'multi 9 5']
funcs.append('''  (func (export "early") (param i32) (result i32)
    (block (block
      (br_if 1 (local.get 0))
      (return (i32.const 1))
      (i32.const 99) (drop))
      (i32.const 98) (return))
    (i32.const 2))''')
calls += ['early 0', 'early 1']
funcs.append('''  (func (export "tee") (param i32) (result i32) (local i32)
    (i32.mul (local.tee 1 (i32.add (local.get 0) (i32.const 3))) (local.get 1)))''')
calls += ['tee 4', 'tee ffffffff']
funcs.append('''  (func (export "glob") (result i64)
    (global.set $g (i64.mul (global.get $g) (i64.const 3))) (global.get $g))''')
calls += ['glob'] * 3
funcs.append('''  (func $sq (param i32) (result i32) (i32.mul (local.get 0) (local.get 0)))
  (func $neg (param i64) (result i64) (i64.sub (i64.const 0) (local.get 0)))
  (func (export "ind") (param i32 i32) (result i32)
    (call_indirect (type $ii) (local.get 1) (local.get 0)))''')
calls += [f'ind {i:x} 6' for i in (0, 1, 2, 3, 4, 0x80000000)]
funcs.append('  (func (export "trap") (unreachable))')
calls += ['trap']

wat = f'''(module
  (type $ii (func (param i32) (result i32)))
  (memory 1)
  (table 4 funcref)
  (elem (i32.const 0) $fib $sq $neg)
  (global $g (mut i64) (i64.const 5))
{chr(10).join(funcs)}
)
'''
open(f'{out}/wasm-ops.wat', 'w').write(wat)
open(f'{out}/wasm-ops.calls', 'w').write('\n'.join(calls) + '\n')
print(f'{len(calls)} calls, {len(funcs)} functions')
