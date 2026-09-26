"""Writes an x86-64 assembly program that runs every instruction form below on edge-case inputs and
prints, per case, the registers and the flags the instruction defines. Run natively and under
katybug, the two outputs must be equal. `python3 x86-ops.py > x86-ops.S`"""
import random

random.seed(215)
EDGE = [0, 1, 2, 0x7f, 0x80, 0xff, 0x100, 0x7fff, 0x8000, 0xffff, 0x7fffffff, 0x80000000,
        0xffffffff, 0x100000000, 0x7fffffffffffffff, 0x8000000000000000, 0xffffffffffffffff,
        0x123456789abcdef0, 0xfedcba9876543210]
EDGE += [random.getrandbits(64) for _ in range(6)] + [random.getrandbits(8) for _ in range(3)]
COUNTS = [0, 1, 3, 7, 8, 15, 16, 31, 32, 33, 63, 64, 65]
CF, PF, ZF, SF, OF = 1, 4, 0x40, 0x80, 0x800
ARITH = CF | PF | ZF | SF | OF
LOGIC = CF | PF | ZF | SF | OF  # cleared CF/OF are defined
SZP = PF | ZF | SF

cases = []  # (label, code, inputs, flag mask)


def pairs(n=40):
    out = []
    for _ in range(n):
        out.append((random.choice(EDGE), random.choice(EDGE), random.choice([0, CF, ARITH, ZF | CF])))
    return out


def add(label, code, mask, inputs=None):
    for k, (a, b, f) in enumerate(inputs or pairs()):
        cases.append((f'{label}#{k}', code, a, b, f, mask))


W = {'q': ('rax', 'rbx', 'rcx', 'rdx'), 'l': ('eax', 'ebx', 'ecx', 'edx'),
     'w': ('ax', 'bx', 'cx', 'dx'), 'b': ('al', 'bl', 'cl', 'dl')}
for op in ['add', 'or', 'adc', 'sbb', 'and', 'sub', 'xor', 'cmp', 'test']:
    for s, (a, b, c, d) in W.items():
        add(f'{op}{s} r,r', f'{op}{s} %{b}, %{a}', ARITH)
        add(f'{op}{s} m,r', f'{op}{s} %{b}, (%rsi)', ARITH)
        add(f'{op}{s} r,m', f'{op}{s} (%rsi), %{a}', ARITH)
        if s != 'b':
            add(f'{op}{s} imm8', f'{op}{s} $-3, %{a}', ARITH)
        add(f'{op}{s} imm', f'{op}{s} ${0x55 if s == "b" else 0x1234 if s == "w" else 0x7ffff00f}, %{a}', ARITH)
    add(f'{op}b ah', f'{op}b %bh, %ah', ARITH)
for op, mask in [('inc', SZP | OF), ('dec', SZP | OF), ('neg', ARITH), ('not', 0)]:
    for s, (a, *_r) in W.items():
        add(f'{op}{s}', f'{op}{s} %{a}', mask)
        add(f'{op}{s} m', f'{op}{s} (%rsi)', mask)
for op in ['shl', 'shr', 'sar', 'rol', 'ror']:
    fmask = (CF | SZP) if op in ('shl', 'shr', 'sar') else 0
    for s, (a, *_r) in W.items():
        add(f'{op}{s} 1', f'{op}{s} $1, %{a}', fmask | (OF if op != 'sar' else 0))
        for n in [3, 7, 13]:
            add(f'{op}{s} {n}', f'{op}{s} ${n}, %{a}', fmask)
        for n in COUNTS:
            add(f'{op}{s} cl={n}', f'movb ${n}, %cl\n\t{op}{s} %cl, %{a}', fmask if n else 0,
                [(random.choice(EDGE), random.choice(EDGE), random.choice([0, ARITH])) for _ in range(4)])
for s, (a, b, *_r) in [('q', W['q']), ('l', W['l']), ('w', W['w'])]:
    add(f'imul{s} r,r', f'imul{s} %{b}, %{a}', CF | OF)
    add(f'imul{s} r,r,imm', f'imul{s} $-77, %{b}, %{a}', CF | OF)
for s, (a, b, *_r) in W.items():
    add(f'mul{s}', f'mul{s} %{b}', CF | OF)
    add(f'imul{s} 1op', f'imul{s} %{b}', CF | OF)
safe = []
for _ in range(40):
    divisor = random.choice([1, 3, 7, 10, 255, 1000, 65537, 0x7fffffff, 0xffffffff, 0x123456789])
    safe.append((random.getrandbits(62), divisor, 0))
add('divq', 'xor %edx, %edx\n\tdivq %rbx', 0, safe)
add('divl', 'xor %edx, %edx\n\tdivl %ebx', 0, [(a, b & 0xffffffff or 1, f) for a, b, f in safe])
add('idivq', 'cqto\n\tidivq %rbx', 0, [(a - (1 << 61), b, f) for a, b, f in safe])
add('idivl', 'cltd\n\tidivl %ebx', 0, [(a & 0xffffffff, b & 0x7fffffff or 1, f) for a, b, f in safe])
for ins in ['movzbl %bl, %eax', 'movzwl %bx, %eax', 'movsbl %bl, %eax', 'movswl %bx, %eax',
            'movsbq %bl, %rax', 'movswq %bx, %rax', 'movslq %ebx, %rax', 'movzbq %bl, %rax',
            'movb %bh, %al', 'movw %bx, %ax', 'movl %ebx, %eax', 'cltq', 'cqto', 'cltd', 'cwtl', 'cbtw',
            'bswapq %rax', 'bswapl %eax', 'xchgq %rbx, %rax', 'xchgl %ebx, %eax', 'xchgb %bl, %al',
            'leaq 0x7f(%rax,%rbx,4), %rax', 'leal -1(%rax,%rbx,8), %eax', 'leaq (%rbx), %rax']:
    add(ins, ins, 0)
for cc in ['o', 'no', 'b', 'ae', 'e', 'ne', 'be', 'a', 's', 'ns', 'p', 'np', 'l', 'ge', 'le', 'g']:
    add(f'set{cc}', f'cmpq %rbx, %rax\n\tset{cc} %cl', 0)
    add(f'set{cc} 8', f'cmpb %bl, %al\n\tset{cc} %cl', 0)
    add(f'cmov{cc}', f'cmpl %ebx, %eax\n\tcmov{cc}q %rbx, %rcx', 0)
    add(f'cmov{cc}l', f'cmpq %rbx, %rax\n\tcmov{cc}l %ebx, %ecx', 0)
for s, (a, b, *_r) in [('q', W['q']), ('l', W['l']), ('w', W['w'])]:
    add(f'bt{s} r', f'bt{s} %{b}, %{a}', CF)
    add(f'bt{s} imm', f'bt{s} $5, %{a}', CF)
    # a register offset into memory is a signed index into a bit string around buf+32
    offsets = [(random.choice(EDGE), o, random.choice([0, CF, ZF | CF]))
               for o in [0, 1, 5, 15, 16, 31, 32, 63, 64, 100, 255, -1, -17, -64, -256]]
    for op in ['bt', 'bts', 'btr', 'btc']:
        if op != 'bt':
            add(f'{op}{s} r', f'{op}{s} %{b}, %{a}', CF | ZF)
            add(f'{op}{s} imm', f'{op}{s} $5, %{a}', CF | ZF)
        add(f'{op}{s} imm m', f'{op}{s} $37, (%rsi)', CF | ZF)
        add(f'{op}{s} m,r', f'lea 32(%rsi), %rsi\n\t{op}{s} %{b}, (%rsi)', CF | ZF,
            [(x, o & ((1 << 64) - 1), f) for x, o, f in offsets])
    add(f'bsf{s}', f'bsf{s} %{b}, %{a}', ZF)
    add(f'bsr{s}', f'bsr{s} %{b}, %{a}', ZF)
    add(f'tzcnt{s}', f'tzcnt{s} %{b}, %{a}', CF | ZF)
    add(f'lzcnt{s}', f'lzcnt{s} %{b}, %{a}', CF | ZF)
    add(f'shld{s} imm', f'shld{s} $5, %{b}, %{a}', CF | SZP)
    add(f'shrd{s} imm', f'shrd{s} $5, %{b}, %{a}', CF | SZP)
    # counts above the operand width are undefined for 16 bits
    limit = {'q': 63, 'l': 31, 'w': 16}[s]
    for n in [c for c in COUNTS if c <= limit]:
        add(f'shld{s} cl={n}', f'movb ${n}, %cl\n\tshld{s} %cl, %{b}, %{a}', 0,
            [(random.choice(EDGE), random.choice(EDGE), 0) for _ in range(3)])
for s, (a, b, *_r) in W.items():
    add(f'xadd{s}', f'xadd{s} %{b}, %{a}', ARITH)
    add(f'cmpxchg{s}', f'cmpxchg{s} %{b}, %{W[s][2]}', ARITH)
    add(f'cmpxchg{s} m', f'cmpxchg{s} %{b}, (%rsi)', ARITH)
# flag writes a later op overwrites only in part, or not at all, or reads first: katybug's plan
# may drop a flag write only when nothing reads what it wrote
for label, code, mask in [
        ('add; inc', 'addq %rbx, %rax\n\tincq %rcx', ARITH),
        ('sub; dec', 'subq %rbx, %rax\n\tdecq %rdx', ARITH),
        ('add; bt', 'addq %rbx, %rax\n\tbtq $3, %rcx', CF | ZF),
        ('add; shl cl=0', 'addq %rbx, %rax\n\tmovb $0, %cl\n\tshlq %cl, %rdx', ARITH),
        ('add; rol cl=0', 'addq %rbx, %rax\n\tmovb $0, %cl\n\trolq %cl, %rdx', ARITH),
        ('add; sub', 'addq %rbx, %rax\n\tsubq %rcx, %rdx', ARITH),
        ('add; setc; sub', 'addq %rbx, %rax\n\tsetc %dl\n\tsubq %rcx, %rax', ARITH),
        ('add; adc; sub', 'addq %rbx, %rax\n\tadcq $0, %rcx\n\tsubq %rbx, %rdx', ARITH),
        ('cmp; cmovb; xor', 'cmpq %rbx, %rax\n\tcmovbq %rbx, %rcx\n\txorq %rax, %rdx', ARITH)]:
    add(f'plan {label}', code, mask)
add('stc', 'stc', CF)
add('clc', 'clc', CF)
add('cmc', 'cmc', CF)
add('lahf', 'lahf', 0)
add('sahf', 'sahf', ARITH & ~OF)

# SSE/SSE2: xmm0 = (rax, rdx) and xmm1 = (rbx, rcx); the result comes back as rax, rdx (xmm0) and
# EFLAGS, which only the compares may change
DBL = [0, 1 << 63, 0x3ff0000000000000, 0xbff8000000000000, 0x4008000000000000, 0x3fb999999999999a,
       0x7e37e43c8800759c, 0x8190000000000000, 0x7ff0000000000000, 0xfff0000000000000,
       0x7ff8000000000001, 0x7ff0000000000001, 0xfff8000000000000, 1, 0x7fefffffffffffff,
       0x3fd5555555555555, 0xc1e0000000100000, 0x41dfffffffc00000, 0x43e0000000000000, 0x3fe0000000000000,
       0x3ff8000000000000, 0x4004000000000000]
FLT = [0, 0x80000000, 0x3f800000, 0xbfc00000, 0x3dcccccd, 0x7f800000, 0xff800000, 0x7fc00001, 0x7f800001,
       1, 0x7f7fffff, 0x40400000, 0x00800000, 0x4b800001, 0xcf000000, 0x3f000000, 0x40200000]
dbl = lambda: random.choice(DBL)
flt = lambda: random.choice(FLT) | random.choice(FLT) << 32
SSE_IN = '\n\t'.join(['mov %rax, 16(%rsi)', 'mov %rdx, 24(%rsi)', 'movdqu 16(%rsi), %xmm0',
                        'mov %rbx, 32(%rsi)', 'mov %rcx, 40(%rsi)', 'movdqu 32(%rsi), %xmm1'])
SSE_OUT = 'movdqu %xmm0, 16(%rsi)\n\tmov 16(%rsi), %rax\n\tmov 24(%rsi), %rdx'
SSE_GPR = 'movdqu %xmm0, 16(%rsi)\n\tmov 24(%rsi), %rdx'


def sse(ins, gen, gpr=False, n=40):
    add(f'sse {ins}', f'{SSE_IN}\n\t{ins}\n\t{SSE_GPR if gpr else SSE_OUT}', ARITH,
        [(gen(), gen(), random.choice([0, ARITH])) for _ in range(n)])


for op in ['add', 'sub', 'mul', 'div', 'min', 'max', 'sqrt']:
    sse(f'{op}sd %xmm1, %xmm0', dbl)
    sse(f'{op}pd %xmm1, %xmm0', dbl)
    sse(f'{op}ss %xmm1, %xmm0', flt)
    sse(f'{op}ps %xmm1, %xmm0', flt)
sse('addsd 32(%rsi), %xmm0', dbl)
sse('movsd 32(%rsi), %xmm0', dbl, n=4)
sse('movss 32(%rsi), %xmm0', flt, n=4)
sse('movsd %xmm1, %xmm0', dbl, n=4)
sse('movss %xmm1, %xmm0', flt, n=4)
for k in range(8):
    sse(f'cmpsd ${k}, %xmm1, %xmm0', dbl, n=24)
    sse(f'cmppd ${k}, %xmm1, %xmm0', dbl, n=12)
    sse(f'cmpss ${k}, %xmm1, %xmm0', flt, n=24)
    sse(f'cmpps ${k}, %xmm1, %xmm0', flt, n=12)
for ins in ['ucomisd', 'comisd']:
    sse(f'{ins} %xmm1, %xmm0', dbl)
for ins in ['ucomiss', 'comiss']:
    sse(f'{ins} %xmm1, %xmm0', flt)
for ins, gen in [('cvttsd2si %xmm1, %rax', dbl), ('cvttsd2si %xmm1, %eax', dbl), ('cvtsd2si %xmm1, %rax', dbl),
                 ('cvtsd2si %xmm1, %eax', dbl), ('cvttss2si %xmm1, %rax', flt), ('cvttss2si %xmm1, %eax', flt),
                 ('cvtss2si %xmm1, %eax', flt), ('movmskpd %xmm1, %eax', dbl), ('movmskps %xmm1, %eax', flt),
                 ('pmovmskb %xmm1, %eax', dbl)]:
    sse(ins, gen, gpr=True)
for ins, gen in [('cvtsd2ss %xmm1, %xmm0', dbl), ('cvtss2sd %xmm1, %xmm0', flt), ('cvtpd2ps %xmm1, %xmm0', dbl),
                 ('cvtps2pd %xmm1, %xmm0', flt), ('cvtdq2pd %xmm1, %xmm0', flt), ('cvttpd2dq %xmm1, %xmm0', dbl),
                 ('cvtpd2dq %xmm1, %xmm0', dbl), ('cvtdq2ps %xmm1, %xmm0', flt), ('cvtps2dq %xmm1, %xmm0', flt),
                 ('cvttps2dq %xmm1, %xmm0', flt), ('cvtsi2sd %rbx, %xmm0', lambda: random.choice(EDGE)),
                 ('cvtsi2sdl %ebx, %xmm0', lambda: random.choice(EDGE)),
                 ('cvtsi2ss %rbx, %xmm0', lambda: random.choice(EDGE)),
                 ('cvtsi2ssl %ebx, %xmm0', lambda: random.choice(EDGE))]:
    sse(ins, gen)
for ins in ['andpd', 'andnpd', 'orpd', 'xorpd', 'unpcklpd', 'unpckhpd', 'unpcklps', 'shufpd $1,', 'shufps $0x1b,',
            'shufps $0xe4,']:
    sse(f'{ins} %xmm1, %xmm0', flt, n=12)
ints = lambda: random.choice(EDGE)
for ins in ['paddb', 'paddw', 'paddd', 'paddq', 'psubb', 'psubw', 'psubd', 'psubq', 'pcmpeqb', 'pcmpeqw',
            'pcmpeqd', 'pcmpgtb', 'pcmpgtw', 'pcmpgtd', 'pminub', 'pmaxub', 'pand', 'pandn', 'por', 'pxor',
            'punpcklbw', 'punpcklwd', 'punpckldq', 'punpcklqdq', 'punpckhbw', 'punpckhwd', 'punpckhdq',
            'punpckhqdq', 'packsswb', 'packuswb', 'packssdw', 'pmuludq', 'psllw', 'pslld', 'psllq', 'psrlw',
            'psrld', 'psrlq', 'psraw', 'psrad']:
    sse(f'{ins} %xmm1, %xmm0', ints, n=16)
for k in [0, 3, 7]:
    sse(f'pextrw ${k}, %xmm1, %eax', ints, gpr=True, n=8)
    sse(f'pinsrw ${k}, %ebx, %xmm0', ints, n=8)
    sse(f'pinsrw ${k}, (%rsi), %xmm0', ints, n=4)
for ins in ['pshufd $0x1b,', 'pshuflw $0x1b,', 'pshufhw $0x1b,']:
    sse(f'{ins} %xmm1, %xmm0', ints, n=8)
for ins in ['psllw', 'pslld', 'psllq', 'psrlw', 'psrld', 'psrlq', 'psraw', 'psrad', 'pslldq', 'psrldq']:
    for c in [0, 1, 7, 15, 16, 31, 33, 63, 64]:
        sse(f'{ins} ${c}, %xmm0', ints, n=2)

# x87: operands as 80-bit values, each case records the 80-bit result, the status word and EFLAGS
F80 = [(0, 0), (0, 0x8000), (1 << 63, 0x3fff), (1 << 63, 0xbfff), (1 << 63, 0x3ffe), (0xc000000000000000, 0x4000),
       (0xc90fdaa22168c235, 0x4000), (0xaaaaaaaaaaaaaaab, 0x3ffd), (0xd6bf94d5e57a42bc, 0x43e1),
       (0xd6bf94d5e57a42bc, 0x3c1e), (1 << 63, 0x3c01), (0xffffffffffffffff, 0x7ffe), (1, 0),
       (1 << 63, 0x7fff), (1 << 63, 0xffff), (0xc000000000000000, 0x7fff), (1 << 63, 0x403e),
       (1 << 63, 0xc03e), (1 << 63, 0x403f), (0xc000000000000000, 0x3fff), (0xa000000000000000, 0x4000),
       (0xa000000000000000, 0xc000), (0xffffffffffffffff, 0x3fff), (0x8000000000000001, 0x3fff),
       (0xe000000000000000, 0x4005), (0x9c40000000000000, 0x400c), (0x8000000000000000, 0x4010)]
x87 = []
BIN = ['faddp', 'fsubp', 'fsubrp', 'fmulp', 'fdivp', 'fdivrp']
for k in range(260):
    a, b = random.randrange(len(F80)), random.randrange(len(F80))
    rcw = random.choice([0x037f, 0x077f, 0x0b7f, 0x0f7f])
    x87.append((f'x87 {BIN[k % 6]} rc={rcw >> 10 & 3}#{k}', a, b, rcw, BIN[k % 6] + ' %st, %st(1)', 'st'))
for name in BIN + ['fscale', 'fprem', 'fprem1']:
    code = name + ' %st, %st(1)' if name in BIN else name
    for a in range(len(F80)):
        for b in range(len(F80)):
            x87.append((f'x87 {name} all#{a},{b}', a, b, 0x037f, code, 'st'))
for name in ['fsqrt', 'frndint', 'fchs', 'fabs', 'fxtract', 'fscale', 'fprem', 'fprem1', 'fxam', 'ftst']:
    for k in range(24):
        a, b = random.randrange(len(F80)), random.randrange(len(F80))
        rcw = random.choice([0x037f, 0x077f, 0x0b7f, 0x0f7f])
        x87.append((f'x87 {name}#{k}', a, b, rcw, name, 'st'))
for name, kind in [('fistps', 2), ('fistpl', 4), ('fistpll', 8), ('fisttps', 2), ('fisttpl', 4), ('fisttpll', 8),
                   ('fstps', 4), ('fstpl', 8)]:
    for k in range(28):
        a = random.randrange(len(F80))
        rcw = random.choice([0x037f, 0x077f, 0x0b7f, 0x0f7f])
        x87.append((f'x87 {name}#{k}', a, a, rcw, f'{name} (%rsi)', f'm{kind}'))
for name in ['fcomi %st(1), %st', 'fucomi %st(1), %st', 'fcom %st(1)', 'fucom %st(1)']:
    for k in range(24):
        a, b = random.randrange(len(F80)), random.randrange(len(F80))
        x87.append((f'x87 {name}#{k}', a, b, 0x037f, name, 'cmp'))
for k in range(30):
    v = random.choice(EDGE)
    x87.append((f'x87 fildll#{k}', v, 0, 0x037f, 'fildll (%rsi)', 'ild'))

print('.globl _start\n.text\n_start:')
print('\tlea out(%rip), %r12')
for label, code, a, b, f, mask in cases:
    print(f'\t# {label}')
    print(f'\tmovabs ${a}, %rax\n\tmovabs ${b}, %rbx\n\tmovabs ${b ^ 0x5a5a5a5a5a5a5a5a}, %rcx')
    print(f'\tmovabs ${a ^ 0x0f0f0f0f0f0f0f0f}, %rdx')
    print(f'\tlea buf(%rip), %rsi\n\tmovabs ${a ^ b}, %r8\n\tmov %r8, (%rsi)')
    print(f'\tpush ${f}\n\tpopfq')
    print(f'\t{code}')
    print('\tpushfq\n\tpop %r8')
    print(f'\tand ${mask}, %r8')
    for i, reg in enumerate(['rax', 'rbx', 'rcx', 'rdx', 'r8']):
        print(f'\tmov %{reg}, {8 * i}(%r12)')
    print('\tmov (%rsi), %r9\n\tmov %r9, 40(%r12)\n\tadd $48, %r12')
for label, a, b, rcw, code, kind in x87:
    print(f'\t# {label}')
    print(f'\tfninit\n\tmovw ${rcw}, cw(%rip)\n\tfldcw cw(%rip)\n\tlea buf(%rip), %rsi')
    if kind == 'ild':
        print(f'\tmovabs ${a}, %r8\n\tmov %r8, (%rsi)\n\t{code}')
    else:
        print(f'\tfldt f80_{b}(%rip)\n\tfldt f80_{a}(%rip)\n\tmovq $0, (%rsi)\n\tmovq $0, 8(%rsi)')
        print('\tpush $0\n\tpopfq')
        print(f'\t{code}')
    print('\tpushfq\n\tpop %r9\n\tand $0x8c5, %r9')
    print('\tfnstsw %ax\n\tmovzwl %ax, %r10d\n\tand $0x4700, %r10d')
    if kind in ('st', 'cmp', 'ild'):
        print('\tfstpt 16(%rsi)\n\tmov 16(%rsi), %rax\n\tmovzwq 24(%rsi), %rbx')
    else:
        print('\tmov (%rsi), %rax\n\txor %ebx, %ebx')
    print('\tmov %r10, %rcx\n\txor %edx, %edx\n\tmov %r9, %r8')
    for i, reg in enumerate(['rax', 'rbx', 'rcx', 'rdx', 'r8']):
        print(f'\tmov %{reg}, {8 * i}(%r12)')
    print('\tmovq $0, 40(%r12)\n\tadd $48, %r12')
print('\tlea out(%rip), %rsi\n\tmov %r12, %rdx\n\tsub %rsi, %rdx\n\tmov $1, %edi\n\tmov $1, %eax\n\tsyscall')
print('\tmov $60, %eax\n\txor %edi, %edi\n\tsyscall')
print('.data\n.balign 16')
for k, (sig, se) in enumerate(F80):
    print(f'f80_{k}: .quad {sig}\n\t.short {se}\n\t.balign 16')
print('.bss\n.balign 16\nbuf: .zero 64\ncw: .zero 16')
print(f'out: .zero {48 * (len(cases) + len(x87))}')
