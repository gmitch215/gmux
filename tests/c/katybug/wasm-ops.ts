import { writeFileSync } from 'node:fs';
import { Random } from './random.ts';

/**
 * Writes a wasm module (wasm-ops.wat) that exports every integer instruction form katybug's wasm
 * frontend decodes, and the calls to make on it (wasm-ops.calls, one "export arg..." per line, hex).
 * V8 (wasm-ops.mjs) and katybug --wasm run the same calls; the two outputs must be equal.
 * `wasm-ops.ts <out dir>`
 */
const random = new Random(215);
const out = process.argv[2]!;
const E32: bigint[] = [
	0, 1, 2, 3, 7, 0x1f, 0x20, 0x21, 0x7f, 0x80, 0xff, 0x7fff, 0x8000, 0xffff, 0x7fffffff,
	0x80000000, 0x80000001, 0xfffffffe, 0xffffffff, 0x12345678, 0xdeadbeef
].map(BigInt);
for (let i = 0; i < 6; i++) E32.push(random.getrandbits(32));
const E64: bigint[] = [
	0n,
	1n,
	2n,
	63n,
	64n,
	65n,
	0x7fffffffn,
	0x80000000n,
	0xffffffffn,
	0x100000000n,
	0x7fffffffffffffffn,
	0x8000000000000000n,
	0x8000000000000001n,
	0xfffffffffffffffen,
	0xffffffffffffffffn,
	0x123456789abcdef0n,
	0xfedcba9876543210n
];
for (let i = 0; i < 6; i++) E64.push(random.getrandbits(64));

const funcs: string[] = [];
const calls: string[] = [];

function fn(name: string, params: string[], results: string[], body: string, inputs: bigint[][]) {
	const p = params.map((t) => `(param ${t})`).join(' ');
	const r = results.map((t) => `(result ${t})`).join(' ');
	funcs.push(`  (func (export "${name}") ${p} ${r}\n    ${body})`);
	for (const args of inputs) calls.push(name + args.map((a) => ` ${a.toString(16)}`).join(''));
}

const pairs = (edges: bigint[], n = 60) =>
	Array.from({ length: n }, () => [random.choice(edges), random.choice(edges)]);

const BIN = [
	'add',
	'sub',
	'mul',
	'div_s',
	'div_u',
	'rem_s',
	'rem_u',
	'and',
	'or',
	'xor',
	'shl',
	'shr_s',
	'shr_u',
	'rotl',
	'rotr'
];
const CMP = ['eq', 'ne', 'lt_s', 'lt_u', 'gt_s', 'gt_u', 'le_s', 'le_u', 'ge_s', 'ge_u'];
for (const [t, edges] of [
	['i32', E32],
	['i64', E64]
] as const) {
	for (const op of [...BIN, ...CMP]) {
		const rt = CMP.includes(op) ? 'i32' : t;
		fn(`${t}.${op}`, [t, t], [rt], `(${t}.${op} (local.get 0) (local.get 1))`, pairs(edges));
	}
	for (const op of ['clz', 'ctz', 'popcnt', 'eqz']) {
		const rt = op === 'eqz' ? 'i32' : t;
		fn(
			`${t}.${op}`,
			[t],
			[rt],
			`(${t}.${op} (local.get 0))`,
			edges.map((e) => [e])
		);
	}
	for (const op of ['extend8_s', 'extend16_s', ...(t === 'i64' ? ['extend32_s'] : [])])
		fn(
			`${t}.${op}`,
			[t],
			[t],
			`(${t}.${op} (local.get 0))`,
			edges.map((e) => [e])
		);
}
fn(
	'i32.wrap_i64',
	['i64'],
	['i32'],
	'(i32.wrap_i64 (local.get 0))',
	E64.map((e) => [e])
);
fn(
	'i64.extend_i32_s',
	['i32'],
	['i64'],
	'(i64.extend_i32_s (local.get 0))',
	E32.map((e) => [e])
);
fn(
	'i64.extend_i32_u',
	['i32'],
	['i64'],
	'(i64.extend_i32_u (local.get 0))',
	E32.map((e) => [e])
);
fn(
	'select',
	['i64', 'i64', 'i32'],
	['i64'],
	'(select (local.get 0) (local.get 1) (local.get 2))',
	pairs(E64, 8).flatMap(([a, b]) => [0n, 1n, 0x80000000n].map((c) => [a!, b!, c]))
);

// memory: every width and sign, stores then loads, at the edges of the one page and past it
const ADDRS = [0, 1, 7, 0x100, 0xfff8, 0xfffc, 0xfffe, 0xffff, 0x10000, 0xffffffff].map(BigInt);
const LOADS = [
	'i32.load',
	'i32.load8_s',
	'i32.load8_u',
	'i32.load16_s',
	'i32.load16_u',
	'i64.load',
	'i64.load8_s',
	'i64.load8_u',
	'i64.load16_s',
	'i64.load16_u',
	'i64.load32_s',
	'i64.load32_u'
];
const STORES: [string, 'i32' | 'i64'][] = [
	['i32.store', 'i32'],
	['i32.store8', 'i32'],
	['i32.store16', 'i32'],
	['i64.store', 'i64'],
	['i64.store8', 'i64'],
	['i64.store16', 'i64'],
	['i64.store32', 'i64']
];
for (const [st, vt] of STORES)
	fn(
		st.replace('.', '_'),
		['i32', vt],
		[],
		`(${st} offset=3 (local.get 0) (local.get 1))`,
		ADDRS.map((a) => [a, random.choice(vt === 'i32' ? E32 : E64)])
	);
for (const ld of LOADS)
	fn(
		ld.replace('.', '_'),
		['i32'],
		[ld.slice(0, 3)],
		`(${ld} offset=1 (local.get 0))`,
		ADDRS.map((a) => [a])
	);
fn('memory_size', [], ['i32'], '(memory.size)', [[]]);

// control flow, calls, globals
const hexes = (name: string, values: number[]) => values.map((n) => `${name} ${n.toString(16)}`);
funcs.push(`  (func $fib (export "fib") (param i32) (result i32)
    (if (result i32) (i32.lt_u (local.get 0) (i32.const 2))
      (then (local.get 0))
      (else (i32.add (call $fib (i32.sub (local.get 0) (i32.const 1)))
                     (call $fib (i32.sub (local.get 0) (i32.const 2)))))))`);
calls.push(...hexes('fib', [0, 1, 2, 10, 20]));
funcs.push(`  (func (export "sum") (param i32) (result i64) (local i64)
    (block (loop
      (br_if 1 (i32.eqz (local.get 0)))
      (local.set 1 (i64.add (local.get 1) (i64.extend_i32_u (local.get 0))))
      (local.set 0 (i32.sub (local.get 0) (i32.const 1)))
      (br 0)))
    (local.get 1))`);
calls.push(...hexes('sum', [0, 1, 1000, 65536]));
funcs.push(`  (func (export "carry") (param i32) (result i32)
    (i32.add (i32.const 100)
      (block (result i32)
        (drop (br_if 0 (i32.const 7) (i32.eq (local.get 0) (i32.const 1))))
        (block (result i32) (br 1 (i32.const 9)))
        (drop) (i32.const 11))))`);
calls.push(...hexes('carry', [0, 1, 2]));
funcs.push(`  (func (export "table") (param i32) (result i32)
    (block (block (block (block
      (br_table 0 1 2 3 (local.get 0)))
      (return (i32.const 10)))
      (return (i32.const 20)))
      (return (i32.const 30)))
    (i32.const 40))`);
calls.push(...hexes('table', [0, 1, 2, 3, 4, 0xffffffff]));
funcs.push(`  (func (export "multi") (param i32 i32) (result i32 i32)
    (local.get 0) (local.get 1)
    (block (param i32 i32) (result i32 i32)
      (br_if 0 (i32.eqz (local.get 0)))
      (i32.sub)
      (i32.const 1))
    )`);
calls.push('multi 0 5', 'multi 9 5');
funcs.push(`  (func (export "early") (param i32) (result i32)
    (block (block
      (br_if 1 (local.get 0))
      (return (i32.const 1))
      (i32.const 99) (drop))
      (i32.const 98) (return))
    (i32.const 2))`);
calls.push('early 0', 'early 1');
funcs.push(`  (func (export "tee") (param i32) (result i32) (local i32)
    (i32.mul (local.tee 1 (i32.add (local.get 0) (i32.const 3))) (local.get 1)))`);
calls.push('tee 4', 'tee ffffffff');
funcs.push(`  (func (export "glob") (result i64)
    (global.set $g (i64.mul (global.get $g) (i64.const 3))) (global.get $g))`);
calls.push('glob', 'glob', 'glob');
funcs.push(`  (func $sq (param i32) (result i32) (i32.mul (local.get 0) (local.get 0)))
  (func $neg (param i64) (result i64) (i64.sub (i64.const 0) (local.get 0)))
  (func (export "ind") (param i32 i32) (result i32)
    (call_indirect (type $ii) (local.get 1) (local.get 0)))`);
calls.push(...[0, 1, 2, 3, 4, 0x80000000].map((i) => `ind ${i.toString(16)} 6`));
funcs.push('  (func (export "trap") (unreachable))');
calls.push('trap');

const wat = `(module
  (type $ii (func (param i32) (result i32)))
  (memory 1)
  (table 4 funcref)
  (elem (i32.const 0) $fib $sq $neg)
  (global $g (mut i64) (i64.const 5))
${funcs.join('\n')}
)
`;
writeFileSync(`${out}/wasm-ops.wat`, wat);
writeFileSync(`${out}/wasm-ops.calls`, calls.join('\n') + '\n');
console.log(`${calls.length} calls, ${funcs.length} functions`);
