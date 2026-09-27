#ifndef AOT_H
#define AOT_H

#include <stdint.h>
#include <string.h>

#include "kb.h"

/* the interpreter's flags, conditions and x86 mul/div (src/gmux/katybug/run.c)
   over locals instead of the cpu, so lifted code keeps them in registers; keep
   in step with run.c. Always inlined: the kind is a constant only after
   inlining, and a call spills the flags to memory (measured: 13-17% of the
   lifted runs when clang declined) */

struct aot_fl {
    int n, z, c, v, p;
};

static inline uint64_t aot_mask(int w) {
    return w >= 8 ? ~0ull : (1ull << (8 * w)) - 1;
}

static inline int64_t aot_sext(uint64_t v, int w) {
    int s = 64 - 8 * w;
    return w >= 8 ? (int64_t) v : (int64_t) (v << s) >> s;
}

static inline int aot_parity(uint64_t v) {
    v &= 0xff;
    v ^= v >> 4;
    v ^= v >> 2;
    v ^= v >> 1;
    return !(v & 1);
}

static inline __attribute__((always_inline)) void aot_flags(
    struct aot_fl* f, int kind, uint64_t a, uint64_t b, uint64_t r, int w
) {
    uint64_t m = aot_mask(w), sign = 1ull << (8 * w - 1);
    if ((kind == KB_F_SHL || kind == KB_F_SHR || kind == KB_F_SAR ||
         kind == KB_F_ROL || kind == KB_F_ROR) &&
        b == 0)
        return;
    switch (kind) {
        case KB_F_MULOV: f->c = f->v = b != 0; return;
        case KB_F_SETC: f->c = (int) (b & 1); return;
        case KB_F_ZERO: f->z = (b & m) == 0; return;
        case KB_F_CNT:
            f->c = (b & m) == 0;
            f->z = (r & m) == 0;
            return;
        case KB_F_ROL:
            f->c = (int) (r & 1);
            f->v = !!(r & sign) ^ f->c;
            return;
        case KB_F_ROR:
            f->c = !!(r & sign);
            f->v = !!(r & sign) ^ !!(r & (sign >> 1));
            return;
    }
    a &= m;
    b &= m;
    r &= m;
    f->z = r == 0;
    f->n = !!(r & sign);
    f->p = aot_parity(r);
    switch (kind) {
        case KB_F_ADD:
        case KB_F_A_ADD:
            f->c = r < a;
            f->v = !!(~(a ^ b) & (a ^ r) & sign);
            break;
        case KB_F_ADC: {
            uint64_t cin = (uint64_t) f->c;
            f->c = w < 8 ? a + b + cin > m : (cin ? r <= a : r < a);
            f->v = !!(~(a ^ b) & (a ^ r) & sign);
            break;
        }
        case KB_F_SUB:
            f->c = a < b;
            f->v = !!((a ^ b) & (a ^ r) & sign);
            break;
        case KB_F_SBB: {
            uint64_t cin = (uint64_t) f->c;
            f->c = w < 8 ? a < b + cin : (a < b || (cin && a == b));
            f->v = !!((a ^ b) & (a ^ r) & sign);
            break;
        }
        case KB_F_A_SUB:
            f->c = a >= b;
            f->v = !!((a ^ b) & (a ^ r) & sign);
            break;
        case KB_F_LOGIC:
        case KB_F_A_LOGIC:
            f->c = 0;
            f->v = 0;
            break;
        case KB_F_INC: f->v = r == sign; break;
        case KB_F_DEC: f->v = r == sign - 1; break;
        case KB_F_NEG:
            f->c = b != 0;
            f->v = b == sign;
            break;
        case KB_F_SHL:
            f->c = b <= 8u * (unsigned) w ? !!((a << (b - 1)) & sign) : 0;
            f->v = f->n ^ f->c;
            break;
        case KB_F_SHR:
            f->c = !!((a >> (b - 1)) & 1);
            f->v = !!(a & sign);
            break;
        case KB_F_SAR:
            f->c = !!(((uint64_t) aot_sext(a, w) >> (b - 1)) & 1);
            f->v = 0;
            break;
        case KB_F_NZCV:
            f->n = !!(b & (1u << 31));
            f->z = !!(b & (1u << 30));
            f->c = !!(b & (1u << 29));
            f->v = !!(b & (1u << 28));
            break;
    }
}

static inline __attribute__((always_inline)) int aot_cond(
    const struct aot_fl* f, int cond
) {
    int n = f->n, z = f->z, c = f->c, v = f->v;
    if (cond < KB_C_A64) {
        int r;
        switch (cond >> 1) {
            case 0: r = v; break;
            case 1: r = c; break;
            case 2: r = z; break;
            case 3: r = c || z; break;
            case 4: r = n; break;
            case 5: r = f->p; break;
            case 6: r = n != v; break;
            default: r = z || n != v; break;
        }
        return (cond & 1) ? !r : r;
    }
    int k = cond - KB_C_A64, r;
    if (k >= 14) return 1;
    switch (k >> 1) {
        case 0: r = z; break;
        case 1: r = c; break;
        case 2: r = n; break;
        case 3: r = v; break;
        case 4: r = c && !z; break;
        case 5: r = n == v; break;
        default: r = !z && n == v; break;
    }
    return (k & 1) ? !r : r;
}

/* x86 mul, imul, div and idiv of rdx:rax by v; 1 on a divide error, leaving
 * both untouched */
static inline __attribute__((always_inline)) int aot_muldiv(
    uint64_t* rax, uint64_t* rdx, struct aot_fl* f, int kind, int w, uint64_t v
) {
    int bits = 8 * w;
    uint64_t m = aot_mask(w);
    if (kind == 4 || kind == 5) {
        unsigned __int128 p;
        int ov;
        if (kind == 4) {
            p = (unsigned __int128) (*rax & m) * (v & m);
            ov = (p >> bits) != 0;
        }
        else {
            __int128 q = (__int128) aot_sext(*rax, w) * aot_sext(v, w);
            p = (unsigned __int128) q;
            ov = q != (__int128) aot_sext((uint64_t) q, w);
        }
        uint64_t lo = (uint64_t) p & m, hi = (uint64_t) (p >> bits) & m;
        if (w == 1)
            *rax = (*rax & ~0xffffull) | ((hi << 8) | lo);
        else if (w == 2) {
            *rax = (*rax & ~0xffffull) | lo;
            *rdx = (*rdx & ~0xffffull) | hi;
        }
        else {
            *rax = lo;
            *rdx = hi;
        }
        f->c = f->v = ov;
        return 0;
    }
    if ((v & m) == 0) return 1;
    unsigned __int128 n;
    if (w == 1)
        n = *rax & 0xffff;
    else
        n = ((unsigned __int128) (*rdx & m) << bits) | (*rax & m);
    uint64_t q, rem;
    if (kind == 6) {
        unsigned __int128 qq = n / (v & m);
        if (qq > m) return 1;
        q = (uint64_t) qq;
        rem = (uint64_t) (n % (v & m));
    }
    else {
        __int128 sn =
            w == 1 ? (__int128) (int16_t) n
                   : (__int128) (n << (128 - 2 * bits)) >> (128 - 2 * bits);
        __int128 d = aot_sext(v, w), qq = sn / d;
        if (qq != (__int128) aot_sext((uint64_t) qq, w)) return 1;
        q = (uint64_t) qq & m;
        rem = (uint64_t) (sn % d) & m;
    }
    if (w == 1)
        *rax = (*rax & ~0xffffull) | (rem << 8) | q;
    else if (w == 2) {
        *rax = (*rax & ~0xffffull) | q;
        *rdx = (*rdx & ~0xffffull) | rem;
    }
    else {
        *rax = q;
        *rdx = rem;
    }
    return 0;
}

/* attribution arms, unsafe outside a measurement: -DAOT_NO_SIGNAL_CHECK moves
   between lifted blocks without looking for a pending signal (the verification
   check stays: an unmatched block has no IR to run), -DAOT_NO_RANGE_CHECK
   trusts a load or store's cached mapping whenever its generation holds */
#ifdef AOT_NO_SIGNAL_CHECK
    #define AOT_CONTINUE(ok) (ok)
#else
    #define AOT_CONTINUE(ok) (!*kb_pending_flag && (ok))
#endif
#ifdef AOT_NO_RANGE_CHECK
    #define AOT_SLOW(q, gen, va, w) ((q)->gen != (gen))
#else
    #define AOT_SLOW(q, gen, va, w)                                            \
        ((q)->gen != (gen) || (va) - (q)->lo > (q)->span - (w))
#endif

struct aot_entry {
    uint64_t pc, next, target;
    int n, region, idx;
    const struct kb_ins* ins;
};

#endif
