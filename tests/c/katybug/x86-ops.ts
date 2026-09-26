import { Random } from './random.ts';

/**
 * Writes an x86-64 assembly program that runs every instruction form below on edge-case inputs and
 * prints, per case, the registers and the flags the instruction defines. Run natively and under
 * katybug, the two outputs must be equal. `x86-ops.ts > x86-ops.S`
 */
const random = new Random(215);
const EDGE: bigint[] = [
	0n,
	1n,
	2n,
	0x7fn,
	0x80n,
	0xffn,
	0x100n,
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
const COUNTS = [0, 1, 3, 7, 8, 15, 16, 31, 32, 33, 63, 64, 65];
const [CF, PF, ZF, SF, OF] = [1, 4, 0x40, 0x80, 0x800];
const ARITH = CF | PF | ZF | SF | OF;
const SZP = PF | ZF | SF;

type Input = [bigint, bigint, number];
const cases: [string, string, bigint, bigint, number, number][] = [];

const pairs = (n = 40): Input[] =>
	Array.from({ length: n }, () => [
		random.choice(EDGE),
		random.choice(EDGE),
		random.choice([0, CF, ARITH, ZF | CF])
	]);

function add(label: string, code: string, mask: number, inputs?: Input[]) {
	(inputs?.length ? inputs : pairs()).forEach(([a, b, f], k) =>
		cases.push([`${label}#${k}`, code, a, b, f, mask])
	);
}

const W: Record<string, [string, string, string, string]> = {
	q: ['rax', 'rbx', 'rcx', 'rdx'],
	l: ['eax', 'ebx', 'ecx', 'edx'],
	w: ['ax', 'bx', 'cx', 'dx'],
	b: ['al', 'bl', 'cl', 'dl']
};
for (const op of ['add', 'or', 'adc', 'sbb', 'and', 'sub', 'xor', 'cmp', 'test']) {
	for (const [s, [a, b]] of Object.entries(W)) {
		add(`${op}${s} r,r`, `${op}${s} %${b}, %${a}`, ARITH);
		add(`${op}${s} m,r`, `${op}${s} %${b}, (%rsi)`, ARITH);
		add(`${op}${s} r,m`, `${op}${s} (%rsi), %${a}`, ARITH);
		if (s !== 'b') add(`${op}${s} imm8`, `${op}${s} $-3, %${a}`, ARITH);
		add(
			`${op}${s} imm`,
			`${op}${s} $${s === 'b' ? 0x55 : s === 'w' ? 0x1234 : 0x7ffff00f}, %${a}`,
			ARITH
		);
	}
	add(`${op}b ah`, `${op}b %bh, %ah`, ARITH);
}
for (const [op, mask] of [
	['inc', SZP | OF],
	['dec', SZP | OF],
	['neg', ARITH],
	['not', 0]
] as const)
	for (const [s, [a]] of Object.entries(W)) {
		add(`${op}${s}`, `${op}${s} %${a}`, mask);
		add(`${op}${s} m`, `${op}${s} (%rsi)`, mask);
	}
for (const op of ['shl', 'shr', 'sar', 'rol', 'ror']) {
	const fmask = ['shl', 'shr', 'sar'].includes(op) ? CF | SZP : 0;
	for (const [s, [a]] of Object.entries(W)) {
		add(`${op}${s} 1`, `${op}${s} $1, %${a}`, fmask | (op !== 'sar' ? OF : 0));
		for (const n of [3, 7, 13]) add(`${op}${s} ${n}`, `${op}${s} $${n}, %${a}`, fmask);
		for (const n of COUNTS)
			add(
				`${op}${s} cl=${n}`,
				`movb $${n}, %cl\n\t${op}${s} %cl, %${a}`,
				n ? fmask : 0,
				Array.from({ length: 4 }, () => [
					random.choice(EDGE),
					random.choice(EDGE),
					random.choice([0, ARITH])
				])
			);
	}
}
for (const s of ['q', 'l', 'w']) {
	const [a, b] = W[s]!;
	add(`imul${s} r,r`, `imul${s} %${b}, %${a}`, CF | OF);
	add(`imul${s} r,r,imm`, `imul${s} $-77, %${b}, %${a}`, CF | OF);
}
for (const [s, [, b]] of Object.entries(W)) {
	add(`mul${s}`, `mul${s} %${b}`, CF | OF);
	add(`imul${s} 1op`, `imul${s} %${b}`, CF | OF);
}
const safe: Input[] = [];
for (let i = 0; i < 40; i++) {
	const divisor = random.choice([
		1n,
		3n,
		7n,
		10n,
		255n,
		1000n,
		65537n,
		0x7fffffffn,
		0xffffffffn,
		0x123456789n
	]);
	safe.push([random.getrandbits(62), divisor, 0]);
}
add('divq', 'xor %edx, %edx\n\tdivq %rbx', 0, safe);
add(
	'divl',
	'xor %edx, %edx\n\tdivl %ebx',
	0,
	safe.map(([a, b, f]) => [a, b & 0xffffffffn || 1n, f])
);
add(
	'idivq',
	'cqto\n\tidivq %rbx',
	0,
	safe.map(([a, b, f]) => [a - (1n << 61n), b, f])
);
add(
	'idivl',
	'cltd\n\tidivl %ebx',
	0,
	safe.map(([a, b, f]) => [a & 0xffffffffn, b & 0x7fffffffn || 1n, f])
);
for (const ins of [
	'movzbl %bl, %eax',
	'movzwl %bx, %eax',
	'movsbl %bl, %eax',
	'movswl %bx, %eax',
	'movsbq %bl, %rax',
	'movswq %bx, %rax',
	'movslq %ebx, %rax',
	'movzbq %bl, %rax',
	'movb %bh, %al',
	'movw %bx, %ax',
	'movl %ebx, %eax',
	'cltq',
	'cqto',
	'cltd',
	'cwtl',
	'cbtw',
	'bswapq %rax',
	'bswapl %eax',
	'xchgq %rbx, %rax',
	'xchgl %ebx, %eax',
	'xchgb %bl, %al',
	'leaq 0x7f(%rax,%rbx,4), %rax',
	'leal -1(%rax,%rbx,8), %eax',
	'leaq (%rbx), %rax'
])
	add(ins, ins, 0);
for (const cc of [
	'o',
	'no',
	'b',
	'ae',
	'e',
	'ne',
	'be',
	'a',
	's',
	'ns',
	'p',
	'np',
	'l',
	'ge',
	'le',
	'g'
]) {
	add(`set${cc}`, `cmpq %rbx, %rax\n\tset${cc} %cl`, 0);
	add(`set${cc} 8`, `cmpb %bl, %al\n\tset${cc} %cl`, 0);
	add(`cmov${cc}`, `cmpl %ebx, %eax\n\tcmov${cc}q %rbx, %rcx`, 0);
	add(`cmov${cc}l`, `cmpq %rbx, %rax\n\tcmov${cc}l %ebx, %ecx`, 0);
}
for (const s of ['q', 'l', 'w']) {
	const [a, b] = W[s]!;
	add(`bt${s} r`, `bt${s} %${b}, %${a}`, CF);
	add(`bt${s} imm`, `bt${s} $5, %${a}`, CF);
	// a register offset into memory is a signed index into a bit string around buf+32
	const offsets = [0, 1, 5, 15, 16, 31, 32, 63, 64, 100, 255, -1, -17, -64, -256].map(
		(o): Input => [random.choice(EDGE), BigInt(o), random.choice([0, CF, ZF | CF])]
	);
	for (const op of ['bt', 'bts', 'btr', 'btc']) {
		if (op !== 'bt') {
			add(`${op}${s} r`, `${op}${s} %${b}, %${a}`, CF | ZF);
			add(`${op}${s} imm`, `${op}${s} $5, %${a}`, CF | ZF);
		}
		add(`${op}${s} imm m`, `${op}${s} $37, (%rsi)`, CF | ZF);
		add(
			`${op}${s} m,r`,
			`lea 32(%rsi), %rsi\n\t${op}${s} %${b}, (%rsi)`,
			CF | ZF,
			offsets.map(([x, o, f]) => [x, BigInt.asUintN(64, o), f])
		);
	}
	add(`bsf${s}`, `bsf${s} %${b}, %${a}`, ZF);
	add(`bsr${s}`, `bsr${s} %${b}, %${a}`, ZF);
	add(`tzcnt${s}`, `tzcnt${s} %${b}, %${a}`, CF | ZF);
	add(`lzcnt${s}`, `lzcnt${s} %${b}, %${a}`, CF | ZF);
	add(`shld${s} imm`, `shld${s} $5, %${b}, %${a}`, CF | SZP);
	add(`shrd${s} imm`, `shrd${s} $5, %${b}, %${a}`, CF | SZP);
	// counts above the operand width are undefined for 16 bits
	const limit = { q: 63, l: 31, w: 16 }[s]!;
	for (const n of COUNTS.filter((c) => c <= limit))
		add(
			`shld${s} cl=${n}`,
			`movb $${n}, %cl\n\tshld${s} %cl, %${b}, %${a}`,
			0,
			Array.from({ length: 3 }, () => [random.choice(EDGE), random.choice(EDGE), 0])
		);
}
for (const [s, [a, b]] of Object.entries(W)) {
	add(`xadd${s}`, `xadd${s} %${b}, %${a}`, ARITH);
	add(`cmpxchg${s}`, `cmpxchg${s} %${b}, %${W[s]![2]}`, ARITH);
	add(`cmpxchg${s} m`, `cmpxchg${s} %${b}, (%rsi)`, ARITH);
}
// flag writes a later op overwrites only in part, or not at all, or reads first: katybug's plan
// may drop a flag write only when nothing reads what it wrote
for (const [label, code, mask] of [
	['add; inc', 'addq %rbx, %rax\n\tincq %rcx', ARITH],
	['sub; dec', 'subq %rbx, %rax\n\tdecq %rdx', ARITH],
	['add; bt', 'addq %rbx, %rax\n\tbtq $3, %rcx', CF | ZF],
	['add; shl cl=0', 'addq %rbx, %rax\n\tmovb $0, %cl\n\tshlq %cl, %rdx', ARITH],
	['add; rol cl=0', 'addq %rbx, %rax\n\tmovb $0, %cl\n\trolq %cl, %rdx', ARITH],
	['add; sub', 'addq %rbx, %rax\n\tsubq %rcx, %rdx', ARITH],
	['add; setc; sub', 'addq %rbx, %rax\n\tsetc %dl\n\tsubq %rcx, %rax', ARITH],
	['add; adc; sub', 'addq %rbx, %rax\n\tadcq $0, %rcx\n\tsubq %rbx, %rdx', ARITH],
	['cmp; cmovb; xor', 'cmpq %rbx, %rax\n\tcmovbq %rbx, %rcx\n\txorq %rax, %rdx', ARITH]
] as const)
	add(`plan ${label}`, code, mask);
add('stc', 'stc', CF);
add('clc', 'clc', CF);
add('cmc', 'cmc', CF);
add('lahf', 'lahf', 0);
add('sahf', 'sahf', ARITH & ~OF);

// SSE/SSE2: xmm0 = (rax, rdx) and xmm1 = (rbx, rcx); the result comes back as rax, rdx (xmm0) and
// EFLAGS, which only the compares may change
const DBL = [
	0n,
	1n << 63n,
	0x3ff0000000000000n,
	0xbff8000000000000n,
	0x4008000000000000n,
	0x3fb999999999999an,
	0x7e37e43c8800759cn,
	0x8190000000000000n,
	0x7ff0000000000000n,
	0xfff0000000000000n,
	0x7ff8000000000001n,
	0x7ff0000000000001n,
	0xfff8000000000000n,
	1n,
	0x7fefffffffffffffn,
	0x3fd5555555555555n,
	0xc1e0000000100000n,
	0x41dfffffffc00000n,
	0x43e0000000000000n,
	0x3fe0000000000000n,
	0x3ff8000000000000n,
	0x4004000000000000n
];
const FLT = [
	0n,
	0x80000000n,
	0x3f800000n,
	0xbfc00000n,
	0x3dcccccdn,
	0x7f800000n,
	0xff800000n,
	0x7fc00001n,
	0x7f800001n,
	1n,
	0x7f7fffffn,
	0x40400000n,
	0x00800000n,
	0x4b800001n,
	0xcf000000n,
	0x3f000000n,
	0x40200000n
];
const dbl = () => random.choice(DBL);
const flt = () => {
	const low = random.choice(FLT);
	return low | (random.choice(FLT) << 32n);
};
const SSE_IN = [
	'mov %rax, 16(%rsi)',
	'mov %rdx, 24(%rsi)',
	'movdqu 16(%rsi), %xmm0',
	'mov %rbx, 32(%rsi)',
	'mov %rcx, 40(%rsi)',
	'movdqu 32(%rsi), %xmm1'
].join('\n\t');
const SSE_OUT = 'movdqu %xmm0, 16(%rsi)\n\tmov 16(%rsi), %rax\n\tmov 24(%rsi), %rdx';
const SSE_GPR = 'movdqu %xmm0, 16(%rsi)\n\tmov 24(%rsi), %rdx';

function sse(ins: string, gen: () => bigint, gpr = false, n = 40) {
	add(
		`sse ${ins}`,
		`${SSE_IN}\n\t${ins}\n\t${gpr ? SSE_GPR : SSE_OUT}`,
		ARITH,
		Array.from({ length: n }, (): Input => {
			const a = gen();
			const b = gen();
			return [a, b, random.choice([0, ARITH])];
		})
	);
}

for (const op of ['add', 'sub', 'mul', 'div', 'min', 'max', 'sqrt']) {
	sse(`${op}sd %xmm1, %xmm0`, dbl);
	sse(`${op}pd %xmm1, %xmm0`, dbl);
	sse(`${op}ss %xmm1, %xmm0`, flt);
	sse(`${op}ps %xmm1, %xmm0`, flt);
}
sse('addsd 32(%rsi), %xmm0', dbl);
sse('movsd 32(%rsi), %xmm0', dbl, false, 4);
sse('movss 32(%rsi), %xmm0', flt, false, 4);
sse('movsd %xmm1, %xmm0', dbl, false, 4);
sse('movss %xmm1, %xmm0', flt, false, 4);
for (let k = 0; k < 8; k++) {
	sse(`cmpsd $${k}, %xmm1, %xmm0`, dbl, false, 24);
	sse(`cmppd $${k}, %xmm1, %xmm0`, dbl, false, 12);
	sse(`cmpss $${k}, %xmm1, %xmm0`, flt, false, 24);
	sse(`cmpps $${k}, %xmm1, %xmm0`, flt, false, 12);
}
for (const ins of ['ucomisd', 'comisd']) sse(`${ins} %xmm1, %xmm0`, dbl);
for (const ins of ['ucomiss', 'comiss']) sse(`${ins} %xmm1, %xmm0`, flt);
for (const [ins, gen] of [
	['cvttsd2si %xmm1, %rax', dbl],
	['cvttsd2si %xmm1, %eax', dbl],
	['cvtsd2si %xmm1, %rax', dbl],
	['cvtsd2si %xmm1, %eax', dbl],
	['cvttss2si %xmm1, %rax', flt],
	['cvttss2si %xmm1, %eax', flt],
	['cvtss2si %xmm1, %eax', flt],
	['movmskpd %xmm1, %eax', dbl],
	['movmskps %xmm1, %eax', flt],
	['pmovmskb %xmm1, %eax', dbl]
] as const)
	sse(ins, gen, true);
const edge = () => random.choice(EDGE);
for (const [ins, gen] of [
	['cvtsd2ss %xmm1, %xmm0', dbl],
	['cvtss2sd %xmm1, %xmm0', flt],
	['cvtpd2ps %xmm1, %xmm0', dbl],
	['cvtps2pd %xmm1, %xmm0', flt],
	['cvtdq2pd %xmm1, %xmm0', flt],
	['cvttpd2dq %xmm1, %xmm0', dbl],
	['cvtpd2dq %xmm1, %xmm0', dbl],
	['cvtdq2ps %xmm1, %xmm0', flt],
	['cvtps2dq %xmm1, %xmm0', flt],
	['cvttps2dq %xmm1, %xmm0', flt],
	['cvtsi2sd %rbx, %xmm0', edge],
	['cvtsi2sdl %ebx, %xmm0', edge],
	['cvtsi2ss %rbx, %xmm0', edge],
	['cvtsi2ssl %ebx, %xmm0', edge]
] as const)
	sse(ins, gen);
for (const ins of [
	'andpd',
	'andnpd',
	'orpd',
	'xorpd',
	'unpcklpd',
	'unpckhpd',
	'unpcklps',
	'shufpd $1,',
	'shufps $0x1b,',
	'shufps $0xe4,'
])
	sse(`${ins} %xmm1, %xmm0`, flt, false, 12);
for (const ins of [
	'paddb',
	'paddw',
	'paddd',
	'paddq',
	'psubb',
	'psubw',
	'psubd',
	'psubq',
	'pcmpeqb',
	'pcmpeqw',
	'pcmpeqd',
	'pcmpgtb',
	'pcmpgtw',
	'pcmpgtd',
	'pminub',
	'pmaxub',
	'pand',
	'pandn',
	'por',
	'pxor',
	'punpcklbw',
	'punpcklwd',
	'punpckldq',
	'punpcklqdq',
	'punpckhbw',
	'punpckhwd',
	'punpckhdq',
	'punpckhqdq',
	'packsswb',
	'packuswb',
	'packssdw',
	'pmuludq',
	'psllw',
	'pslld',
	'psllq',
	'psrlw',
	'psrld',
	'psrlq',
	'psraw',
	'psrad'
])
	sse(`${ins} %xmm1, %xmm0`, edge, false, 16);
for (const k of [0, 3, 7]) {
	sse(`pextrw $${k}, %xmm1, %eax`, edge, true, 8);
	sse(`pinsrw $${k}, %ebx, %xmm0`, edge, false, 8);
	sse(`pinsrw $${k}, (%rsi), %xmm0`, edge, false, 4);
}
for (const ins of ['pshufd $0x1b,', 'pshuflw $0x1b,', 'pshufhw $0x1b,'])
	sse(`${ins} %xmm1, %xmm0`, edge, false, 8);
for (const ins of [
	'psllw',
	'pslld',
	'psllq',
	'psrlw',
	'psrld',
	'psrlq',
	'psraw',
	'psrad',
	'pslldq',
	'psrldq'
])
	for (const c of [0, 1, 7, 15, 16, 31, 33, 63, 64]) sse(`${ins} $${c}, %xmm0`, edge, false, 2);

// x87: operands as 80-bit values, each case records the 80-bit result, the status word and EFLAGS
const F80: [bigint, number][] = [
	[0n, 0],
	[0n, 0x8000],
	[1n << 63n, 0x3fff],
	[1n << 63n, 0xbfff],
	[1n << 63n, 0x3ffe],
	[0xc000000000000000n, 0x4000],
	[0xc90fdaa22168c235n, 0x4000],
	[0xaaaaaaaaaaaaaaabn, 0x3ffd],
	[0xd6bf94d5e57a42bcn, 0x43e1],
	[0xd6bf94d5e57a42bcn, 0x3c1e],
	[1n << 63n, 0x3c01],
	[0xffffffffffffffffn, 0x7ffe],
	[1n, 0],
	[1n << 63n, 0x7fff],
	[1n << 63n, 0xffff],
	[0xc000000000000000n, 0x7fff],
	[1n << 63n, 0x403e],
	[1n << 63n, 0xc03e],
	[1n << 63n, 0x403f],
	[0xc000000000000000n, 0x3fff],
	[0xa000000000000000n, 0x4000],
	[0xa000000000000000n, 0xc000],
	[0xffffffffffffffffn, 0x3fff],
	[0x8000000000000001n, 0x3fff],
	[0xe000000000000000n, 0x4005],
	[0x9c40000000000000n, 0x400c],
	[0x8000000000000000n, 0x4010]
];
const x87: [string, bigint, bigint, number, string, string][] = [];
const BIN = ['faddp', 'fsubp', 'fsubrp', 'fmulp', 'fdivp', 'fdivrp'];
const RCW = [0x037f, 0x077f, 0x0b7f, 0x0f7f];
const operands = (): [bigint, bigint] => {
	const a = random.randrange(F80.length);
	return [BigInt(a), BigInt(random.randrange(F80.length))];
};
for (let k = 0; k < 260; k++) {
	const [a, b] = operands();
	const rcw = random.choice(RCW);
	x87.push([
		`x87 ${BIN[k % 6]} rc=${(rcw >> 10) & 3}#${k}`,
		a,
		b,
		rcw,
		`${BIN[k % 6]} %st, %st(1)`,
		'st'
	]);
}
for (const name of [...BIN, 'fscale', 'fprem', 'fprem1']) {
	const code = BIN.includes(name) ? `${name} %st, %st(1)` : name;
	for (let a = 0; a < F80.length; a++)
		for (let b = 0; b < F80.length; b++)
			x87.push([`x87 ${name} all#${a},${b}`, BigInt(a), BigInt(b), 0x037f, code, 'st']);
}
for (const name of [
	'fsqrt',
	'frndint',
	'fchs',
	'fabs',
	'fxtract',
	'fscale',
	'fprem',
	'fprem1',
	'fxam',
	'ftst'
])
	for (let k = 0; k < 24; k++) {
		const [a, b] = operands();
		const rcw = random.choice(RCW);
		x87.push([`x87 ${name}#${k}`, a, b, rcw, name, 'st']);
	}
for (const [name, kind] of [
	['fistps', 2],
	['fistpl', 4],
	['fistpll', 8],
	['fisttps', 2],
	['fisttpl', 4],
	['fisttpll', 8],
	['fstps', 4],
	['fstpl', 8]
] as const)
	for (let k = 0; k < 28; k++) {
		const a = BigInt(random.randrange(F80.length));
		const rcw = random.choice(RCW);
		x87.push([`x87 ${name}#${k}`, a, a, rcw, `${name} (%rsi)`, `m${kind}`]);
	}
for (const name of ['fcomi %st(1), %st', 'fucomi %st(1), %st', 'fcom %st(1)', 'fucom %st(1)'])
	for (let k = 0; k < 24; k++) {
		const [a, b] = operands();
		x87.push([`x87 ${name}#${k}`, a, b, 0x037f, name, 'cmp']);
	}
for (let k = 0; k < 30; k++)
	x87.push([`x87 fildll#${k}`, random.choice(EDGE), 0n, 0x037f, 'fildll (%rsi)', 'ild']);

const out: string[] = ['.globl _start\n.text\n_start:', '\tlea out(%rip), %r12'];
const store = () =>
	['rax', 'rbx', 'rcx', 'rdx', 'r8'].map((reg, i) => `\tmov %${reg}, ${8 * i}(%r12)`);
for (const [label, code, a, b, f, mask] of cases) {
	out.push(
		`\t# ${label}`,
		`\tmovabs $${a}, %rax\n\tmovabs $${b}, %rbx\n\tmovabs $${b ^ 0x5a5a5a5a5a5a5a5an}, %rcx`,
		`\tmovabs $${a ^ 0x0f0f0f0f0f0f0f0fn}, %rdx`,
		`\tlea buf(%rip), %rsi\n\tmovabs $${a ^ b}, %r8\n\tmov %r8, (%rsi)`,
		`\tpush $${f}\n\tpopfq`,
		`\t${code}`,
		'\tpushfq\n\tpop %r8',
		`\tand $${mask}, %r8`,
		...store(),
		'\tmov (%rsi), %r9\n\tmov %r9, 40(%r12)\n\tadd $48, %r12'
	);
}
for (const [label, a, b, rcw, code, kind] of x87) {
	out.push(
		`\t# ${label}`,
		`\tfninit\n\tmovw $${rcw}, cw(%rip)\n\tfldcw cw(%rip)\n\tlea buf(%rip), %rsi`
	);
	if (kind === 'ild') out.push(`\tmovabs $${a}, %r8\n\tmov %r8, (%rsi)\n\t${code}`);
	else
		out.push(
			`\tfldt f80_${b}(%rip)\n\tfldt f80_${a}(%rip)\n\tmovq $0, (%rsi)\n\tmovq $0, 8(%rsi)`,
			'\tpush $0\n\tpopfq',
			`\t${code}`
		);
	out.push(
		'\tpushfq\n\tpop %r9\n\tand $0x8c5, %r9',
		'\tfnstsw %ax\n\tmovzwl %ax, %r10d\n\tand $0x4700, %r10d'
	);
	out.push(
		['st', 'cmp', 'ild'].includes(kind)
			? '\tfstpt 16(%rsi)\n\tmov 16(%rsi), %rax\n\tmovzwq 24(%rsi), %rbx'
			: '\tmov (%rsi), %rax\n\txor %ebx, %ebx'
	);
	out.push(
		'\tmov %r10, %rcx\n\txor %edx, %edx\n\tmov %r9, %r8',
		...store(),
		'\tmovq $0, 40(%r12)\n\tadd $48, %r12'
	);
}
out.push(
	'\tlea out(%rip), %rsi\n\tmov %r12, %rdx\n\tsub %rsi, %rdx\n\tmov $1, %edi\n\tmov $1, %eax\n\tsyscall',
	'\tmov $60, %eax\n\txor %edi, %edi\n\tsyscall',
	'.data\n.balign 16'
);
F80.forEach(([sig, se], k) => out.push(`f80_${k}: .quad ${sig}\n\t.short ${se}\n\t.balign 16`));
out.push(
	'.bss\n.balign 16\nbuf: .zero 64\ncw: .zero 16',
	`out: .zero ${48 * (cases.length + x87.length)}`
);
process.stdout.write(out.join('\n') + '\n');
