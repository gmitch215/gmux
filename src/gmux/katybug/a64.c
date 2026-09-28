#include <stdlib.h>

#include "kb.h"

enum
{
    TA = KB_T0,
    T1,
    T2,
    T3,
    T4,
    T5
};

struct dec {
    struct kb_cpu* cpu;
    struct kb_emit* e;
    uint64_t pc;
};

static void put(struct dec* d, int op, int w, int a, int b, int c, int64_t x) {
    kb_put(d->e, op, w, a, b, c, x);
}

static int64_t sx(uint64_t v, int bits) {
    return (int64_t) (v << (64 - bits)) >> (64 - bits);
}

/* register 31 is either sp or xzr depending on the instruction */
static int rs(unsigned r) {
    return (int) r;
}
static int rz(unsigned r) {
    return r == 31 ? KB_ZERO : (int) r;
}

static void movi(struct dec* d, int t, int64_t v) {
    put(d, KB_MOVI, 8, t, 0, 0, v);
}

/* writes v to Xd (or Wd, zero-extending) */
static void wr(struct dec* d, int rd, int sf, int v) {
    if (rd == KB_ZERO) return;
    put(d, sf ? KB_MOV : KB_ZEXT, sf ? 8 : 4, rd, v, 0, 0);
}

/* the value of Rm shifted (lsl lsr asr ror) by amount */
static int shifted(struct dec* d, int rm, int type, int amount, int sf, int t) {
    if (!amount && type != 3) return rm;
    if (!sf) {
        put(d, type == 2 ? KB_SEXT : KB_ZEXT, 4, t, rm, 0, 0);
        rm = t;
    }
    movi(d, T5, amount);
    static const int ops[4] = {KB_SHL, KB_SHR, KB_SAR, KB_ROR};
    put(d, ops[type], sf ? 8 : 4, t, rm, T5, 0);
    return t;
}

/* the value of Rm extended (uxtb uxth uxtw uxtx sxtb sxth sxtw sxtx) and
 * shifted left */
static int extended(struct dec* d, int rm, int option, int shift, int t) {
    static const int w[4] = {1, 2, 4, 8};
    int n = w[option & 3];
    if (n < 8)
        put(d, (option & 4) ? KB_SEXT : KB_ZEXT, n, t, rm, 0, 0);
    else
        put(d, KB_MOV, 8, t, rm, 0, 0);
    if (shift) {
        movi(d, T5, shift);
        put(d, KB_SHL, 8, t, t, T5, 0);
    }
    return t;
}

/* DecodeBitMasks for logical immediates */
static int bitmask(
    unsigned n, unsigned imms, unsigned immr, int sf, uint64_t* out
) {
    unsigned combined = (n << 6) | (~imms & 0x3f);
    int len = 31 - __builtin_clz(combined ? combined : 1);
    if (len < 1 || (!sf && n)) return -1;
    unsigned size = 1u << len, levels = size - 1;
    unsigned s = imms & levels, r = immr & levels;
    if (s == levels) return -1;
    uint64_t welem = (s + 1 == 64) ? ~0ull : ((1ull << (s + 1)) - 1);
    uint64_t emask = size == 64 ? ~0ull : ((1ull << size) - 1);
    uint64_t rot = r ? ((welem >> r) | (welem << (size - r))) & emask : welem;
    uint64_t v = 0;
    for (unsigned i = 0; i < 64; i += size) v |= rot << i;
    *out = sf ? v : (v & 0xffffffffull);
    return 0;
}

static void flags(struct dec* d, int kind, int sf, int res, int a, int b) {
    put(d, KB_FLAGS, sf ? 8 : 4, res, a, b, kind);
}

/* loads and stores of size 1 << size at address TA */
static void ldst(struct dec* d, unsigned size, unsigned opc, unsigned rt) {
    int w = 1 << size;
    if (opc == 0) /* store */
        put(d, KB_ST, w, rz(rt), TA, 0, 0);
    else if (opc == 1) /* zero-extending load */
    {
        put(d, KB_LD, w, T1, TA, 0, 0);
        wr(d, rz(rt), 1, T1);
    }
    else /* sign-extending: opc 2 to 64 bits, 3 to 32 */
    {
        put(d, KB_LDS, w, T1, TA, 0, 0);
        wr(d, rz(rt), opc == 2, T1);
    }
}

/* a load or store's access, log2 bytes: a q register is size 0 with opc bit 1
 */
static unsigned vscale(uint32_t i) {
    unsigned size = i >> 30;
    return ((i >> 26) & 1) && ((i >> 23) & 1) && size == 0 ? 4 : size;
}

/* floating point and SIMD go to a64v.c whole, a load or store's address in TA
 */
static int vec(struct dec* d, uint32_t i) {
    put(d, KB_A64V, 8, 0, TA, 0, (int64_t) i);
    return 0;
}

/* the bytes an ld1-ld4/st1-st4 moves, for its post-index writeback */
static int structure_bytes(uint32_t i) {
    unsigned q = (i >> 30) & 1;
    if (!((i >> 24) & 1)) {
        static const int regs[16] = {4, 0, 4, 0, 3, 0, 3, 1, 2, 0, 2};
        return regs[(i >> 12) & 15] * (q ? 16 : 8);
    }
    unsigned opc = (i >> 13) & 7, r = (i >> 21) & 1, size = (i >> 10) & 3,
             scale = opc >> 1;
    int selem = (int) ((opc & 1) << 1 | r) + 1;
    int eb = scale == 3   ? 1 << size
             : scale == 2 ? (size & 1 ? 8 : 4)
                          : 1 << scale;
    return selem * eb;
}

static int one(struct dec* d, struct kb_block* blk) {
    uint32_t* p = (uint32_t*) kb_host(d->cpu, d->pc, 4);
    if (!p) return -1;
    uint32_t i = *p;
    uint64_t pc = d->pc;
    d->pc += 4;
    put(d, KB_PC, 8, 0, 0, 0, (int64_t) pc);
    unsigned sf = i >> 31, rd = i & 31, rn = (i >> 5) & 31, rm = (i >> 16) & 31;

    if ((i & 0x0e000000) == 0x0e000000) /* floating point and SIMD */
        return vec(d, i);
    if ((i & 0xbe000000) == 0x0c000000) /* ld1-ld4, st1-st4 */
    {
        put(d, KB_MOV, 8, TA, rs(rn), 0, 0);
        vec(d, i);
        if ((i >> 23) & 1) { /* post index: by the bytes moved, or by xm */
            if (rm == 31) {
                movi(d, T5, structure_bytes(i));
                put(d, KB_ADD, 8, rs(rn), rs(rn), T5, 0);
            }
            else
                put(d, KB_ADD, 8, rs(rn), rs(rn), rz(rm), 0);
        }
        return 0;
    }

    /* data processing, immediate */
    if ((i & 0x1f000000) == 0x10000000) /* adr, adrp */
    {
        int64_t imm = sx(((i >> 3) & 0x1ffffc) | ((i >> 29) & 3), 21);
        uint64_t v = (i >> 31) ? (pc & ~0xfffull) + ((uint64_t) imm << 12)
                               : pc + (uint64_t) imm;
        movi(d, T1, (int64_t) v);
        wr(d, rz(rd), 1, T1);
        return 0;
    }
    if ((i & 0x1f000000) == 0x11000000) /* add/sub immediate */
    {
        unsigned op = (i >> 30) & 1, s = (i >> 29) & 1;
        uint64_t imm = (i >> 10) & 0xfff;
        if ((i >> 22) & 1) imm <<= 12;
        int n = rs(rn);
        movi(d, T2, (int64_t) imm);
        put(d, op ? KB_SUB : KB_ADD, 8, T3, n, T2, 0);
        if (s) flags(d, op ? KB_F_A_SUB : KB_F_A_ADD, sf, T3, n, T2);
        wr(d, s ? rz(rd) : rs(rd), sf, T3);
        return 0;
    }
    if ((i & 0x1f800000) == 0x12000000) /* logical immediate */
    {
        unsigned opc = (i >> 29) & 3;
        uint64_t imm;
        if (bitmask(
                (i >> 22) & 1, (i >> 10) & 0x3f, (i >> 16) & 0x3f, sf, &imm
            ))
            goto bad;
        static const int ops[4] = {KB_AND, KB_OR, KB_XOR, KB_AND};
        movi(d, T2, (int64_t) imm);
        put(d, ops[opc], 8, T3, rz(rn), T2, 0);
        if (opc == 3) flags(d, KB_F_A_LOGIC, sf, T3, T3, T3);
        wr(d, opc == 3 ? rz(rd) : rs(rd), sf, T3);
        return 0;
    }
    if ((i & 0x1f800000) == 0x12800000) /* movn movz movk */
    {
        unsigned opc = (i >> 29) & 3, hw = (i >> 21) & 3;
        uint64_t imm = (uint64_t) ((i >> 5) & 0xffff) << (16 * hw);
        if (opc == 0)
            movi(d, T1, (int64_t) ~imm);
        else if (opc == 2)
            movi(d, T1, (int64_t) imm);
        else if (opc == 3) {
            put(d, KB_MOV, 8, T1, rz(rd), 0, 0);
            movi(d, T2, (int64_t) (imm >> (16 * hw)));
            put(d, KB_INS, 2, T1, T2, 0, 16 * hw);
        }
        else
            goto bad;
        wr(d, rz(rd), sf, T1);
        return 0;
    }
    if ((i & 0x1f800000) == 0x13000000) /* sbfm bfm ubfm */
    {
        unsigned opc = (i >> 29) & 3, immr = (i >> 16) & 0x3f,
                 imms = (i >> 10) & 0x3f;
        int bits = sf ? 64 : 32;
        int src = rz(rn);
        if (opc == 2 || opc == 0) {
            /* ubfm/sbfm: take bits imms..immr of Rn (a field) or place a field
             * at (bits - immr) */
            if (imms >= immr) {
                int len = (int) (imms - immr + 1);
                movi(d, T5, (int64_t) immr);
                put(d, KB_SHR, 8, T1, src, T5, 0);
                if (!sf && opc == 2) {
                    put(d, KB_ZEXT, 4, T1, src, 0, 0);
                    movi(d, T5, (int64_t) immr);
                    put(d, KB_SHR, 8, T1, T1, T5, 0);
                }
                if (len < 64) {
                    movi(d, T5, 64 - len);
                    put(d, KB_SHL, 8, T1, T1, T5, 0);
                    put(d, opc == 0 ? KB_SAR : KB_SHR, 8, T1, T1, T5, 0);
                }
            }
            else {
                int len = (int) imms + 1, pos = bits - (int) immr;
                movi(d, T5, 64 - len);
                put(d, KB_SHL, 8, T1, src, T5, 0);
                put(d, opc == 0 ? KB_SAR : KB_SHR, 8, T1, T1, T5, 0);
                movi(d, T5, pos);
                put(d, KB_SHL, 8, T1, T1, T5, 0);
            }
            wr(d, rz(rd), sf, T1);
            return 0;
        }
        if (opc == 1) /* bfm: bfi, bfxil */
        {
            int len, pos;
            put(d, KB_MOV, 8, T1, src, 0, 0);
            if (imms >= immr) {
                len = (int) (imms - immr + 1);
                pos = 0;
                movi(d, T5, (int64_t) immr);
                put(d, KB_SHR, 8, T1, T1, T5, 0);
            }
            else {
                len = (int) imms + 1;
                pos = bits - (int) immr;
            }
            put(d, KB_MOV, 8, T2, rz(rd), 0, 0);
            /* insert len bits at pos, a byte-granular INS is not enough: mask
             * by hand */
            uint64_t m = (len >= 64 ? ~0ull : ((1ull << len) - 1)) << pos;
            movi(d, T5, pos);
            put(d, KB_SHL, 8, T1, T1, T5, 0);
            movi(d, T5, (int64_t) m);
            put(d, KB_AND, 8, T1, T1, T5, 0);
            movi(d, T5, (int64_t) ~m);
            put(d, KB_AND, 8, T2, T2, T5, 0);
            put(d, KB_OR, 8, T1, T1, T2, 0);
            wr(d, rz(rd), sf, T1);
            return 0;
        }
        goto bad;
    }
    if ((i & 0x1f800000) == 0x13800000) /* extr */
    {
        unsigned lsb = (i >> 10) & 0x3f;
        int bits = sf ? 64 : 32;
        if (!lsb) {
            wr(d, rz(rd), sf, rz(rm));
            return 0;
        }
        put(d, sf ? KB_MOV : KB_ZEXT, sf ? 8 : 4, T1, rz(rm), 0, 0);
        movi(d, T5, (int64_t) lsb);
        put(d, KB_SHR, 8, T1, T1, T5, 0);
        movi(d, T5, bits - (int) lsb);
        put(d, KB_SHL, 8, T2, rz(rn), T5, 0);
        put(d, KB_OR, 8, T1, T1, T2, 0);
        wr(d, rz(rd), sf, T1);
        return 0;
    }

    /* branches, exceptions, system */
    if ((i & 0x7c000000) == 0x14000000) /* b, bl */
    {
        int64_t off = sx(i & 0x3ffffff, 26) * 4;
        if (i >> 31) {
            movi(d, T1, (int64_t) (pc + 4));
            put(d, KB_MOV, 8, 30, T1, 0, 0);
        }
        blk->target = pc + (uint64_t) off;
        movi(d, T5, (int64_t) blk->target);
        put(d, KB_JMP, 8, 0, T5, 0, 0);
        return 1;
    }
    if ((i & 0xff000010) == 0x54000000) /* b.cond */
    {
        blk->target = pc + (uint64_t) (sx((i >> 5) & 0x7ffff, 19) * 4);
        put(d, KB_BR, 8, 0, 0, 0, KB_C_A64 + (int) (i & 15));
        return 1;
    }
    if ((i & 0x7e000000) == 0x34000000) /* cbz, cbnz: flags untouched */
    {
        blk->target = pc + (uint64_t) (sx((i >> 5) & 0x7ffff, 19) * 4);
        int t = rz(rd);
        if (!sf) {
            put(d, KB_ZEXT, 4, T1, t, 0, 0);
            t = T1;
        }
        put(d, KB_BRZ, 8, t, 0, 0, (i >> 24) & 1);
        return 1;
    }
    if ((i & 0x7e000000) == 0x36000000) /* tbz, tbnz */
    {
        unsigned bit = ((i >> 31) << 5) | ((i >> 19) & 31);
        blk->target = pc + (uint64_t) (sx((i >> 5) & 0x3fff, 14) * 4);
        movi(d, T5, (int64_t) bit);
        put(d, KB_SHR, 8, T1, rz(rd), T5, 0);
        movi(d, T5, 1);
        put(d, KB_AND, 8, T1, T1, T5, 0);
        put(d, KB_BRZ, 8, T1, 0, 0, (i >> 24) & 1);
        return 1;
    }
    if ((i & 0xfe1ffc1f) == 0xd61f0000) /* br, blr, ret */
    {
        unsigned opc = (i >> 21) & 3;
        put(d, KB_MOV, 8, T1, rz(rn), 0, 0);
        if (opc == 1) {
            movi(d, T2, (int64_t) (pc + 4));
            put(d, KB_MOV, 8, 30, T2, 0, 0);
        }
        put(d, KB_JMP, 8, 0, T1, 0, 0);
        return 1;
    }
    if ((i & 0xffe0001f) == 0xd4000001) /* svc */
    {
        put(d, KB_SYSCALL, 8, 0, 0, 0, 0);
        return 1;
    }
    if ((i & 0xfffff01f) == 0xd503201f)
        return 0; /* hints: nop, yield, bti, paciasp */
    if ((i & 0xfffff0ff) == 0xd503309f || (i & 0xfffff0ff) == 0xd50330bf ||
        (i & 0xfffff0ff) == 0xd50330df)
        return 0;                       /* dsb, dmb, isb */
    if ((i & 0xfffff0ff) == 0xd503305f) /* clrex */
    {
        put(d, KB_EXCL, 8, T3, 0, 0, 3);
        return 0;
    }
    if ((i & 0xffffffe0) == 0xd53bd040) /* mrs xt, tpidr_el0 */
    {
        put(d, KB_TPIDR, 8, T1, 0, 0, 0);
        wr(d, rz(rd), 1, T1);
        return 0;
    }
    if ((i & 0xffffffe0) == 0xd51bd040) /* msr tpidr_el0, xt */
    {
        put(d, KB_SETTP, 8, 0, rz(rd), 0, 0);
        return 0;
    }
    if ((i & 0xffdfffc0) == 0xd51b4400) /* mrs/msr fpcr, fpsr */
        return vec(d, i);
    if ((i & 0xffffffe0) == 0xd53b00e0 || (i & 0xffffffe0) == 0xd53b0020) {
        /* dczid_el0: dc zva prohibited, so guests zero with stores; ctr_el0:
         * 64-byte cache lines */
        movi(d, T1, (i & 0xe0) == 0xe0 ? 0x10 : 0x8444c004);
        wr(d, rz(rd), 1, T1);
        return 0;
    }
    if ((i & 0xfff8f000) == 0xd5087000 && (i & 0xffffffe0) != 0xd50b7420)
        return 0; /* cache maintenance (not dc zva): nothing to flush */
    if ((i & 0xffffffe0) == 0xd53b4200) /* mrs xt, nzcv */
    {
        put(d, KB_NZCV, 8, T1, 0, 0, 0);
        wr(d, rz(rd), 1, T1);
        return 0;
    }
    if ((i & 0xffffffe0) == 0xd51b4200) /* msr nzcv, xt */
    {
        flags(d, KB_F_NZCV, 1, T1, rz(rd), rz(rd));
        return 0;
    }

    /* loads and stores */
    if ((i & 0x3b000000) == 0x39000000) /* ldr/str unsigned offset */
    {
        unsigned size = i >> 30, opc = (i >> 22) & 3, v = (i >> 26) & 1;
        uint64_t off = ((i >> 10) & 0xfff) << vscale(i);
        movi(d, T5, (int64_t) off);
        put(d, KB_ADD, 8, TA, rs(rn), T5, 0);
        if (v) return vec(d, i);
        if (size == 3 && opc >= 2) return 0; /* prfm */
        if (size == 2 && opc == 3) goto bad;
        ldst(d, size, opc, rd);
        return 0;
    }
    if ((i & 0x3b200000) == 0x38000000) /* unscaled, pre and post index */
    {
        unsigned size = i >> 30, opc = (i >> 22) & 3, mode = (i >> 10) & 3,
                 v = (i >> 26) & 1;
        int64_t off = sx((i >> 12) & 0x1ff, 9);
        if (mode == 2) goto bad;                   /* unprivileged */
        if (!v && size == 3 && opc >= 2) return 0; /* prfum */
        movi(d, T5, mode == 1 ? 0 : off);
        put(d, KB_ADD, 8, TA, rs(rn), T5, 0);
        if (v)
            vec(d, i);
        else
            ldst(d, size, opc, rd);
        if (mode != 0) {
            movi(d, T5, off);
            put(d, KB_ADD, 8, rs(rn), rs(rn), T5, 0);
        }
        return 0;
    }
    if ((i & 0x3b200c00) == 0x38200800) /* register offset */
    {
        unsigned size = i >> 30, opc = (i >> 22) & 3, option = (i >> 13) & 7,
                 s = (i >> 12) & 1, v = (i >> 26) & 1;
        if (!v && size == 3 && opc >= 2) return 0;
        extended(d, rz(rm), option, s ? (int) vscale(i) : 0, T2);
        put(d, KB_ADD, 8, TA, rs(rn), T2, 0);
        if (v) return vec(d, i);
        ldst(d, size, opc, rd);
        return 0;
    }
    if ((i & 0x3a000000) == 0x28000000) /* ldp/stp, ldpsw */
    {
        unsigned opc = i >> 30, l = (i >> 22) & 1, mode = (i >> 23) & 3,
                 v = (i >> 26) & 1;
        int w = v ? 4 << opc : opc == 2 ? 8 : 4;
        int64_t off = sx((i >> 15) & 0x7f, 7) * w;
        unsigned rt2 = (i >> 10) & 31;
        movi(d, T5, mode == 1 ? 0 : off);
        put(d, KB_ADD, 8, TA, rs(rn), T5, 0);
        if (v)
            vec(d, i);
        else if (l) {
            put(d, opc == 1 ? KB_LDS : KB_LD, w, T1, TA, 0, 0);
            put(d, opc == 1 ? KB_LDS : KB_LD, w, T2, TA, 0, w);
            wr(d, rz(rd), 1, T1);
            wr(d, rz(rt2), 1, T2);
        }
        else {
            put(d, KB_ST, w, rz(rd), TA, 0, 0);
            put(d, KB_ST, w, rz(rt2), TA, 0, w);
        }
        if (mode == 1 || mode == 3) {
            movi(d, T5, off);
            put(d, KB_ADD, 8, rs(rn), rs(rn), T5, 0);
        }
        return 0;
    }
    if ((i & 0x3b000000) == 0x18000000) /* ldr literal */
    {
        unsigned opc = i >> 30;
        movi(
            d, TA, (int64_t) (pc + (uint64_t) (sx((i >> 5) & 0x7ffff, 19) * 4))
        );
        if ((i >> 26) & 1) return vec(d, i);
        if (opc == 3) return 0; /* prfm literal */
        put(d, opc == 2 ? KB_LDS : KB_LD,
            opc == 0   ? 4
            : opc == 1 ? 8
                       : 4,
            T1, TA, 0, 0);
        wr(d, rz(rd), 1, T1);
        return 0;
    }
    if ((i & 0x3f000000) == 0x08000000) /* exclusives, acquire/release */
    {
        unsigned size = i >> 30, l = (i >> 22) & 1, o1 = (i >> 21) & 1,
                 o2 = (i >> 23) & 1, rt2 = (i >> 10) & 31;
        int pair = !o2 && o1, w = pair ? 4 << (size & 1) : 1 << size;
        put(d, KB_MOV, 8, TA, rs(rn), 0, 0);
        if (l) {
            put(d, KB_LD, w, T1, TA, 0, 0);
            if (pair) put(d, KB_LD, w, T2, TA, 0, w);
            wr(d, rz(rd), 1, T1);
            if (pair) wr(d, rz(rt2), 1, T2);
            if (!o2) put(d, KB_EXCL, w, T3, 0, 0, 0); /* a names a scratch */
        }
        else if (o2) /* stlr */
            put(d, KB_ST, w, rz(rd), TA, 0, 0);
        else {
            put(d, KB_EXCL, w, T1, TA, rz(rd),
                pair ? 2 | (int64_t) rz(rt2) << 8 : 1);
            wr(d, rz(rm), 1, T1);
        }
        return 0;
    }

    /* data processing, register */
    if ((i & 0x1f000000) == 0x0a000000) /* logical shifted register */
    {
        unsigned opc = (i >> 29) & 3, nbit = (i >> 21) & 1,
                 type = (i >> 22) & 3, amt = (i >> 10) & 0x3f;
        int b = shifted(d, rz(rm), (int) type, (int) amt, sf, T2);
        if (nbit) {
            movi(d, T5, -1);
            put(d, KB_XOR, 8, T2, b, T5, 0);
            b = T2;
        }
        static const int ops[4] = {KB_AND, KB_OR, KB_XOR, KB_AND};
        put(d, ops[opc], 8, T3, rz(rn), b, 0);
        if (opc == 3) flags(d, KB_F_A_LOGIC, sf, T3, T3, T3);
        wr(d, rz(rd), sf, T3);
        return 0;
    }
    if ((i & 0x1f200000) == 0x0b000000) /* add/sub shifted register */
    {
        unsigned op = (i >> 30) & 1, s = (i >> 29) & 1, type = (i >> 22) & 3,
                 amt = (i >> 10) & 0x3f;
        int b = shifted(d, rz(rm), (int) type, (int) amt, sf, T2);
        put(d, op ? KB_SUB : KB_ADD, 8, T3, rz(rn), b, 0);
        if (s) flags(d, op ? KB_F_A_SUB : KB_F_A_ADD, sf, T3, rz(rn), b);
        wr(d, rz(rd), sf, T3);
        return 0;
    }
    if ((i & 0x1f200000) == 0x0b200000) /* add/sub extended register */
    {
        unsigned op = (i >> 30) & 1, s = (i >> 29) & 1, option = (i >> 13) & 7,
                 sh = (i >> 10) & 7;
        int b = extended(d, rz(rm), (int) option, (int) sh, T2);
        put(d, op ? KB_SUB : KB_ADD, 8, T3, rs(rn), b, 0);
        if (s) flags(d, op ? KB_F_A_SUB : KB_F_A_ADD, sf, T3, rs(rn), b);
        wr(d, s ? rz(rd) : rs(rd), sf, T3);
        return 0;
    }
    if ((i & 0x1fe0fc00) == 0x1a000000) /* adc adcs sbc sbcs */
    {
        unsigned op = (i >> 30) & 1, s = (i >> 29) & 1;
        int b = rz(rm);
        if (op) { /* sbc is add with carry of the complement */
            movi(d, T5, -1);
            put(d, KB_XOR, 8, T2, b, T5, 0);
            b = T2;
        }
        put(d, KB_CARRY, 8, T1, 0, 0, 0);
        put(d, KB_ADD, 8, T3, rz(rn), b, 0);
        put(d, KB_ADD, 8, T3, T3, T1, 0);
        if (s) flags(d, KB_F_ADC, sf, T3, rz(rn), b);
        wr(d, rz(rd), sf, T3);
        return 0;
    }
    if ((i & 0x1fe00000) == 0x1a400000) /* ccmp, ccmn */
    {
        unsigned op = (i >> 30) & 1, cond = (i >> 12) & 15, nzcv = i & 15;
        int b = rz(rm);
        if ((i >> 11) & 1) {
            movi(d, T2, (int64_t) rm);
            b = T2;
        }
        /* op 1 is ccmp (a subtract), 0 ccmn */
        put(d, KB_CCMP, sf ? 8 : 4, rz(rn), b, 0,
            (int64_t) (cond | (nzcv << 4) | ((op ^ 1) << 8)));
        return 0;
    }
    if ((i & 0x1fe00000) == 0x1a800000) /* csel csinc csinv csneg */
    {
        unsigned op = (i >> 30) & 1, o2 = (i >> 10) & 1, cond = (i >> 12) & 15;
        int b = rz(rm);
        if (op || o2) {
            if (!op && o2) {
                movi(d, T5, 1);
                put(d, KB_ADD, 8, T2, b, T5, 0);
            }
            else if (op && !o2) {
                movi(d, T5, -1);
                put(d, KB_XOR, 8, T2, b, T5, 0);
            }
            else
                put(d, KB_SUB, 8, T2, KB_ZERO, b, 0);
            b = T2;
        }
        put(d, KB_SEL, 8, T3, rz(rn), b, KB_C_A64 + (int) cond);
        wr(d, rz(rd), sf, T3);
        return 0;
    }
    if ((i & 0x5fe00000) ==
        0x1ac00000) /* 2-source: udiv sdiv lslv lsrv asrv rorv */
    {
        unsigned op = (i >> 10) & 0x3f;
        int a = rz(rn), b = rz(rm);
        if ((op & 0x38) == 0x10) /* crc32 and crc32c of 1, 2, 4 or 8 bytes */
        {
            put(d, KB_CRC32, 1 << (op & 3), T3, a, b, (op >> 2) & 1);
            wr(d, rz(rd), 0, T3);
            return 0;
        }
        if (!sf) {
            put(d, (op == 3 || op == 10) ? KB_SEXT : KB_ZEXT, 4, T1, a, 0, 0);
            put(d, op == 3 ? KB_SEXT : KB_ZEXT, 4, T2, b, 0, 0);
            a = T1;
            b = T2;
        }
        switch (op) {
            case 2: put(d, KB_UDIV, 8, T3, a, b, 0); break;
            case 3: put(d, KB_SDIV, 8, T3, a, b, 0); break;
            case 8:
            case 9:
            case 10:
            case 11:
                movi(d, T5, sf ? 63 : 31);
                put(d, KB_AND, 8, T2, b, T5, 0);
                {
                    static const int ops[4] = {KB_SHL, KB_SHR, KB_SAR, KB_ROR};
                    put(d, ops[op - 8], sf ? 8 : 4, T3, a, T2, 0);
                }
                break;
            default: goto bad;
        }
        wr(d, rz(rd), sf, T3);
        return 0;
    }
    if ((i & 0x5fe00000) ==
        0x5ac00000) /* 1-source: rbit rev16 rev32 rev clz cls */
    {
        unsigned op = (i >> 10) & 0x3f;
        int a = rz(rn);
        switch (op) {
            case 0: /* rbit: bits swapped in pairs, nibble halves, nibbles, then
                       the bytes reversed */
            {
                static const uint64_t m[3] = {
                    0x5555555555555555ull, 0x3333333333333333ull,
                    0x0f0f0f0f0f0f0f0full
                };
                put(d, KB_MOV, 8, T3, a, 0, 0);
                for (int k = 0; k < 3; k++) {
                    movi(d, T5, 1 << k);
                    put(d, KB_SHR, 8, T1, T3, T5, 0);
                    put(d, KB_SHL, 8, T2, T3, T5, 0);
                    movi(d, T4, (int64_t) m[k]);
                    put(d, KB_AND, 8, T1, T1, T4, 0);
                    movi(d, T4, (int64_t) ~m[k]);
                    put(d, KB_AND, 8, T2, T2, T4, 0);
                    put(d, KB_OR, 8, T3, T1, T2, 0);
                }
                put(d, KB_BSWAP, sf ? 8 : 4, T3, T3, 0, 0);
                break;
            }
            case 1: /* rev16: the bytes of each halfword swapped */
                movi(d, T5, 8);
                put(d, KB_SHR, 8, T1, a, T5, 0);
                put(d, KB_SHL, 8, T2, a, T5, 0);
                movi(d, T4, 0x00ff00ff00ff00ffll);
                put(d, KB_AND, 8, T1, T1, T4, 0);
                movi(d, T4, (int64_t) 0xff00ff00ff00ff00ull);
                put(d, KB_AND, 8, T2, T2, T4, 0);
                put(d, KB_OR, 8, T3, T1, T2, 0);
                break;
            case 5: /* cls: leading zeros of x ^ (x >> 1, arithmetic), less 1 */
                put(d, sf ? KB_MOV : KB_SEXT, sf ? 8 : 4, T1, a, 0, 0);
                movi(d, T5, 1);
                put(d, KB_SAR, 8, T2, T1, T5, 0);
                put(d, KB_XOR, 8, T1, T1, T2, 0);
                put(d, KB_CLZ, sf ? 8 : 4, T3, T1, 0, 0);
                put(d, KB_SUB, 8, T3, T3, T5, 0);
                break;
            case 4: put(d, KB_CLZ, sf ? 8 : 4, T3, a, 0, 0); break;
            case 2:
            case 3:
                if (op == 3 || !sf)
                    put(d, KB_BSWAP, sf ? 8 : 4, T3, a, 0, 0);
                else {
                    /* rev32 on 64 bits: each word reversed */
                    put(d, KB_BSWAP, 8, T3, a, 0, 0);
                    movi(d, T5, 32);
                    put(d, KB_ROR, 8, T3, T3, T5, 0);
                }
                break;
            default: goto bad;
        }
        wr(d, rz(rd), sf, T3);
        return 0;
    }
    if ((i & 0x1f000000) ==
        0x1b000000) /* 3-source: madd msub smaddl umaddl smulh umulh */
    {
        unsigned op31 = (i >> 21) & 7, o0 = (i >> 15) & 1, ra = (i >> 10) & 31;
        int a = rz(rn), b = rz(rm);
        if (op31 == 0) {
            put(d, KB_MUL, 8, T3, a, b, 0);
            put(d, o0 ? KB_SUB : KB_ADD, 8, T3, rz(ra), T3, 0);
            wr(d, rz(rd), sf, T3);
            return 0;
        }
        if (op31 == 1 || op31 == 5) /* smaddl/umaddl (smull, umull) */
        {
            put(d, op31 == 1 ? KB_SEXT : KB_ZEXT, 4, T1, a, 0, 0);
            put(d, op31 == 1 ? KB_SEXT : KB_ZEXT, 4, T2, b, 0, 0);
            put(d, KB_MUL, 8, T3, T1, T2, 0);
            put(d, o0 ? KB_SUB : KB_ADD, 8, T3, rz(ra), T3, 0);
            wr(d, rz(rd), 1, T3);
            return 0;
        }
        if (op31 == 2 || op31 == 6) {
            put(d, op31 == 2 ? KB_SMULH : KB_UMULH, 8, T3, a, b, 0);
            wr(d, rz(rd), 1, T3);
            return 0;
        }
        goto bad;
    }
bad:
    put(d, KB_TRAP, 4, 0, 0, 0, (int64_t) i);
    return 1;
}

int kb_a64_block(struct kb_cpu* cpu, struct kb_block* b) {
    struct kb_emit e = {0};
    struct dec d = {.cpu = cpu, .e = &e, .pc = b->pc};
    struct kb_fuse f = {
        .cpu = cpu, .trace = cpu->tracing, .head = b->pc, .lo = {b->pc}
    };
    int end = 0, cap = f.trace ? 1024 : 64;
    for (int n = 0; n < cap && !end; n++) {
        end = one(&d, b);
        if (end < 0) return -1;
        if (end && n < cap - 1 && kb_fuse(&e, b, &f, d.pc, &d.pc)) end = 0;
    }
    kb_fuse_done(b, &f, d.pc);
    b->next = d.pc;
    if (!end) b->target = d.pc;
    b->ins = e.ins;
    b->n = e.n;
    return 0;
}
