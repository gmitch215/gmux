import { Random } from './random.ts';

/**
 * Writes an AArch64 assembly program that runs every instruction form below on edge-case inputs and
 * prints, per case, x0-x3, NZCV and two words of memory. Run natively and under katybug, the two
 * outputs must be equal (`x86-ops-diff.ts ... --a64`). The floating point and SIMD cases also load
 * v0-v3 and record v0 as the two memory words. The NZCV word carries FPSR's cumulative bits (27 and
 * 7..0) and, in its top half, the word of an instruction that raised SIGILL (the handler skips it).
 * `a64-ops.ts > a64-ops.S`
 */
const random = new Random(215);
const EDGE: bigint[] = [
	0n,
	1n,
	2n,
	0x7fn,
	0x80n,
	0xffn,
	0x7fffn,
	0x8000n,
	0xffffn,
	0x7fffffffn,
	0x80000000n,
	0xffffffffn,
	0x100000000n,
	0x7fffffffffffffffn,
	0x8000000000000000n,
	0xffffffffffffffffn,
	0x123456789abcdef0n,
	0xfedcba9876543210n
];
for (let i = 0; i < 6; i++) EDGE.push(random.getrandbits(64));
for (let i = 0; i < 3; i++) EDGE.push(random.getrandbits(8));
// NZCV presets, bits 31..28
const FLAGS = [0, 0x20000000, 0x40000000, 0x60000000, 0x90000000, 0xf0000000];

// label, code, x0/x1 seeds, NZCV, and for the vector cases v0-v3 as lo/hi pairs
type Case = [string, string, bigint, bigint, number, bigint[]?];
const cases: Case[] = [];
const pairs = (n = 24): [bigint, bigint, number][] =>
	Array.from({ length: n }, () => [
		random.choice(EDGE),
		random.choice(EDGE),
		random.choice(FLAGS)
	]);
const add = (label: string, code: string, n?: number) =>
	pairs(n).forEach(([a, b, f], k) => cases.push([`${label}#${k}`, code, a, b, f]));

const R = { x: ['x0', 'x1', 'x2', 'x3'], w: ['w0', 'w1', 'w2', 'w3'] } as const;
const CONDS = [
	'eq',
	'ne',
	'cs',
	'cc',
	'mi',
	'pl',
	'vs',
	'vc',
	'hi',
	'ls',
	'ge',
	'lt',
	'gt',
	'le',
	'al',
	'nv'
];

// #region arithmetic
for (const s of ['x', 'w'] as const) {
	const [a, b, c] = R[s];
	for (const op of ['add', 'adds', 'sub', 'subs']) {
		add(`${op} ${s} reg`, `${op} ${a}, ${b}, ${c}`);
		for (const sh of ['lsl #1', 'lsl #31', 'lsr #3', 'asr #7'])
			add(`${op} ${s} ${sh}`, `${op} ${a}, ${b}, ${c}, ${sh}`, 8);
		// the extend's source is a w register except for uxtx/sxtx
		for (const ext of s === 'x'
			? ['uxtb', 'uxth', 'uxtw #2', 'sxtb #1', 'sxth', 'sxtw #3', 'uxtx #4']
			: ['uxtb', 'sxth #2', 'uxtw'])
			add(
				`${op} ${s} ${ext}`,
				`${op} ${a}, ${b}, ${ext.startsWith('uxtx') ? 'x2' : 'w2'}, ${ext}`,
				8
			);
		add(`${op} ${s} imm`, `${op} ${a}, ${b}, #0xabc`, 8);
		add(`${op} ${s} imm lsl12`, `${op} ${a}, ${b}, #0x7f, lsl #12`, 8);
	}
	for (const op of ['adc', 'adcs', 'sbc', 'sbcs']) add(`${op} ${s}`, `${op} ${a}, ${b}, ${c}`);
	for (const op of ['neg', 'negs', 'ngc', 'ngcs']) add(`${op} ${s}`, `${op} ${a}, ${b}`, 12);
	add(`cmp ${s}`, `cmp ${a}, ${b}`);
	add(`cmn ${s}`, `cmn ${a}, ${b}`);
	add(`cmp ${s} imm`, `cmp ${a}, #1`, 12);
}
// #endregion

// #region logic, moves, bitfields, shifts
const IMM64 = [
	'#0xff',
	'#0xff00ff00ff00ff00',
	'#0x5555555555555555',
	'#0x7ffffffffffffffe',
	'#0xfffffffffffff000'
];
const IMM32 = ['#0xff', '#0xff00ff00', '#0x55555555', '#0x7ffffffe', '#0xfffff000'];
for (const s of ['x', 'w'] as const) {
	const [a, b, c] = R[s];
	for (const op of ['and', 'orr', 'eor', 'ands', 'bic', 'bics', 'orn', 'eon']) {
		add(`${op} ${s} reg`, `${op} ${a}, ${b}, ${c}`, 16);
		add(`${op} ${s} ror`, `${op} ${a}, ${b}, ${c}, ror #13`, 8);
		add(`${op} ${s} lsr`, `${op} ${a}, ${b}, ${c}, lsr #1`, 8);
	}
	for (const op of ['and', 'orr', 'eor', 'ands'])
		for (const imm of s === 'x' ? IMM64 : IMM32)
			add(`${op} ${s} ${imm}`, `${op} ${a}, ${b}, ${imm}`, 4);
	add(`tst ${s}`, `tst ${a}, ${b}`, 12);
	add(`mvn ${s}`, `mvn ${a}, ${b}`, 8);
	for (const [op, imm] of [
		['movz', '#0x1234, lsl #16'],
		['movn', '#0x1234'],
		['movk', '#0xbeef, lsl #16'],
		['movk', '#0xbeef']
	])
		add(`${op} ${s} ${imm}`, `${op} ${a}, ${imm}`, 4);
	for (const op of ['lsl', 'lsr', 'asr', 'ror'])
		for (const n of [0, 1, 7, 31]) add(`${op} ${s} #${n}`, `${op} ${a}, ${b}, #${n}`, 6);
	for (const op of ['lslv', 'lsrv', 'asrv', 'rorv']) add(`${op} ${s}`, `${op} ${a}, ${b}, ${c}`);
	for (const [op, x, y] of [
		['sbfx', 3, 9],
		['ubfx', 3, 9],
		['sbfx', 0, 31],
		['ubfx', 17, 15],
		['bfi', 5, 11],
		['bfxil', 7, 13],
		['sbfiz', 4, 12],
		['ubfiz', 8, 20],
		['bfc', 2, 6]
	] as const)
		add(
			`${op} ${s} ${x},${y}`,
			op === 'bfc' ? `bfc ${a}, #${x}, #${y}` : `${op} ${a}, ${b}, #${x}, #${y}`,
			6
		);
	for (const op of ['sxtb', 'sxth', 'uxtb', 'uxth']) add(`${op} ${s}`, `${op} ${a}, w1`, 8);
	add(`extr ${s} #5`, `extr ${a}, ${b}, ${c}, #5`, 12);
}
add('sxtw', 'sxtw x0, w1', 12);
add('add sp', 'mov x9, sp\n\tmov sp, x4\n\tadd sp, sp, #16\n\tsub x0, sp, x4\n\tmov sp, x9', 4);
// #endregion

// #region multiply, divide, bit operations
for (const s of ['x', 'w'] as const) {
	const [a, b, c, d] = R[s];
	add(`mul ${s}`, `mul ${a}, ${b}, ${c}`);
	add(`madd ${s}`, `madd ${a}, ${b}, ${c}, ${d}`);
	add(`msub ${s}`, `msub ${a}, ${b}, ${c}, ${d}`);
	add(`mneg ${s}`, `mneg ${a}, ${b}, ${c}`, 12);
	for (const op of ['udiv', 'sdiv']) add(`${op} ${s}`, `${op} ${a}, ${b}, ${c}`, 32);
	for (const op of ['clz', 'cls', 'rbit', 'rev', 'rev16'])
		add(`${op} ${s}`, `${op} ${a}, ${b}`, 16);
}
add('rev32', 'rev32 x0, x1', 16);
for (const op of ['smull', 'umull', 'smulh', 'umulh', 'smnegl', 'umnegl'])
	add(op, op.endsWith('h') ? `${op} x0, x1, x2` : `${op} x0, w1, w2`);
for (const op of ['smaddl', 'umaddl', 'smsubl', 'umsubl']) add(op, `${op} x0, w1, w2, x3`);
for (const op of ['crc32b', 'crc32h', 'crc32w', 'crc32cb', 'crc32ch', 'crc32cw'])
	add(op, `${op} w0, w1, w2`, 12);
for (const op of ['crc32x', 'crc32cx']) add(op, `${op} w0, w1, x2`, 12);
// #endregion

// #region conditional select, compare, branches
for (const cond of CONDS) {
	add(`csel ${cond}`, `csel x0, x1, x2, ${cond}`, 6);
	add(`csinc ${cond}`, `csinc w0, w1, w2, ${cond}`, 6);
	add(`csinv ${cond}`, `csinv x0, x1, x2, ${cond}`, 6);
	add(`csneg ${cond}`, `csneg x0, x1, x2, ${cond}`, 6);
	if (cond !== 'al' && cond !== 'nv') {
		add(`cset ${cond}`, `cset w0, ${cond}`, 6);
		add(`csetm ${cond}`, `csetm x0, ${cond}`, 6);
		add(`cinc ${cond}`, `cinc x0, x1, ${cond}`, 6);
	}
	add(`ccmp ${cond}`, `ccmp x1, x2, #0b1010, ${cond}`, 6);
	add(`ccmn ${cond} imm`, `ccmn w1, #7, #0b0101, ${cond}`, 6);
	add(`b.${cond}`, `mov x0, #1\n\tb.${cond} 1f\n\tmov x0, #2\n1:`, 6);
}
for (const [op, s] of [
	['cbz', 'x'],
	['cbnz', 'x'],
	['cbz', 'w'],
	['cbnz', 'w']
] as const)
	add(`${op} ${s}`, `mov x0, #1\n\t${op} ${s}1, 1f\n\tmov x0, #2\n1:`, 12);
for (const op of ['tbz', 'tbnz'])
	for (const bit of [0, 7, 31, 32, 63])
		add(`${op} #${bit}`, `mov x0, #1\n\t${op} x1, #${bit}, 1f\n\tmov x0, #2\n1:`, 4);
add('adrp', 'adrp x0, buf\n\tadd x0, x0, :lo12:buf\n\tsub x0, x0, x4', 2);
add('adr', 'adr x0, 1f\n\tadr x1, 2f\n1:\tnop\n2:\tsub x0, x1, x0', 2);
// #endregion

// #region loads and stores (x4 holds buf; the two recorded words are buf[0] and buf[8])
const MEM: [string, string][] = [];
for (const [op, reg] of [
	['ldr', 'x0'],
	['ldr', 'w0'],
	['ldrh', 'w0'],
	['ldrb', 'w0'],
	['ldrsb', 'x0'],
	['ldrsb', 'w0'],
	['ldrsh', 'x0'],
	['ldrsh', 'w0'],
	['ldrsw', 'x0'],
	['str', 'x1'],
	['str', 'w1'],
	['strh', 'w1'],
	['strb', 'w1']
] as const) {
	MEM.push([
		`${op} ${reg} off`,
		`${op} ${reg}, [x4, #${op.includes('b') ? 3 : op.includes('h') ? 2 : 8}]`
	]);
	MEM.push([
		`${op.replace('ldr', 'ldur').replace('str', 'stur')} ${reg}`,
		`${op.replace('ldr', 'ldur').replace('str', 'stur')} ${reg}, [x4, #5]`
	]);
	MEM.push([`${op} ${reg} pre`, `add x3, x4, #16\n\t${op} ${reg}, [x3, #-8]!\n\tsub x3, x3, x4`]);
	MEM.push([`${op} ${reg} post`, `mov x3, x4\n\t${op} ${reg}, [x3], #4\n\tsub x3, x3, x4`]);
	MEM.push([`${op} ${reg} reg`, `and x2, x2, #7\n\t${op} ${reg}, [x4, x2]`]);
	MEM.push([`${op} ${reg} sxtw`, `mov w2, #1\n\t${op} ${reg}, [x4, w2, sxtw]`]);
}
MEM.push(['ldr x0 lsl', 'mov x2, #1\n\tldr x0, [x4, x2, lsl #3]']);
MEM.push(['ldr w0 uxtw', 'mov w2, #1\n\tldr w0, [x4, w2, uxtw #2]']);
for (const [op, regs] of [
	['ldp', 'x0, x1'],
	['ldp', 'w0, w1'],
	['ldpsw', 'x0, x1'],
	['stp', 'x1, x2'],
	['stp', 'w1, w2']
] as const) {
	MEM.push([`${op} ${regs}`, `${op} ${regs}, [x4]`]);
	MEM.push([
		`${op} ${regs} pre`,
		`add x3, x4, #16\n\t${op} ${regs}, [x3, #-16]!\n\tsub x3, x3, x4`
	]);
	MEM.push([`${op} ${regs} post`, `mov x3, x4\n\t${op} ${regs}, [x3], #8\n\tsub x3, x3, x4`]);
}
for (const [op, reg] of [
	['ldxr', 'x0'],
	['ldaxr', 'w0'],
	['ldar', 'x0'],
	['stlr', 'x1']
] as const)
	MEM.push([`${op} ${reg}`, `${op} ${reg}, [x4]`]);
MEM.push(['stxr', 'ldxr x9, [x4]\n\tstxr w3, x1, [x4]']);
// a cleared monitor fails the store and leaves memory; pairs move both registers
MEM.push(['stxr after clrex', 'ldxr x9, [x4]\n\tclrex\n\tstxr w3, x1, [x4]']);
MEM.push(['ldxp stxp', 'ldxp x0, x2, [x4]\n\tstxp w3, x1, x0, [x4]']);
MEM.push(['ldaxp stlxp w', 'ldaxp w0, w2, [x4]\n\tstlxp w3, w1, w0, [x4]']);
MEM.push(['ldr literal', 'ldr x0, 1f\n\tb 2f\n\t.balign 8\n1:\t.quad 0x1122334455667788\n2:']);
for (const [label, code] of MEM) add(label, code, 12);
// #endregion

// #region floating point and Advanced SIMD inputs
const bitsOf = (x: number, dbl: boolean) => {
	const v = new DataView(new ArrayBuffer(8));
	if (dbl) {
		v.setFloat64(0, x);
		return v.getBigUint64(0);
	}
	v.setFloat32(0, x);
	return BigInt(v.getUint32(0));
};
const S: bigint[] = [
	0x00000000, 0x80000000, 0x00000001, 0x807fffff, 0x00800000, 0x7f7fffff, 0xff7fffff, 0x7f800000,
	0xff800000, 0x7fc00000, 0xffc00001, 0x7fd23456, 0x7f800001, 0xff800001, 0x7fa00005, 0x7fbfffff
]
	.map(BigInt)
	.concat(
		[
			1,
			-1,
			0.5,
			-0.5,
			1.5,
			-1.5,
			2.5,
			-2.5,
			3,
			0.49999997,
			0.99999994,
			1.0000001,
			1 / 3,
			Math.PI,
			8388609,
			16777215,
			2147483520,
			2147483648,
			-2147483648,
			-2147483904,
			4294967040,
			4294967296,
			9223371487098961920,
			9223372036854775808,
			-9223372036854775808,
			18446744073709551616,
			65504,
			65520,
			65519.996,
			5.9604645e-8,
			2.9802322e-8,
			6.1035156e-5,
			1e-40,
			-1e-45,
			1e38,
			3.4e38
		].map((x) => bitsOf(x, false))
	);
const D: bigint[] = [
	0n,
	1n << 63n,
	1n,
	0x800fffffffffffffn,
	0x0010000000000000n,
	0x7fefffffffffffffn,
	0xffefffffffffffffn,
	0x7ff0000000000000n,
	0xfff0000000000000n,
	0x7ff8000000000000n,
	0xfff8000000000001n,
	0x7ff8dead0000beefn,
	0x7ff0000000000001n,
	0xfff4000000abcdefn,
	0x7ff7ffffffffffffn
].concat(
	[
		1,
		-1,
		0.5,
		-0.5,
		1.5,
		-1.5,
		2.5,
		-2.5,
		3,
		0.49999999999999994,
		0.9999999999999999,
		1.0000000000000002,
		1 / 3,
		Math.PI,
		2147483647,
		2147483647.5,
		2147483648,
		-2147483648,
		-2147483648.5,
		-2147483649,
		4294967295,
		4294967295.5,
		4294967296,
		-0.9999,
		4503599627370497,
		9223372036854774784,
		9223372036854775808,
		-9223372036854775808,
		-9223372036854777856,
		18446744073709549568,
		18446744073709551616,
		1e300,
		-1e-310,
		5e-324,
		3.4028234663852886e38,
		3.4028235677973366e38,
		1.1754942106924411e-38,
		1.401298464324817e-45,
		7.006492321624085e-46,
		1.0000000596046448,
		1.0000001788139343,
		65504,
		65520,
		65519.99999999999,
		2.9802322387695312e-8,
		1e-5
	].map((x) => bitsOf(x, true))
);
const H: bigint[] = [
	0x0000, 0x8000, 0x0001, 0x8001, 0x03ff, 0x0400, 0x7bff, 0xfbff, 0x7c00, 0xfc00, 0x7e00, 0xfe00,
	0x7c01, 0x7d55, 0xfd00, 0x3c00, 0xbc00, 0x3800, 0x3555, 0x0200
].map(BigInt);
// integers for scvtf/ucvtf: halfway and just-past-halfway at 24 and 53 bits
const CVT: bigint[] = [
	0n,
	1n,
	3n,
	0xfffffffffffffffdn,
	0x7fffffffn,
	0x80000000n,
	0xffffffffn,
	0x1000001n,
	0x1000003n,
	0xffffffffff000001n,
	0x20000000000001n,
	0x20000000000003n,
	0x7fffffffffffffffn,
	0x8000000000000000n,
	0xffffffffffffffffn,
	0x8000008000000000n,
	0x7fffff4000000000n
];
const g64 = () => random.getrandbits(64);
const BYTES = [0n, 1n, 0x7fn, 0x80n, 0x81n, 0xfen, 0xffn];
const i64 = () => {
	const k = random.randbelow(3);
	if (k === 0) return g64();
	if (k === 1) return random.choice(EDGE);
	let v = 0n;
	for (let j = 0n; j < 64n; j += 8n)
		v |= (random.randbelow(2) ? random.choice(BYTES) : random.getrandbits(8)) << j;
	return v;
};
const pick = (pool: bigint[], bits: number) =>
	random.randbelow(6) ? random.choice(pool) : random.getrandbits(bits);
const pair = (f: () => bigint): [bigint, bigint] => {
	const lo = f();
	return [lo, f()];
};
// one v register: i integer lanes, s/d/h a scalar over garbage, S four singles, D two doubles,
// t table indices; a kind may look at the registers before it (lo, hi pairs)
const KIND: Record<string, (prev: bigint[]) => [bigint, bigint]> = {
	i: () => pair(i64),
	s: () => [(g64() & ~0xffffffffn) | pick(S, 32), g64()],
	d: () => [pick(D, 64), g64()],
	h: () => [(g64() & ~0xffffn) | pick(H, 16), g64()],
	// s and d, half of them denormal
	u: () => [
		(g64() & ~0xffffffffn) |
			(random.randbelow(2)
				? random.getrandbits(23) | (random.getrandbits(1) << 31n)
				: pick(S, 32)),
		g64()
	],
	U: () => [
		random.randbelow(2) ? random.getrandbits(52) | (random.getrandbits(1) << 63n) : pick(D, 64),
		g64()
	],
	S: () => pair(() => pick(S, 32) | (pick(S, 32) << 32n)),
	D: () => pair(() => pick(D, 64)),
	t: () =>
		pair(() => {
			let v = 0n;
			for (let j = 0n; j < 64n; j += 8n) v |= BigInt(random.randbelow(40)) << j;
			return v;
		})
};
// a label is split at its first # into form and case
const addV = (label: string, code: string, kinds: string, n = 8, ints = EDGE) => {
	for (let k = 0; k < n; k++) {
		const a = random.choice(EDGE);
		const b = random.choice(ints);
		const f = random.choice(FLAGS);
		const v: bigint[] = [];
		for (const c of kinds) v.push(...KIND[c]!(v));
		cases.push([`${label.replaceAll('#', '')}#${k}`, code, a, b, f, v]);
	}
};
const opLine = (code: string) => code.split('\n\t').find((l) => !/^(mov|add|sub) x/.test(l))!;
const MODES = [
	[1, 'rp'],
	[2, 'rm'],
	[3, 'rz']
] as const;
// FPCR for the rest of the case
const fpcr = (v: number) => `mov x9, #${v}\n\tmsr fpcr, x9\n\t`;
const rmode = (mode: number) => fpcr(mode << 22);
// #endregion

// #region scalar floating point
for (const t of ['s', 'd'] as const) {
	for (const op of ['fadd', 'fsub', 'fmul', 'fdiv', 'fmax', 'fmin', 'fmaxnm', 'fminnm', 'fnmul'])
		addV(`${op} ${t}`, `${op} ${t}0, ${t}1, ${t}2`, `i${t}${t}i`, 24);
	for (const op of ['fabs', 'fneg', 'fsqrt', 'fmov'])
		addV(`${op} ${t}`, `${op} ${t}0, ${t}1`, `i${t}ii`, 16);
	for (const op of ['fmadd', 'fmsub', 'fnmadd', 'fnmsub'])
		addV(`${op} ${t}`, `${op} ${t}0, ${t}1, ${t}2, ${t}3`, `i${t}${t}${t}`, 24);
	for (const op of ['fcmp', 'fcmpe']) {
		addV(`${op} ${t}`, `${op} ${t}1, ${t}2`, `i${t}${t}i`, 16);
		addV(`${op} ${t} zero`, `${op} ${t}1, #0.0`, `i${t}ii`, 12);
	}
	for (const cond of ['eq', 'ne', 'ge', 'lt', 'hi', 'vs']) {
		for (const op of ['fccmp', 'fccmpe'])
			addV(`${op} ${t} ${cond}`, `${op} ${t}1, ${t}2, #0b1010, ${cond}`, `i${t}${t}i`, 6);
		addV(`fcsel ${t} ${cond}`, `fcsel ${t}0, ${t}1, ${t}2, ${cond}`, `i${t}${t}i`, 6);
	}
	for (const [mode, name] of MODES)
		for (const op of ['fadd', 'fmul', 'fdiv', 'fsqrt'])
			addV(
				`${op} ${t} ${name}`,
				`${rmode(mode)}${op} ${t}0, ${t}1${op === 'fsqrt' ? '' : `, ${t}2`}`,
				`i${t}${t}i`,
				8
			);
	for (const op of [
		'fcvtzs',
		'fcvtzu',
		'fcvtns',
		'fcvtnu',
		'fcvtas',
		'fcvtau',
		'fcvtms',
		'fcvtmu',
		'fcvtps',
		'fcvtpu'
	])
		for (const r of ['w', 'x']) addV(`${op} ${r} ${t}`, `${op} ${r}0, ${t}1`, `i${t}ii`, 12);
	for (const op of ['scvtf', 'ucvtf'])
		for (const r of ['w', 'x']) {
			addV(`${op} ${t} ${r}`, `${op} ${t}0, ${r}1`, 'iiii', 16, CVT);
			for (const [mode, name] of MODES)
				addV(`${op} ${t} ${r} ${name}`, `${rmode(mode)}${op} ${t}0, ${r}1`, 'iiii', 6, CVT);
		}
	for (const r of ['w', 'x'])
		for (const fb of r === 'w' ? [1, 17, 32] : [1, 33, 64]) {
			for (const op of ['fcvtzs', 'fcvtzu'])
				addV(`${op} ${r} ${t} fbits${fb}`, `${op} ${r}0, ${t}1, #${fb}`, `i${t}ii`, 8);
			for (const op of ['scvtf', 'ucvtf'])
				addV(`${op} ${t} ${r} fbits${fb}`, `${op} ${t}0, ${r}1, #${fb}`, 'iiii', 8, CVT);
		}
	for (const op of ['frintn', 'frintp', 'frintm', 'frintz', 'frinta', 'frintx', 'frinti'])
		addV(`${op} ${t}`, `${op} ${t}0, ${t}1`, `i${t}ii`, 16);
	for (const [mode, name] of MODES)
		for (const op of ['frintx', 'frinti'])
			addV(`${op} ${t} ${name}`, `${rmode(mode)}${op} ${t}0, ${t}1`, `i${t}ii`, 12);
	for (const imm of ['1.0', '-2.0', '0.125', '31.0', '-1.9375', '15.5'])
		addV(`fmov ${t} imm ${imm}`, `fmov ${t}0, #${imm}`, 'iiii', 1);
	// FPCR.FZ (flush denormals to zero) and FPCR.DN (default NaN)
	for (const [bits, name] of [
		[1 << 24, 'fz'],
		[1 << 25, 'dn']
	] as const)
		for (const op of ['fadd', 'fmul', 'fmaxnm'])
			addV(
				`${op} ${t} ${name}`,
				`${fpcr(bits)}${op} ${t}0, ${t}1, ${t}2`,
				t === 's' ? 'iuui' : 'iUUi',
				8
			);
}
for (const [d, s] of [
	['d', 's'],
	['s', 'd'],
	['h', 's'],
	['s', 'h'],
	['h', 'd'],
	['d', 'h']
] as const)
	addV(`fcvt ${d} ${s}`, `fcvt ${d}0, ${s}1`, `i${s}ii`, 24);
for (const [mode, name] of MODES)
	for (const [d, s] of [
		['s', 'd'],
		['h', 's'],
		['h', 'd']
	] as const)
		addV(`fcvt ${d} ${s} ${name}`, `${rmode(mode)}fcvt ${d}0, ${s}1`, `i${s}ii`, 8);
for (const [code, kinds] of [
	['fmov w0, s1', 'isii'],
	['fmov x0, d1', 'idii'],
	['fmov s0, w1', 'iiii'],
	['fmov d0, x1', 'iiii'],
	['fmov x0, v1.d[1]', 'iiii'],
	['fmov v0.d[1], x1', 'iiii']
])
	addV(code, code, kinds, 8);
for (const a of ['2s', '4s', '2d'])
	for (const imm of ['1.0', '-0.1875', '31.0'])
		addV(`fmov ${a} imm ${imm}`, `fmov v0.${a}, #${imm}`, 'iiii', 1);
// #endregion

// #region Advanced SIMD integer
const ARR = ['8b', '16b', '4h', '8h', '2s', '4s', '2d'];
const esize = (a: string) => 8 << 'bhsd'.indexOf(a.slice(-1));
for (const a of ARR) {
	const v3 = `v0.${a}, v1.${a}, v2.${a}`;
	for (const op of ['add', 'sub', 'cmeq', 'cmgt', 'cmhi', 'cmge', 'cmhs', 'cmtst', 'addp'])
		addV(`${op} ${a}`, `${op} ${v3}`, 'iiii', 4);
	for (const op of ['zip1', 'zip2', 'uzp1', 'uzp2', 'trn1', 'trn2'])
		addV(`${op} ${a}`, `${op} ${v3}`, 'iiii', 4);
	if (a !== '2d') {
		for (const op of ['mul', 'mla', 'mls', 'umax', 'umin', 'smax', 'smin', 'umaxp', 'sminp'])
			addV(`${op} ${a}`, `${op} ${v3}`, 'iiii', 4);
		for (const op of ['shadd', 'uhadd', 'srhadd', 'urhadd', 'sabd', 'uabd'])
			addV(`${op} ${a}`, `${op} ${v3}`, 'iiii', 3);
	}
	for (const op of ['sqadd', 'uqadd', 'sqsub', 'uqsub', 'sshl', 'ushl'])
		addV(`${op} ${a}`, `${op} ${v3}`, 'iiii', 3);
	for (const op of ['cmeq', 'cmgt', 'cmlt', 'cmge', 'cmle'])
		addV(`${op} ${a} zero`, `${op} v0.${a}, v1.${a}, #0`, 'iiii', 4);
	for (const op of ['neg', 'abs']) addV(`${op} ${a}`, `${op} v0.${a}, v1.${a}`, 'iiii', 4);
	const es = esize(a);
	for (const sh of [1, es - 1]) {
		addV(`shl ${a} ${sh}`, `shl v0.${a}, v1.${a}, #${sh}`, 'iiii', 3);
		addV(`sli ${a} ${sh}`, `sli v0.${a}, v1.${a}, #${sh}`, 'iiii', 3);
	}
	for (const sh of [1, es])
		for (const op of ['ushr', 'sshr', 'sri', 'usra', 'ssra'])
			addV(`${op} ${a} ${sh}`, `${op} v0.${a}, v1.${a}, #${sh}`, 'iiii', 3);
}
for (const a of ['8b', '16b']) {
	const v3 = `v0.${a}, v1.${a}, v2.${a}`;
	for (const op of ['and', 'orr', 'eor', 'bic', 'orn', 'bsl', 'bit', 'bif'])
		addV(`${op} ${a}`, `${op} ${v3}`, 'iiii', 8);
	for (const op of ['cnt', 'not', 'rbit', 'rev64', 'rev32', 'rev16'])
		addV(`${op} ${a}`, `${op} v0.${a}, v1.${a}`, 'iiii', 6);
	for (const pos of a === '8b' ? [1, 7] : [0, 3, 8, 15])
		addV(`ext ${a} ${pos}`, `ext ${v3}, #${pos}`, 'iiii', 4);
}
for (const a of ['4h', '8h', '2s', '4s']) {
	addV(`rev64 ${a}`, `rev64 v0.${a}, v1.${a}`, 'iiii', 4);
	if (a.endsWith('h')) addV(`rev32 ${a}`, `rev32 v0.${a}, v1.${a}`, 'iiii', 4);
}
for (const [a, s] of [
	['8b', 'b'],
	['16b', 'b'],
	['4h', 'h'],
	['8h', 'h'],
	['4s', 's']
] as const) {
	for (const op of ['addv', 'umaxv', 'uminv', 'smaxv', 'sminv'])
		addV(`${op} ${a}`, `${op} ${s}0, v1.${a}`, 'iiii', 6);
	const wide = { b: 'h', h: 's', s: 'd' }[s];
	for (const op of ['uaddlv', 'saddlv']) addV(`${op} ${a}`, `${op} ${wide}0, v1.${a}`, 'iiii', 6);
}
for (const code of [
	'dup v0.16b, v1.b[5]',
	'dup v0.8b, v1.b[15]',
	'dup v0.8h, v1.h[7]',
	'dup v0.2s, v1.s[1]',
	'dup v0.4s, v1.s[3]',
	'dup v0.2d, v1.d[1]',
	'dup v0.16b, w1',
	'dup v0.4h, w1',
	'dup v0.4s, w1',
	'dup v0.2d, x1',
	'mov v0.b[3], v1.b[9]',
	'mov v0.h[7], v1.h[0]',
	'mov v0.s[1], v1.s[3]',
	'mov v0.d[1], v1.d[0]',
	'mov v0.b[15], w1',
	'mov v0.h[2], w1',
	'mov v0.s[3], w1',
	'mov v0.d[0], x1',
	'umov w0, v1.b[13]',
	'umov w0, v1.h[5]',
	'umov w0, v1.s[3]',
	'umov x0, v1.d[1]',
	'smov w0, v1.b[7]',
	'smov x0, v1.b[15]',
	'smov w0, v1.h[3]',
	'smov x0, v1.h[6]',
	'smov x0, v1.s[2]',
	'tbl v0.16b, {v1.16b}, v3.16b',
	'tbl v0.8b, {v1.16b}, v3.8b',
	'tbl v0.16b, {v1.16b, v2.16b}, v3.16b',
	'tbx v0.16b, {v1.16b}, v3.16b',
	'tbx v0.8b, {v1.16b, v2.16b}, v3.8b',
	'movi v0.16b, #0xa5',
	'movi v0.8b, #0xff',
	'movi v0.4h, #0x12, lsl #8',
	'movi v0.4s, #0x34, lsl #24',
	'movi v0.2s, #0x56, msl #8',
	'movi v0.4s, #0x56, msl #16',
	'movi d0, #0xff00ff0000ff00ff',
	'movi v0.2d, #0xffffffff00000000',
	'mvni v0.8h, #0x7f',
	'mvni v0.4s, #0x80, lsl #16',
	'mvni v0.2s, #0x1, msl #8',
	'orr v0.4s, #0x11, lsl #8',
	'bic v0.8h, #0xff',
	'bic v0.2s, #0x3, lsl #24',
	'shrn v0.8b, v1.8h, #1',
	'shrn2 v0.16b, v1.8h, #8',
	'shrn v0.4h, v1.4s, #16',
	'shrn2 v0.8h, v1.4s, #3',
	'shrn v0.2s, v1.2d, #32',
	'shrn2 v0.4s, v1.2d, #1',
	'ushll v0.8h, v1.8b, #0',
	'sshll v0.4s, v1.4h, #3',
	'ushll2 v0.2d, v1.4s, #31',
	'sshll2 v0.8h, v1.16b, #7',
	'uxtl v0.4s, v1.4h',
	'sxtl2 v0.2d, v1.4s',
	'xtn v0.8b, v1.8h',
	'xtn2 v0.16b, v1.8h',
	'xtn v0.4h, v1.4s',
	'xtn2 v0.4s, v1.2d'
])
	addV(code, code, code.startsWith('tb') ? 'iiit' : 'iiii', 4);
for (const [w, n, n2] of [
	['8h', '8b', '16b'],
	['4s', '4h', '8h'],
	['2d', '2s', '4s']
] as const) {
	for (const op of [
		'saddl',
		'uaddl',
		'ssubl',
		'usubl',
		'smull',
		'umull',
		'smlal',
		'umlal',
		'smlsl',
		'umlsl',
		'sabdl',
		'uabdl'
	]) {
		addV(`${op} ${w}`, `${op} v0.${w}, v1.${n}, v2.${n}`, 'iiii', 3);
		addV(`${op}2 ${w}`, `${op}2 v0.${w}, v1.${n2}, v2.${n2}`, 'iiii', 3);
	}
	for (const op of ['saddw', 'uaddw', 'ssubw', 'usubw']) {
		addV(`${op} ${w}`, `${op} v0.${w}, v1.${w}, v2.${n}`, 'iiii', 3);
		addV(`${op}2 ${w}`, `${op}2 v0.${w}, v1.${w}, v2.${n2}`, 'iiii', 3);
	}
	for (const op of ['addhn', 'subhn', 'raddhn', 'rsubhn']) {
		addV(`${op} ${w}`, `${op} v0.${n}, v1.${w}, v2.${w}`, 'iiii', 3);
		addV(`${op}2 ${w}`, `${op}2 v0.${n2}, v1.${w}, v2.${w}`, 'iiii', 3);
	}
}
// #endregion

// #region Advanced SIMD floating point, and the scalar forms
for (const a of ['2s', '4s', '2d']) {
	const k = a === '2d' ? 'D' : 'S';
	for (const op of [
		'fadd',
		'fsub',
		'fmul',
		'fdiv',
		'fmax',
		'fmin',
		'fmaxnm',
		'fminnm',
		'faddp',
		'fmla',
		'fmls',
		'fcmeq',
		'fcmge',
		'fcmgt'
	])
		addV(`${op} ${a}`, `${op} v0.${a}, v1.${a}, v2.${a}`, `${k}${k}${k}i`, 6);
	for (const op of [
		'fabs',
		'fneg',
		'fsqrt',
		'frintn',
		'frintp',
		'frintm',
		'frintz',
		'frinta',
		'frintx',
		'frinti'
	])
		addV(`${op} ${a}`, `${op} v0.${a}, v1.${a}`, `i${k}ii`, 4);
	for (const op of [
		'fcvtzs',
		'fcvtzu',
		'fcvtns',
		'fcvtnu',
		'fcvtas',
		'fcvtau',
		'fcvtms',
		'fcvtmu',
		'fcvtps',
		'fcvtpu'
	])
		addV(`${op} ${a}`, `${op} v0.${a}, v1.${a}`, `i${k}ii`, 4);
	for (const op of ['scvtf', 'ucvtf']) addV(`${op} ${a}`, `${op} v0.${a}, v1.${a}`, 'iiii', 4);
	for (const op of ['fcmeq', 'fcmge', 'fcmgt', 'fcmle', 'fcmlt'])
		addV(`${op} ${a} zero`, `${op} v0.${a}, v1.${a}, #0.0`, `i${k}ii`, 4);
	addV(`frintx ${a} rm`, `${rmode(2)}frintx v0.${a}, v1.${a}`, `i${k}ii`, 4);
}
for (const [code, kinds] of [
	['fcvtl v0.2d, v1.2s', 'iSii'],
	['fcvtn v0.2s, v1.2d', 'iDii'],
	['fcvtzs v0.4s, v1.4s, #3', 'iSii'],
	['scvtf v0.2d, v1.2d, #10', 'iiii'],
	['fmul v0.4s, v1.4s, v2.s[1]', 'SSSi'],
	['fmla v0.2d, v1.2d, v2.d[1]', 'DDDi'],
	['fmaxv s0, v1.4s', 'iSii'],
	['fabd v0.4s, v1.4s, v2.4s', 'SSSi'],
	['add d0, d1, d2', 'iiii'],
	['sub d0, d1, d2', 'iiii'],
	['cmeq d0, d1, d2', 'iiii'],
	['cmgt d0, d1, d2', 'iiii'],
	['cmhi d0, d1, d2', 'iiii'],
	['cmge d0, d1, d2', 'iiii'],
	['cmhs d0, d1, d2', 'iiii'],
	['cmtst d0, d1, d2', 'iiii'],
	['sshl d0, d1, d2', 'iiii'],
	['ushl d0, d1, d2', 'iiii'],
	['sqadd d0, d1, d2', 'iiii'],
	['uqsub d0, d1, d2', 'iiii'],
	['neg d0, d1', 'iiii'],
	['abs d0, d1', 'iiii'],
	['cmeq d0, d1, #0', 'iiii'],
	['cmgt d0, d1, #0', 'iiii'],
	['cmlt d0, d1, #0', 'iiii'],
	['ushr d0, d1, #1', 'iiii'],
	['ushr d0, d1, #64', 'iiii'],
	['sshr d0, d1, #63', 'iiii'],
	['sshr d0, d1, #64', 'iiii'],
	['shl d0, d1, #1', 'iiii'],
	['shl d0, d1, #63', 'iiii'],
	['usra d0, d1, #7', 'iiii'],
	['ssra d0, d1, #64', 'iiii'],
	['addp d0, v1.2d', 'iiii'],
	['faddp s0, v1.2s', 'iSii'],
	['faddp d0, v1.2d', 'iDii'],
	['mov b0, v1.b[7]', 'iiii'],
	['mov h0, v1.h[3]', 'iiii'],
	['mov s0, v1.s[3]', 'iiii'],
	['mov d0, v1.d[1]', 'iiii'],
	['fcvtzs s0, s1', 'isii'],
	['fcvtzu d0, d1', 'idii'],
	['fcvtns s0, s1', 'isii'],
	['scvtf s0, s1', 'iiii'],
	['ucvtf d0, d1', 'iiii'],
	['fcmeq s0, s1, #0.0', 'isii'],
	['fcmlt d0, d1, #0.0', 'idii'],
	['fcmeq d0, d1, d2', 'iddi'],
	['fcmgt s0, s1, s2', 'issi'],
	['fcmge d0, d1, d2', 'iddi'],
	['fabd s0, s1, s2', 'issi']
])
	addV(code, code, kinds, 6);
// the writable bits of FPSR and FPCR
add('msr mrs fpsr', 'msr fpsr, x1\n\tmrs x0, fpsr\n\tmsr fpsr, xzr', 8);
add('msr mrs fpcr', 'msr fpcr, x1\n\tmrs x0, fpcr\n\tmsr fpcr, xzr', 8);
// #endregion

// #region vector loads and stores (buf[16..64) is filled from x0-x3 first; stores are read back into
// x0-x3, loads leave v1 and v2 in x0-x3)
const FILL = 'stp x0, x1, [x4, #16]\n\tstp x2, x3, [x4, #32]\n\tstp x3, x0, [x4, #48]\n\t';
const V12 = '\n\tmov x0, v1.d[0]\n\tmov x1, v1.d[1]\n\tmov x2, v2.d[0]\n\tmov x3, v2.d[1]';
const BACK = '\n\tldp x0, x1, [x4, #16]\n\tldp x2, x3, [x4, #32]';
for (const code of [
	'ldr s0, [x4, #12]',
	'ldr d0, [x4, #24]',
	'ldr q0, [x4, #16]',
	'ldr b0, [x4, #5]',
	'ldr h0, [x4, #6]',
	'ldur q0, [x4, #3]',
	'ldur d0, [x4, #1]',
	'mov x5, #17\n\tldr q0, [x4, x5]',
	'mov x5, #3\n\tldr d0, [x4, x5, lsl #3]',
	'add x5, x4, #32\n\tldr q0, [x5, #-16]!\n\tsub x0, x5, x4',
	'mov x5, x4\n\tldr d0, [x5], #24\n\tsub x0, x5, x4',
	'ldp s0, s1, [x4, #8]',
	'ldp d1, d2, [x4, #16]',
	'ldp q1, q2, [x4, #16]',
	'ldr s1, 1f\n\tldr d2, 2f\n\tb 3f\n\t.balign 8\n1:\t.word 0x3f8ccccd\n\t.word 0\n2:\t.quad 0x400921fb54442d18\n3:',
	'ldr q1, 1f\n\tb 2f\n\t.balign 16\n1:\t.quad 0x1122334455667788\n\t.quad 0x99aabbccddeeff00\n2:',
	'ld1 {v0.16b}, [x4]',
	'add x5, x4, #16\n\tld1 {v1.4s, v2.4s}, [x5]',
	'ld2 {v1.4s, v2.4s}, [x4]',
	'ld2 {v1.8b, v2.8b}, [x4]',
	'ld3 {v0.8h, v1.8h, v2.8h}, [x4]',
	'ld4 {v0.16b, v1.16b, v2.16b, v3.16b}, [x4]',
	'ld1r {v0.8h}, [x4]',
	'ld1r {v0.2d}, [x4]',
	'ld1 {v0.s}[1], [x4]',
	'ld1 {v0.b}[13], [x4]',
	'mov x5, x4\n\tld1 {v1.2d, v2.2d}, [x5], #32\n\tsub x3, x5, x4'
])
	addV(opLine(code), FILL + code + (code.includes('sub x') ? '' : V12), 'iiii', 4);
for (const code of [
	'str s1, [x4, #20]',
	'str d1, [x4, #24]',
	'str q1, [x4, #16]',
	'str b1, [x4, #17]',
	'str h1, [x4, #18]',
	'stur q1, [x4, #19]',
	'stp s1, s2, [x4, #20]',
	'stp d1, d2, [x4, #16]',
	'stp q1, q2, [x4, #16]',
	'add x5, x4, #16\n\tst1 {v1.16b}, [x5]',
	'add x5, x4, #16\n\tst2 {v1.4s, v2.4s}, [x5]',
	'add x5, x4, #16\n\tst1 {v1.8b, v2.8b}, [x5]',
	'add x5, x4, #16\n\tst1 {v1.h}[5], [x5]',
	'add x5, x4, #16\n\tst3 {v1.4h, v2.4h, v3.4h}, [x5]'
])
	addV(opLine(code), FILL + code + BACK, 'iiii', 4);
// #endregion

// #region rounding modes (ties, overflow, underflow), FZ, DN, and the later forms
const rnd = (lo: number, hi: number) => lo + random.randbelow(hi - lo + 1);
const bit = () => random.getrandbits(1);
// sign, biased exponent and fraction; a single sits over garbage like the s kind
const single = (s: bigint, e: number, f: bigint) =>
	(g64() & ~0xffffffffn) | (s << 31n) | (BigInt(e) << 23n) | f;
const double = (s: bigint, e: number, f: bigint) => (s << 63n) | (BigInt(e) << 52n) | f;
const numberOf = (b: bigint, dbl: boolean) => {
	const v = new DataView(new ArrayBuffer(8));
	if (dbl) {
		v.setBigUint64(0, b);
		return v.getFloat64(0);
	}
	v.setUint32(0, Number(b & 0xffffffffn));
	return v.getFloat32(0);
};
// a low part that is exactly half, just below or above it, zero, or anything
const halfish = (k: bigint) =>
	random.choice([
		1n << (k - 1n),
		(1n << (k - 1n)) - 1n,
		(1n << (k - 1n)) + 1n,
		0n,
		random.getrandbits(Number(k))
	]);
const nan = (dbl: boolean) =>
	dbl
		? double(bit(), 0x7ff, (bit() << 51n) | random.getrandbits(50) | 1n)
		: (bit() << 31n) | (0xffn << 23n) | (bit() << 22n) | random.getrandbits(21) | 1n;
Object.assign(KIND, {
	// a normal number, and one about half its last place (so a sum can tie)
	a: () => [single(bit(), rnd(20, 230), random.getrandbits(23)), g64()],
	A: () => [double(bit(), rnd(100, 1950), random.getrandbits(52)), g64()],
	b: (p: bigint[]) => [
		single(
			bit(),
			Math.max(1, Number((p[2]! >> 23n) & 0xffn) - 24 + rnd(-1, 1)),
			random.randbelow(2) ? 0n : random.getrandbits(23)
		),
		g64()
	],
	B: (p: bigint[]) => [
		double(
			bit(),
			Math.max(1, Number((p[2]! >> 52n) & 0x7ffn) - 53 + rnd(-1, 1)),
			random.randbelow(2) ? 0n : random.getrandbits(52)
		),
		g64()
	],
	// short significands, so products can tie; exponents that make them overflow or go subnormal
	m: () => [
		single(
			bit(),
			random.choice([rnd(100, 154), rnd(100, 154), rnd(30, 64), rnd(190, 254)]),
			random.getrandbits(12) << 11n
		),
		g64()
	],
	M: () => [
		double(
			bit(),
			random.choice([rnd(900, 1150), rnd(900, 1150), rnd(300, 520), rnd(1535, 2046)]),
			random.getrandbits(27) << 25n
		),
		g64()
	],
	// the negated rounded product of v1 and v2, so a fused multiply-add leaves only the error
	c: (p: bigint[]) => [bitsOf(-(numberOf(p[2]!, false) * numberOf(p[4]!, false)), false), g64()],
	C: (p: bigint[]) => [bitsOf(-(numberOf(p[2]!, true) * numberOf(p[4]!, true)), true), g64()],
	// full significands whose products land around the subnormal range
	w: () => [single(bit(), rnd(52, 67), random.getrandbits(23)), g64()],
	W: () => [double(bit(), rnd(483, 515), random.getrandbits(52)), g64()],
	// near the largest finite
	o: () => [
		single(bit(), rnd(252, 254), random.randbelow(2) ? 0x7fffffn : random.getrandbits(23)),
		g64()
	],
	O: () => [
		double(
			bit(),
			rnd(2044, 2046),
			random.randbelow(2) ? (1n << 52n) - 1n : random.getrandbits(52)
		),
		g64()
	],
	// narrowing ties: doubles for single (including its subnormals and overflow) and half, singles for half
	q: () => [
		double(bit(), 1023 + rnd(-155, 130), (random.getrandbits(23) << 29n) | halfish(29n)),
		g64()
	],
	r: () => [
		double(bit(), 1023 + rnd(-27, 17), (random.getrandbits(10) << 42n) | halfish(42n)),
		g64()
	],
	p: () => [
		single(bit(), 127 + rnd(-27, 17), (random.getrandbits(10) << 13n) | halfish(13n)),
		g64()
	],
	// half of them NaNs, quiet or signalling
	n: () => [
		random.randbelow(2) ? (g64() & ~0xffffffffn) | nan(false) : single(0n, 0, 0n) | pick(S, 32),
		g64()
	],
	N: () => [random.randbelow(2) ? nan(true) : pick(D, 64), g64()],
	Z: () =>
		pair(
			() =>
				(random.randbelow(3) ? pick(S, 32) : nan(false)) |
				((random.randbelow(3) ? pick(S, 32) : nan(false)) << 32n)
		),
	P: () =>
		pair(() => {
			let v = 0n;
			for (let j = 0n; j < 64n; j += 16n) v |= pick(H, 16) << j;
			return v;
		})
});
const RMODES = [[0, 'rn'], ...MODES] as const;
for (const t of ['s', 'd'] as const) {
	const [a, b, m, c, o, u, n, w] = t === 's' ? 'abmcounw' : 'ABMCOUNW';
	for (const [mode, name] of RMODES) {
		const rm = rmode(mode);
		for (const op of ['fadd', 'fsub'])
			addV(`${op} ${t} tie ${name}`, `${rm}${op} ${t}0, ${t}1, ${t}2`, `i${a}${b}i`, 10);
		addV(`fmul ${t} short ${name}`, `${rm}fmul ${t}0, ${t}1, ${t}2`, `i${m}${m}i`, 12);
		addV(`fnmul ${t} short ${name}`, `${rm}fnmul ${t}0, ${t}1, ${t}2`, `i${m}${m}i`, 4);
		addV(`fdiv ${t} short ${name}`, `${rm}fdiv ${t}0, ${t}1, ${t}2`, `i${m}${m}i`, 8);
		addV(`fsqrt ${t} short ${name}`, `${rm}fsqrt ${t}0, ${t}1`, `i${m}ii`, 6);
		for (const op of ['fmadd', 'fmsub', 'fnmadd', 'fnmsub'])
			addV(
				`${op} ${t} residual ${name}`,
				`${rm}${op} ${t}0, ${t}1, ${t}2, ${t}3`,
				`i${m}${m}${c}`,
				4
			);
		addV(
			`fmadd ${t} short ${name}`,
			`${rm}fmadd ${t}0, ${t}1, ${t}2, ${t}3`,
			`i${m}${m}${m}`,
			6
		);
		for (const op of ['fadd', 'fmul'])
			addV(`${op} ${t} big ${name}`, `${rm}${op} ${t}0, ${t}1, ${t}2`, `i${o}${o}i`, 6);
		addV(`fadd ${t} subnormal ${name}`, `${rm}fadd ${t}0, ${t}1, ${t}2`, `i${u}${u}i`, 6);
		addV(`fmul ${t} tiny ${name}`, `${rm}fmul ${t}0, ${t}1, ${t}2`, `i${w}${w}i`, 12);
		addV(
			`fnmadd ${t} tiny ${name}`,
			`${rm}fnmadd ${t}0, ${t}1, ${t}2, ${t}3`,
			`i${w}${w}${u}`,
			6
		);
	}
	// FZ on every kind of operation, and FZ with a directed mode
	for (const [op, code, kinds] of [
		['fsub', `fsub ${t}0, ${t}1, ${t}2`, `i${u}${u}i`],
		['fdiv', `fdiv ${t}0, ${t}1, ${t}2`, `i${u}${u}i`],
		['fmul', `fmul ${t}0, ${t}1, ${t}2`, `i${m}${m}i`],
		['fsqrt', `fsqrt ${t}0, ${t}1`, `i${u}ii`],
		['fmadd', `fmadd ${t}0, ${t}1, ${t}2, ${t}3`, `i${u}${u}${u}`],
		['fcmp', `fcmp ${t}1, ${t}2`, `i${u}${u}i`],
		['fcmpe', `fcmpe ${t}1, #0.0`, `i${u}ii`],
		['frintx', `frintx ${t}0, ${t}1`, `i${u}ii`],
		['fcvtzs', `fcvtzs w0, ${t}1`, `i${u}ii`],
		['fmin', `fmin ${t}0, ${t}1, ${t}2`, `i${u}${u}i`],
		['fminnm', `fminnm ${t}0, ${t}1, ${t}2`, `i${u}${n}i`],
		['fabs', `fabs ${t}0, ${t}1`, `i${u}ii`],
		['fcvt', t === 's' ? 'fcvt d0, s1' : 'fcvt s0, d1', t === 's' ? 'iuii' : 'iqii']
	] as const) {
		addV(`${op} ${t} fz`, `${fpcr(1 << 24)}${code}`, kinds, 6);
		addV(`${op} ${t} fz rm`, `${fpcr((1 << 24) | (2 << 22))}${code}`, kinds, 3);
	}
	// DN wherever a NaN comes out
	for (const [op, code, kinds] of [
		['fadd', `fadd ${t}0, ${t}1, ${t}2`, `i${n}${n}i`],
		['fmul', `fmul ${t}0, ${t}1, ${t}2`, `i${n}${n}i`],
		['fdiv', `fdiv ${t}0, ${t}1, ${t}2`, `i${n}${n}i`],
		['fsqrt', `fsqrt ${t}0, ${t}1`, `i${n}ii`],
		['fmadd', `fmadd ${t}0, ${t}1, ${t}2, ${t}3`, `i${n}${n}${n}`],
		['fmaxnm', `fmaxnm ${t}0, ${t}1, ${t}2`, `i${n}${n}i`],
		['fmin', `fmin ${t}0, ${t}1, ${t}2`, `i${n}${n}i`],
		['frinta', `frinta ${t}0, ${t}1`, `i${n}ii`],
		['fneg', `fneg ${t}0, ${t}1`, `i${n}ii`],
		['fcvt', t === 's' ? 'fcvt d0, s1' : 'fcvt s0, d1', `i${n}ii`],
		['fcvt h', `fcvt h0, ${t}1`, `i${n}ii`]
	] as const)
		addV(`${op} ${t} dn`, `${fpcr(1 << 25)}${code}`, kinds, 6);
	addV(`fcvt ${t} h dn`, `${fpcr(1 << 25)}fcvt ${t}0, h1`, 'ihii', 6);
	// the added scalar forms
	for (const op of ['fmulx', 'fabd', 'fcmeq', 'fcmge', 'fcmgt', 'facge', 'facgt'])
		addV(`${op} ${t} reg`, `${op} ${t}0, ${t}1, ${t}2`, `i${t}${t}i`, 8);
	for (const op of ['fcmeq', 'fcmge', 'fcmgt', 'fcmle', 'fcmlt'])
		addV(`${op} ${t} zero`, `${op} ${t}0, ${t}1, #0.0`, `i${t}ii`, 6);
	const bits = t === 's' ? 32 : 64;
	for (const fb of [1, bits / 2 + 1, bits]) {
		for (const op of ['fcvtzs', 'fcvtzu'])
			addV(`${op} ${t} ${t} fbits${fb}`, `${op} ${t}0, ${t}1, #${fb}`, `i${t}ii`, 6);
		for (const op of ['scvtf', 'ucvtf'])
			addV(`${op} ${t} ${t} fbits${fb}`, `${op} ${t}0, ${t}1, #${fb}`, 'iiii', 6);
	}
	for (const [code, kinds] of [
		[t === 's' ? 'fmul s0, s1, v2.s[3]' : 'fmul d0, d1, v2.d[1]', `i${t}Si`],
		[
			t === 's' ? 'fmla s0, s1, v2.s[1]' : 'fmla d0, d1, v2.d[0]',
			`${t}${t}${t === 's' ? 'S' : 'D'}i`
		],
		[
			t === 's' ? 'fmls s0, s1, v2.s[2]' : 'fmls d0, d1, v2.d[1]',
			`${t}${t}${t === 's' ? 'S' : 'D'}i`
		],
		[
			t === 's' ? 'fmulx s0, s1, v2.s[0]' : 'fmulx d0, d1, v2.d[0]',
			`i${t}${t === 's' ? 'S' : 'D'}i`
		]
	])
		addV(code, code, kinds, 8);
	for (const [mode, name] of RMODES)
		addV(
			`fcvtxn ${t === 's' ? 'q' : 'n'} ${name}`,
			`${rmode(mode)}fcvtxn s0, d1`,
			t === 's' ? 'iqii' : 'iNii',
			6
		);
}
for (const [mode, name] of RMODES)
	for (const [d, s, k] of [
		['s', 'd', 'q'],
		['h', 's', 'p'],
		['h', 'd', 'r']
	] as const)
		addV(`fcvt ${d} ${s} tie ${name}`, `${rmode(mode)}fcvt ${d}0, ${s}1`, `i${k}ii`, 12);
// vector forms under each mode, and the added vector forms
for (const [mode, name] of RMODES) {
	const rm = rmode(mode);
	for (const [code, kinds] of [
		['fadd v0.4s, v1.4s, v2.4s', 'iSSi'],
		['fmul v0.2d, v1.2d, v2.2d', 'iDDi'],
		['fmla v0.4s, v1.4s, v2.4s', 'SSSi'],
		['fdiv v0.2d, v1.2d, v2.2d', 'iDDi'],
		['fsqrt v0.4s, v1.4s', 'iSii'],
		['scvtf v0.4s, v1.4s', 'iiii'],
		['ucvtf v0.2d, v1.2d, #3', 'iiii'],
		['fcvtn v0.2s, v1.2d', 'iDii'],
		['fcvtn2 v0.8h, v1.4s', 'iSii'],
		['fcvtxn2 v0.4s, v1.2d', 'iDii'],
		['frinti v0.2d, v1.2d', 'iDii'],
		['fmla v0.2d, v1.2d, v2.d[1]', 'DDDi']
	])
		addV(`${code} ${name}`, `${rm}${code}`, kinds, 4);
}
for (const [code, kinds] of [
	['fcvtl v0.4s, v1.4h', 'iPii'],
	['fcvtl2 v0.4s, v1.8h', 'iPii'],
	['fcvtl v0.2d, v1.2s', 'iSii'],
	['fcvtl2 v0.2d, v1.4s', 'iZii'],
	['fcvtn v0.4h, v1.4s', 'iSii'],
	['fcvtn2 v0.4s, v1.2d', 'iDii'],
	['fcvtxn v0.2s, v1.2d', 'iDii'],
	['fcvtzs v0.4s, v1.4s, #1', 'iSii'],
	['fcvtzs v0.2s, v1.2s, #32', 'iSii'],
	['fcvtzu v0.4s, v1.4s, #16', 'iSii'],
	['fcvtzu v0.2d, v1.2d, #64', 'iDii'],
	['fcvtzs v0.2d, v1.2d, #33', 'iDii'],
	['scvtf v0.4s, v1.4s, #32', 'iiii'],
	['ucvtf v0.2s, v1.2s, #1', 'iiii'],
	['scvtf v0.2d, v1.2d, #64', 'iiii'],
	['fmul v0.4s, v1.4s, v2.s[3]', 'iSSi'],
	['fmul v0.2s, v1.2s, v2.s[0]', 'iSSi'],
	['fmla v0.4s, v1.4s, v2.s[2]', 'SSSi'],
	['fmls v0.4s, v1.4s, v2.s[1]', 'SSSi'],
	['fmls v0.2d, v1.2d, v2.d[0]', 'DDDi'],
	['fmulx v0.4s, v1.4s, v2.s[1]', 'iSSi'],
	['fmulx v0.2d, v1.2d, v2.d[1]', 'iDDi'],
	['fmulx v0.4s, v1.4s, v2.4s', 'iSSi'],
	['fmulx v0.2d, v1.2d, v2.2d', 'iDDi'],
	['fabd v0.2s, v1.2s, v2.2s', 'iSSi'],
	['fabd v0.2d, v1.2d, v2.2d', 'iDDi'],
	['facge v0.4s, v1.4s, v2.4s', 'iSSi'],
	['facgt v0.2d, v1.2d, v2.2d', 'iDDi'],
	['fmaxv s0, v1.4s', 'iZii'],
	['fminv s0, v1.4s', 'iZii'],
	['fmaxnmv s0, v1.4s', 'iZii'],
	['fminnmv s0, v1.4s', 'iZii'],
	['fmaxp v0.4s, v1.4s, v2.4s', 'iZZi'],
	['fminp v0.2d, v1.2d, v2.2d', 'iDDi'],
	['fmaxnmp v0.2s, v1.2s, v2.2s', 'iZZi'],
	['fminnmp v0.4s, v1.4s, v2.4s', 'iZZi'],
	['fmaxp s0, v1.2s', 'iZii'],
	['fminp d0, v1.2d', 'iDii'],
	['fmaxnmp d0, v1.2d', 'iDii'],
	['fminnmp s0, v1.2s', 'iZii'],
	['fadd v0.4s, v1.4s, v2.4s fz', 'iZZi'],
	['fcvtn v0.4h, v1.4s fz', 'iZii'],
	['fmaxv s0, v1.4s dn', 'iZii']
]) {
	const [op, flag] = code.split(/ (?=fz$|dn$)/);
	const pre = flag === 'fz' ? fpcr(1 << 24) : flag === 'dn' ? fpcr(1 << 25) : '';
	addV(code, pre + op!, kinds, 8);
}
// directed operands: s/dN from a constant, through x9
const ld = (r: string, v: bigint) =>
	r[0] === 's'
		? `movz w9, #${v & 0xffffn}\n\tmovk w9, #${v >> 16n}, lsl #16\n\tfmov ${r}, w9\n\t`
		: `${[0n, 1n, 2n, 3n].map((k) => `${k ? 'movk' : 'movz'} x9, #${(v >> (16n * k)) & 0xffffn}, lsl #${16n * k}`).join('\n\t')}\n\tfmov ${r}, x9\n\t`;
const S_QNAN = 0x7fc01234n;
const S_SNAN = 0xff801234n;
const S_INF = 0x7f800000n;
for (const [label, code] of [
	[
		'fmadd s qnan addend inf zero',
		`${ld('s1', S_INF)}${ld('s2', 0n)}${ld('s3', S_QNAN)}fmadd s0, s1, s2, s3`
	],
	[
		'fmadd s qnan addend zero inf',
		`${ld('s1', 0x80000000n)}${ld('s2', S_INF)}${ld('s3', S_QNAN)}fmadd s0, s1, s2, s3`
	],
	[
		'fmadd s snan addend inf zero',
		`${ld('s1', S_INF)}${ld('s2', 0n)}${ld('s3', S_SNAN)}fmadd s0, s1, s2, s3`
	],
	[
		'fnmsub d qnan addend inf zero',
		`${ld('d1', 0xfff0000000000000n)}${ld('d2', 0n)}${ld('d3', 0x7ff8000000000abcn)}fnmsub d0, d1, d2, d3`
	],
	[
		'fmla 4s qnan acc inf zero',
		`${ld('s1', S_INF)}${ld('s2', 0n)}${ld('s0', S_QNAN)}fmla v0.4s, v1.4s, v2.s[0]`
	],
	[
		'fmadd s inf zero qnan operand',
		`${ld('s1', S_INF)}${ld('s2', S_QNAN)}${ld('s3', 0n)}fmadd s0, s1, s2, s3`
	],
	// 2^-126 * (1 - 2^-24), tiny before rounding up to the smallest normal
	...RMODES.map(([mode, name]) => [
		`fmul s tiny to normal ${name}`,
		`${rmode(mode)}${ld('s1', 0x3f7fffffn)}${ld('s2', 0x00800000n)}fmul s0, s1, s2`
	]),
	...RMODES.map(([mode, name]) => [
		`fmul d tiny to normal ${name}`,
		`${rmode(mode)}${ld('d1', 0x3fefffffffffffffn)}${ld('d2', 0x0010000000000000n)}fmul d0, d1, d2`
	]),
	[
		'fmul s tiny to normal fz',
		`${fpcr(1 << 24)}${ld('s1', 0x3f7fffffn)}${ld('s2', 0x00800000n)}fmul s0, s1, s2`
	],
	[
		'fmul d tiny to normal fz',
		`${fpcr(1 << 24)}${ld('d1', 0x3fefffffffffffffn)}${ld('d2', 0x0010000000000000n)}fmul d0, d1, d2`
	],
	['fcvt s d tiny to normal', `${ld('d1', 0x380fffffffffffffn)}fcvt s0, d1`],
	['fcvt s d tiny to normal fz', `${fpcr(1 << 24)}${ld('d1', 0x380fffffffffffffn)}fcvt s0, d1`]
])
	addV(label!, code!, 'iiii', 1);
// FPSR.QC from the saturating ops, next to other cumulative bits
addV('uqadd qc then fadd', 'uqadd v0.16b, v1.16b, v2.16b\n\tfadd s3, s3, s3', 'iiii', 6);
// #endregion

// SIGILL (SA_SIGINFO | SA_RESTORER) skips the instruction and leaves its word in x12
const out: string[] = [
	'.arch armv8-a+crc\n.globl _start\n.text\n_start:',
	'\tmov x0, #4\n\tadrp x1, act\n\tadd x1, x1, :lo12:act\n\tmov x2, #0\n\tmov x3, #8\n\tmov x8, #134\n\tsvc #0',
	'\tadrp x10, out\n\tadd x10, x10, :lo12:out',
	'\tadrp x11, vin\n\tadd x11, x11, :lo12:vin'
];
const vin: string[] = [];
const hex = (v: bigint) => `0x${v.toString(16)}`;
const lit = (reg: string, v: bigint) =>
	[0, 1, 2, 3]
		.map(
			(k) =>
				`\t${k ? 'movk' : 'movz'} ${reg}, #${(v >> BigInt(16 * k)) & 0xffffn}, lsl #${16 * k}`
		)
		.join('\n');
for (const [label, code, a, b, f, v] of cases) {
	out.push(
		`\t# ${label}`,
		lit('x0', a),
		lit('x1', b),
		lit('x2', b ^ 0x5a5a5a5a5a5a5a5an),
		lit('x3', a ^ 0x0f0f0f0f0f0f0f0fn),
		'\tadrp x4, buf\n\tadd x4, x4, :lo12:buf',
		lit('x9', a ^ b),
		'\tstr x9, [x4]\n\tmvn x9, x0\n\tstr x9, [x4, #8]',
		'\tmsr fpsr, xzr\n\tmsr fpcr, xzr\n\tmov x12, #0',
		`\tmovz x9, #${f >>> 16}, lsl #16\n\tmsr nzcv, x9`
	);
	if (v) {
		// the inputs, v0-v3 as hi:lo, for reading a difference
		out.push(
			`\t// in ${[0, 1, 2, 3].map((k) => `v${k}=${hex(v[2 * k + 1]!)}:${hex(v[2 * k]!)}`).join(' ')}`
		);
		out.push('\tldp q0, q1, [x11]\n\tldp q2, q3, [x11, #32]\n\tadd x11, x11, #64');
		vin.push(`\t.quad ${v.map(hex).join(', ')}`);
	}
	out.push(
		`\t${code}`,
		'\tmrs x5, nzcv\n\tmrs x9, fpsr\n\torr x5, x5, x9\n\torr x5, x5, x12, lsl #32',
		'\tadrp x4, buf\n\tadd x4, x4, :lo12:buf'
	);
	if (v) out.push('\tstr q0, [x4]');
	out.push(
		'\tldp x6, x7, [x4]',
		'\tstp x0, x1, [x10]\n\tstp x2, x3, [x10, #16]\n\tstp x5, x6, [x10, #32]\n\tstr x7, [x10, #48]\n\tadd x10, x10, #56'
	);
}
out.push(
	'\tadrp x1, out\n\tadd x1, x1, :lo12:out\n\tsub x2, x10, x1\n\tmov x0, #1\n\tmov x8, #64\n\tsvc #0',
	'\tmov x0, #0\n\tmov x8, #93\n\tsvc #0',
	// x2 is the ucontext: saved x12 at 280, pc at 440
	'ill:\n\tldr x9, [x2, #440]\n\tldr w13, [x9]\n\tadd x9, x9, #4\n\tstr x9, [x2, #440]\n\tstr x13, [x2, #280]\n\tret',
	'restore:\n\tmov x8, #139\n\tsvc #0',
	'.data\n.balign 16\nact: .quad ill, 0x04000004, restore, 0',
	'.balign 16\nvin:',
	...vin,
	'.bss\n.balign 16\nbuf: .zero 64',
	`out: .zero ${56 * cases.length}`
);
process.stdout.write(out.join('\n') + '\n');
