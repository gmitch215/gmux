#include <math.h>
#include <string.h>

#include "f80.h"
#include "kb.h"

#define ST(i) cpu->st[(cpu->top + (i)) & 7]

static const f80 K_ONE = {0x8000000000000000ull, 0x3fff};
static const f80 K_ZERO = {0, 0};
static const f80 K_PI = {0xc90fdaa22168c235ull, 0x4000};
static const f80 K_L2T = {0xd49a784bcd1b8afeull, 0x4000};
static const f80 K_L2E = {0xb8aa3b295c17f0bcull, 0x3fff};
static const f80 K_LG2 = {0x9a209a84fbcff799ull, 0x3ffd};
static const f80 K_LN2 = {0xb17217f7d1cf79acull, 0x3ffe};

static int rc(struct kb_cpu* cpu) {
    return (cpu->fcw >> 10) & 3;
}

static void push(struct kb_cpu* cpu, f80 v) {
    cpu->top = (cpu->top - 1) & 7;
    ST(0) = v;
    cpu->ftag |= (uint8_t) (1u << cpu->top);
}

static void pop(struct kb_cpu* cpu) {
    cpu->ftag &= (uint8_t) ~(1u << cpu->top);
    cpu->top = (cpu->top + 1) & 7;
}

/* condition codes C0 C2 C3 from a compare: 1 greater, -1 less, 0 equal, 2
 * unordered */
static void setcc(struct kb_cpu* cpu, int c) {
    cpu->fcc = c == 2 ? 0x4500 : c < 0 ? 0x0100 : c == 0 ? 0x4000 : 0;
}

static void seteflags(struct kb_cpu* cpu, int c) {
    cpu->n = cpu->v = 0;
    cpu->z = c == 0 || c == 2;
    cpu->p = c == 2;
    cpu->c = c < 0 || c == 2;
}

static double to_d(f80 a) {
    uint64_t b = f80_to_bits(a, 52, 11, 0);
    double d;
    memcpy(&d, &b, 8);
    return d;
}

static f80 from_d(double d) {
    uint64_t b;
    memcpy(&b, &d, 8);
    return f80_from_bits(b, 52, 11);
}

static f80 load_mem(struct kb_cpu* cpu, uint64_t addr, int kind) {
    switch (kind) {
        case 0: return f80_from_bits(kb_load(cpu, addr, 4), 23, 8);
        case 1: return f80_from_bits(kb_load(cpu, addr, 8), 52, 11);
        case 2: return f80_from_i64((int32_t) kb_load(cpu, addr, 4));
        case 3: return f80_from_i64((int16_t) kb_load(cpu, addr, 2));
        case 4: return f80_from_i64((int64_t) kb_load(cpu, addr, 8));
        default: {
            f80 v = {
                kb_load(cpu, addr, 8), (uint16_t) kb_load(cpu, addr + 8, 2)
            };
            return v;
        }
    }
}

/* the arithmetic of D8/DC/DE and their integer twins: dst = dst op src */
static f80 arith(struct kb_cpu* cpu, int op, f80 dst, f80 src) {
    int zd;
    switch (op) {
        case 0: return f80_add(dst, src, 0, rc(cpu));
        case 1: return f80_mul(dst, src, rc(cpu));
        case 4: return f80_add(dst, src, 1, rc(cpu));
        case 5: return f80_add(src, dst, 1, rc(cpu));
        case 6: return f80_div(dst, src, rc(cpu), &zd);
        default: return f80_div(src, dst, rc(cpu), &zd);
    }
}

static void store_int(
    struct kb_cpu* cpu, uint64_t addr, f80 v, int bytes, int truncate
) {
    int of;
    int64_t i = f80_to_i64(v, truncate ? 3 : rc(cpu), 8 * bytes, &of);
    kb_store(cpu, addr, (uint64_t) i, bytes);
}

static int fxam(struct kb_cpu* cpu) {
    f80 v = ST(0);
    int c1 = v.se >> 15;
    int cls;
    if (!(cpu->ftag & (1u << cpu->top)))
        cls = 0x4100; /* empty */
    else if (f80_isnan(v))
        cls = 0x0100;
    else if (f80_isinf(v))
        cls = 0x0500;
    else if (f80_iszero(v))
        cls = 0x4000;
    else if (!(v.se & 0x7fff))
        cls = 0x4400; /* denormal */
    else
        cls = 0x0400;
    return cls | (c1 << 9);
}

static int one(struct kb_cpu* cpu, const struct kb_ins* x) {
    int op = (int) (x->imm >> 8) & 7, modrm = (int) (x->imm & 0xff);
    int reg = (modrm >> 3) & 7, i = modrm & 7;
    uint64_t addr = cpu->r[x->b];
    if (x->c & 0x80) {
        switch (op) {
            case 0:
            case 2:
            case 4:
            case 6: {
                f80 src = load_mem(
                    cpu, addr,
                    op == 0   ? 0
                    : op == 4 ? 1
                    : op == 2 ? 2
                              : 3
                );
                if (reg == 2 || reg == 3) {
                    setcc(cpu, f80_cmp(ST(0), src));
                    if (reg == 3) pop(cpu);
                }
                else
                    ST(0) = arith(cpu, reg, ST(0), src);
                return 0;
            }
            case 1:
                switch (reg) {
                    case 0: push(cpu, load_mem(cpu, addr, 0)); return 0;
                    case 2:
                    case 3:
                        kb_store(
                            cpu, addr, f80_to_bits(ST(0), 23, 8, rc(cpu)), 4
                        );
                        if (reg == 3) pop(cpu);
                        return 0;
                    case 4: /* fldenv: the control word, the condition codes and
                               top */
                    {
                        cpu->fcw = (uint16_t) kb_load(cpu, addr, 2);
                        uint16_t sw = (uint16_t) kb_load(cpu, addr + 4, 2);
                        cpu->fcc = sw & 0x4700;
                        cpu->top = (sw >> 11) & 7;
                        return 0;
                    }
                    case 5:
                        cpu->fcw = (uint16_t) kb_load(cpu, addr, 2);
                        return 0;
                    case 6: /* fnstenv */
                        for (int k = 0; k < 28; k += 4)
                            kb_store(cpu, addr + (uint64_t) k, 0, 4);
                        kb_store(cpu, addr, cpu->fcw, 2);
                        kb_store(
                            cpu, addr + 4,
                            (uint64_t) (cpu->fcc | (cpu->top << 11)), 2
                        );
                        {
                            uint16_t tw = 0;
                            for (int k = 0; k < 8; k++)
                                if (!(cpu->ftag & (1u << k)))
                                    tw |= (uint16_t) (3u << (2 * k));
                            kb_store(cpu, addr + 8, tw, 2);
                        }
                        return 0;
                    case 7: kb_store(cpu, addr, cpu->fcw, 2); return 0;
                }
                return -1;
            case 3:
                switch (reg) {
                    case 0: push(cpu, load_mem(cpu, addr, 2)); return 0;
                    case 1:
                        store_int(cpu, addr, ST(0), 4, 1);
                        pop(cpu);
                        return 0;
                    case 2: store_int(cpu, addr, ST(0), 4, 0); return 0;
                    case 3:
                        store_int(cpu, addr, ST(0), 4, 0);
                        pop(cpu);
                        return 0;
                    case 5: push(cpu, load_mem(cpu, addr, 5)); return 0;
                    case 7:
                        kb_store(cpu, addr, ST(0).sig, 8);
                        kb_store(cpu, addr + 8, ST(0).se, 2);
                        pop(cpu);
                        return 0;
                }
                return -1;
            case 5:
                switch (reg) {
                    case 0: push(cpu, load_mem(cpu, addr, 1)); return 0;
                    case 1:
                        store_int(cpu, addr, ST(0), 8, 1);
                        pop(cpu);
                        return 0;
                    case 2:
                    case 3:
                        kb_store(
                            cpu, addr, f80_to_bits(ST(0), 52, 11, rc(cpu)), 8
                        );
                        if (reg == 3) pop(cpu);
                        return 0;
                    case 7:
                        kb_store(
                            cpu, addr, (uint64_t) (cpu->fcc | (cpu->top << 11)),
                            2
                        );
                        return 0;
                }
                return -1;
            case 7:
                switch (reg) {
                    case 0: push(cpu, load_mem(cpu, addr, 3)); return 0;
                    case 1:
                        store_int(cpu, addr, ST(0), 2, 1);
                        pop(cpu);
                        return 0;
                    case 2: store_int(cpu, addr, ST(0), 2, 0); return 0;
                    case 3:
                        store_int(cpu, addr, ST(0), 2, 0);
                        pop(cpu);
                        return 0;
                    case 5: push(cpu, load_mem(cpu, addr, 4)); return 0;
                    case 7:
                        store_int(cpu, addr, ST(0), 8, 0);
                        pop(cpu);
                        return 0;
                }
                return -1;
        }
        return -1;
    }
    /* register forms */
    switch (op) {
        case 0: /* st0 = st0 op sti; fcom, fcomp */
            if (reg == 2 || reg == 3) {
                setcc(cpu, f80_cmp(ST(0), ST(i)));
                if (reg == 3) pop(cpu);
            }
            else
                ST(0) = arith(cpu, reg, ST(0), ST(i));
            return 0;
        case 4: /* sti = sti op st0, with sub/subr and div/divr swapped */
        case 6: /* the same, then pop */
        {
            static const int swap[8] = {0, 1, 2, 3, 5, 4, 7, 6};
            if (op == 6 && modrm == 0xd9) {
                setcc(cpu, f80_cmp(ST(0), ST(1)));
                pop(cpu);
                pop(cpu);
                return 0;
            }
            if (reg == 2 || reg == 3) return -1;
            ST(i) = arith(cpu, swap[reg], ST(i), ST(0));
            if (op == 6) pop(cpu);
            return 0;
        }
        case 1:
            if (reg == 0) {
                f80 v = ST(i);
                push(cpu, v);
                return 0;
            }
            if (reg == 1) {
                f80 t = ST(0);
                ST(0) = ST(i);
                ST(i) = t;
                return 0;
            }
            switch (modrm) {
                case 0xd0: return 0;
                case 0xe0: ST(0).se ^= 0x8000; return 0;
                case 0xe1: ST(0).se &= 0x7fff; return 0;
                case 0xe4: setcc(cpu, f80_cmp(ST(0), K_ZERO)); return 0;
                case 0xe5: cpu->fcc = (uint16_t) fxam(cpu); return 0;
                case 0xe8: push(cpu, K_ONE); return 0;
                case 0xe9: push(cpu, K_L2T); return 0;
                case 0xea: push(cpu, K_L2E); return 0;
                case 0xeb: push(cpu, K_PI); return 0;
                case 0xec: push(cpu, K_LG2); return 0;
                case 0xed: push(cpu, K_LN2); return 0;
                case 0xee: push(cpu, K_ZERO); return 0;
                case 0xf0: ST(0) = from_d(expm1(to_d(ST(0)) * M_LN2)); return 0;
                case 0xf1:
                    ST(1) = from_d(to_d(ST(1)) * log2(to_d(ST(0))));
                    pop(cpu);
                    return 0;
                case 0xf2:
                    ST(0) = from_d(tan(to_d(ST(0))));
                    push(cpu, K_ONE);
                    cpu->fcc &= (uint16_t) ~0x0400;
                    return 0;
                case 0xf3:
                    ST(1) = from_d(atan2(to_d(ST(1)), to_d(ST(0))));
                    pop(cpu);
                    return 0;
                case 0xf4: /* fxtract */
                {
                    f80 v = ST(0);
                    if (f80_isnan(v)) {
                        v.sig |= 0x4000000000000000ull;
                        ST(0) = v;
                        push(cpu, v);
                        return 0;
                    }
                    if (f80_isinf(
                            v
                        )) /* exponent +inf, significand the infinity */
                    {
                        ST(0) = (f80){0x8000000000000000ull, 0x7fff};
                        push(cpu, v);
                        return 0;
                    }
                    if (f80_iszero(v)) /* exponent -inf (a divide by zero),
                                          significand the zero */
                    {
                        ST(0) = (f80){0x8000000000000000ull, 0xffff};
                        push(cpu, v);
                        return 0;
                    }
                    if (!(v.se & 0x7fff)) /* a denormal: normalize first */
                    {
                        int z = __builtin_clzll(v.sig);
                        f80 sig = {
                            v.sig << z, (uint16_t) ((v.se & 0x8000) | 16383)
                        };
                        ST(0) = f80_from_i64(-16382 - z);
                        push(cpu, sig);
                        return 0;
                    }
                    int e = (v.se & 0x7fff) - 16383;
                    f80 sig = {v.sig, (uint16_t) ((v.se & 0x8000) | 16383)};
                    ST(0) = f80_from_i64(e);
                    push(cpu, sig);
                    return 0;
                }
                case 0xf5:
                case 0xf8: {
                    int q;
                    ST(0) = f80_rem(ST(0), ST(1), modrm == 0xf5, &q);
                    cpu->fcc =
                        q < 0 ? 0x0400
                              : (uint16_t) (((q & 1) << 9) | ((q & 2) << 13) |
                                            ((q & 4) << 6));
                    return 0;
                }
                case 0xf6: cpu->top = (cpu->top - 1) & 7; return 0;
                case 0xf7: cpu->top = (cpu->top + 1) & 7; return 0;
                case 0xf9:
                    ST(1) = from_d(to_d(ST(1)) * log1p(to_d(ST(0))) / M_LN2);
                    pop(cpu);
                    return 0;
                case 0xfa: ST(0) = f80_sqrt(ST(0), rc(cpu)); return 0;
                case 0xfb: {
                    double v = to_d(ST(0));
                    ST(0) = from_d(sin(v));
                    push(cpu, from_d(cos(v)));
                    cpu->fcc &= (uint16_t) ~0x0400;
                    return 0;
                }
                case 0xfc: ST(0) = f80_round_int(ST(0), rc(cpu)); return 0;
                case 0xfd: ST(0) = f80_scale(ST(0), ST(1), rc(cpu)); return 0;
                case 0xfe:
                    ST(0) = from_d(sin(to_d(ST(0))));
                    cpu->fcc &= (uint16_t) ~0x0400;
                    return 0;
                case 0xff:
                    ST(0) = from_d(cos(to_d(ST(0))));
                    cpu->fcc &= (uint16_t) ~0x0400;
                    return 0;
            }
            return -1;
        case 2:
        case 3: /* fcmov, fucompp, fucomi, fcomi, fninit, fnclex */
        {
            if (op == 2 && modrm == 0xe9) {
                setcc(cpu, f80_cmp(ST(0), ST(1)));
                pop(cpu);
                pop(cpu);
                return 0;
            }
            if (op == 3 && modrm == 0xe2) return 0;
            if (op == 3 && modrm == 0xe3) {
                cpu->fcw = 0x037f;
                cpu->fcc = 0;
                cpu->top = 0;
                cpu->ftag = 0;
                return 0;
            }
            if (op == 3 && (reg == 5 || reg == 6)) {
                seteflags(cpu, f80_cmp(ST(0), ST(i)));
                return 0;
            }
            if (reg > 3) return -1;
            int cond = reg == 0   ? cpu->c
                       : reg == 1 ? cpu->z
                       : reg == 2 ? (cpu->c || cpu->z)
                                  : cpu->p;
            if (op == 3) cond = !cond;
            if (cond) ST(0) = ST(i);
            return 0;
        }
        case 5:
            switch (reg) {
                case 0:
                    cpu->ftag &= (uint8_t) ~(1u << ((cpu->top + i) & 7));
                    return 0;
                case 2: ST(i) = ST(0); return 0;
                case 3:
                    ST(i) = ST(0);
                    pop(cpu);
                    return 0;
                case 4:
                case 5:
                    setcc(cpu, f80_cmp(ST(0), ST(i)));
                    if (reg == 5) pop(cpu);
                    return 0;
            }
            return -1;
        case 7:
            if (modrm == 0xe0) {
                cpu->r[0] = (cpu->r[0] & ~0xffffull) |
                            (uint64_t) (cpu->fcc | (cpu->top << 11));
                return 0;
            }
            if (reg == 5 || reg == 6) {
                seteflags(cpu, f80_cmp(ST(0), ST(i)));
                pop(cpu);
                return 0;
            }
            if (reg == 0) {
                cpu->ftag &= (uint8_t) ~(1u << ((cpu->top + i) & 7));
                pop(cpu);
                return 0;
            }
            return -1;
    }
    return -1;
}

/** one x87 instruction: imm = opcode << 8 | modrm; b holds a memory operand's
   address. C1 reports whether its rounding went up, for the instructions that
   round */
int kb_x87(struct kb_cpu* cpu, const struct kb_ins* x) {
    int op = (int) (x->imm >> 8) & 7, modrm = (int) (x->imm & 0xff),
        reg = (modrm >> 3) & 7;
    int mem = x->c & 0x80;
    /* the ones that round: arithmetic, sqrt, rndint, scale, and stores of
     * floats or integers */
    int rounds =
        (!mem && (op == 0 || op == 4 || op == 6) && reg != 2 && reg != 3) ||
        (mem && (op == 0 || op == 2 || op == 4 || op == 6) && reg != 2 &&
         reg != 3) ||
        (!mem && op == 1 &&
         (modrm == 0xfa || modrm == 0xfc || modrm == 0xfd)) ||
        (mem && (op == 1 || op == 5) && (reg == 2 || reg == 3)) ||
        (mem && (op == 3 || op == 7 || op == 5) && reg >= 1 && reg <= 3) ||
        (mem && op == 7 && reg == 7);
    f80_c1 = 0;
    int r = one(cpu, x);
    if (rounds)
        cpu->fcc = (uint16_t) ((cpu->fcc & ~0x0200) | (f80_c1 ? 0x0200 : 0));
    return r;
}
