#include <math.h>
#include <string.h>

#include "kb.h"

/* AArch64 floating point and Advanced SIMD, one instruction word at a time:
 * a64.c emits KB_A64V with the word in imm and, for a load or store, the
 * address it computed in register b. Floating point is done in software after
 * the ARM ARM's FPUnpack, FPRound and FPProcessNaNs, on exact integer
 * significands: FPCR's rounding mode, FZ and DN, FPSR's cumulative exception
 * bits and NaN propagation come out the same on an x86, arm64 or wasm host.
 * Exception traps (FPCR bits 8-15) and FPCR.AHP are not modelled.
 */

typedef unsigned __int128 u128;

static uint64_t* vr(struct kb_cpu* cpu, unsigned n) {
    return cpu->x[n & 31];
}
static uint64_t xr(struct kb_cpu* cpu, unsigned n) {
    return (n & 31) == 31 ? 0 : cpu->r[n & 31];
}
static void set_x(struct kb_cpu* cpu, unsigned n, uint64_t v, int sf) {
    if ((n & 31) != 31) cpu->r[n & 31] = sf ? v : (uint32_t) v;
}
/* a scalar write clears the rest of the vector register */
static void set_v(struct kb_cpu* cpu, unsigned n, uint64_t lo, uint64_t hi) {
    vr(cpu, n)[0] = lo;
    vr(cpu, n)[1] = hi;
}
static uint64_t lane(const uint64_t* v, int bytes, int i) {
    uint64_t r = 0;
    memcpy(&r, (const uint8_t*) v + i * bytes, (size_t) bytes);
    return r;
}
static void set_lane(uint64_t* v, int bytes, int i, uint64_t x) {
    memcpy((uint8_t*) v + i * bytes, &x, (size_t) bytes);
}
static uint64_t mask_of(int bytes) {
    return bytes >= 8 ? ~0ull : (1ull << (8 * bytes)) - 1;
}
static int64_t sext_of(uint64_t v, int bytes) {
    int s = 64 - 8 * bytes;
    return (int64_t) (v << s) >> s;
}

/* #region floating point, in software (n is the width: 16, 32 or 64) */
enum
{
    IOC = 1,
    DZC = 2,
    OFC = 4,
    UFC = 8,
    IXC = 16,
    IDC = 128
};
#define FPSR_QC (1u << 27)
#define FPCR_FZ (1u << 24)
#define FPCR_DN (1u << 25)
/* FPCR's four rounding modes, then ties away and odd */
enum
{
    RN,
    RP,
    RM,
    RZ,
    RA,
    RO
};
enum
{
    T_ZERO,
    T_NUM,
    T_INF,
    T_QNAN,
    T_SNAN
};
/* unpacked: (-1)^s * m * 2^e when a number */
struct fpv {
    int t, s, e;
    uint64_t m;
};

static int frac_bits(int n) {
    return n == 64 ? 52 : n == 32 ? 23 : 10;
}
static int exp_bits(int n) {
    return n == 64 ? 11 : n == 32 ? 8 : 5;
}
static uint64_t nmask(int n) {
    return n >= 64 ? ~0ull : (1ull << n) - 1;
}
static int fmode(struct kb_cpu* cpu) {
    return (int) (cpu->fpcr >> 22) & 3;
}
static uint64_t fzero(int s, int n) {
    return (uint64_t) s << (n - 1);
}
static uint64_t finf(int s, int n) {
    return fzero(s, n) | nmask(exp_bits(n)) << frac_bits(n);
}
static uint64_t dnan(int n) {
    return finf(0, n) | 1ull << (frac_bits(n) - 1);
}

/* FPUnpack: under FZ a denormal (not a half) is zero, with IDC */
static struct fpv unpack(struct kb_cpu* cpu, uint64_t b, int n) {
    int f = frac_bits(n), eb = exp_bits(n), bias = (1 << (eb - 1)) - 1;
    int x = (int) (b >> f) & ((1 << eb) - 1);
    struct fpv v = {T_NUM, (int) (b >> (n - 1)) & 1, 0, b & ((1ull << f) - 1)};
    if (x == (1 << eb) - 1)
        v.t = !v.m ? T_INF : (v.m >> (f - 1)) & 1 ? T_QNAN : T_SNAN;
    else if (x)
        v.m |= 1ull << f, v.e = x - bias - f;
    else if (!v.m)
        v.t = T_ZERO;
    else if (n != 16 && (cpu->fpcr & FPCR_FZ))
        v.t = T_ZERO, v.m = 0, cpu->fpsr |= IDC;
    else
        v.e = 1 - bias - f;
    return v;
}
static double fval(const struct fpv* v) {
    double x = v->t == T_INF   ? INFINITY
               : v->t == T_NUM ? ldexp((double) v->m, v->e)
                               : 0;
    return v->s ? -x : x;
}

static int bitlen(u128 m) {
    uint64_t hi = (uint64_t) (m >> 64), lo = (uint64_t) m;
    return hi ? 128 - __builtin_clzll(hi) : lo ? 64 - __builtin_clzll(lo) : 0;
}
static u128 shr(u128 m, int sh) {
    return sh <= 0 ? m << -sh : sh >= 128 ? 0 : m >> sh;
}
/* the bits shifting sh places out of m, with a sticky fraction below them,
 * against half a unit: 0 none, 1 below half, 2 half, 3 above */
static int rest(u128 m, int sh, int sticky) {
    if (sh <= 0) return sticky;
    if (sh > 128) return m || sticky;
    u128 r = sh == 128 ? m : m & (((u128) 1 << sh) - 1),
         h = (u128) 1 << (sh - 1);
    return r > h ? 3 : r == h ? (sticky ? 3 : 2) : r || sticky ? 1 : 0;
}
static int round_up(int mode, int rest, int odd, int s) {
    switch (mode) {
        case RN: return rest == 3 || (rest == 2 && odd);
        case RP: return rest && !s;
        case RM: return rest && s;
        case RA: return rest >= 2;
    }
    return 0;
}

/* FPRound of (-1)^s * (m + a fraction when sticky) * 2^e, m nonzero; tiny is
 * judged before rounding, and FZ flushes a tiny result (not a half) */
static uint64_t fround(
    struct kb_cpu* cpu, int s, u128 m, int e, int sticky, int n, int mode
) {
    int f = frac_bits(n), eb = exp_bits(n), minexp = 2 - (1 << (eb - 1));
    int exp = e + bitlen(m) - 1;
    if (n != 16 && (cpu->fpcr & FPCR_FZ) && exp < minexp) {
        cpu->fpsr |= UFC;
        return fzero(s, n);
    }
    int biased = exp < minexp ? 0 : exp - minexp + 1;
    int sh = (biased ? exp : minexp) - f - e, r = rest(m, sh, sticky);
    uint64_t mant = (uint64_t) shr(m, sh);
    if (!biased && r) cpu->fpsr |= UFC;
    if (round_up(mode, r, (int) mant & 1, s)) {
        mant++;
        if (mant == 1ull << f) biased = 1;
        if (mant == 1ull << (f + 1)) biased++, mant >>= 1;
    }
    if (r && mode == RO) mant |= 1;
    if (biased >= (1 << eb) - 1) {
        cpu->fpsr |= OFC | IXC;
        int inf = mode == RN || (mode == RP && !s) || (mode == RM && s);
        return inf ? finf(s, n) : finf(s, n) - 1;
    }
    if (r) cpu->fpsr |= IXC;
    return fzero(s, n) | (uint64_t) biased << f | (mant & ((1ull << f) - 1));
}

/* FPProcessNaN: quieted, or the default NaN under DN */
static uint64_t pnan(
    struct kb_cpu* cpu, const struct fpv* v, uint64_t b, int n
) {
    if (v->t == T_SNAN) cpu->fpsr |= IOC;
    if (cpu->fpcr & FPCR_DN) return dnan(n);
    return (b | 1ull << (frac_bits(n) - 1)) & nmask(n);
}
/* FPProcessNaNs: the first signalling NaN, else the first quiet one */
static int pnans(
    struct kb_cpu* cpu, const struct fpv* v, const uint64_t* b, int k, int n,
    uint64_t* out
) {
    for (int t = T_SNAN; t >= T_QNAN; t--)
        for (int j = 0; j < k; j++)
            if (v[j].t == t) return *out = pnan(cpu, &v[j], b[j], n), 1;
    return 0;
}

/* (-1)^s1 m1 2^e1 + (-1)^s2 m2 2^e2, both m nonzero and below 2^106: the
 * magnitude m * 2^e with a sticky fraction below m; 0 when exactly zero */
static int fsum(
    int s1, u128 m1, int e1, int s2, u128 m2, int e2, int* s, u128* m, int* e,
    int* sticky
) {
    if (e2 + bitlen(m2) > e1 + bitlen(m1)) {
        int ts = s1, te = e1;
        u128 tm = m1;
        s1 = s2, m1 = m2, e1 = e2, s2 = ts, m2 = tm, e2 = te;
    }
    /* the larger ends at bit 125; the other may lose bits below bit 0 */
    int e0 = e1 + bitlen(m1) - 126, sh = e0 - e2;
    u128 a = m1 << (e1 - e0), b = shr(m2, sh);
    int lost = sh > 0 && rest(m2, sh, 0);
    *e = e0;
    *sticky = lost;
    if (s1 == s2)
        *m = a + b, *s = s1;
    else if (a > b)
        *m = a - b - (u128) lost, *s = s1;
    else if (b > a)
        *m = b - a, *s = s2;
    else
        return 0;
    return 1;
}

enum
{
    F_ADD,
    F_SUB,
    F_MUL,
    F_DIV,
    F_MAX,
    F_MIN,
    F_MAXNM,
    F_MINNM,
    F_MULX,
    F_ABD
};
/* significand and exponent of a finite nonzero number, denormals included */
static uint64_t sig_of(uint64_t b, int n, int* e) {
    int f = frac_bits(n), x = (int) (b >> f) & ((1 << exp_bits(n)) - 1);
    *e = (x ? x : 1) - (1 << (exp_bits(n) - 1)) + 1 - f;
    return (b & ((1ull << f) - 1)) | (x ? 1ull << f : 0);
}
static int ctz128(u128 m) {
    uint64_t lo = (uint64_t) m;
    return lo ? __builtin_ctzll(lo)
              : 64 + __builtin_ctzll((uint64_t) (m >> 64));
}
/* add, sub, mul and div on the host when FPCR is all defaults and both
 * operands are finite: a result above the smallest binade was never tiny,
 * so only IXC is left, from TwoSum or the exact integer product */
static int fast2(
    struct kb_cpu* cpu, int op, uint64_t a, uint64_t b, int n, uint64_t* out
) {
    int f = frac_bits(n), top = (1 << exp_bits(n)) - 1, ea, eb, er, inexact;
    if ((cpu->fpcr & 0x03c00000) || (int) ((a >> f) & top) == top ||
        (int) ((b >> f) & top) == top)
        return 0;
    uint64_t r;
    if (n == 64) {
        double x, y, z;
        memcpy(&x, &a, 8);
        memcpy(&y, &b, 8);
        if (op == F_SUB) y = -y;
        z = op == F_MUL ? x * y : op == F_DIV ? x / y : x + y;
        memcpy(&r, &z, 8);
        if (op <= F_SUB) {
            double bp = z - x, ap = z - bp;
            inexact = (x - ap) + (y - bp) != 0;
        }
        else
            inexact = -1;
    }
    else {
        float x, y, z;
        uint32_t w = (uint32_t) a, v = (uint32_t) b, rw;
        memcpy(&x, &w, 4);
        memcpy(&y, &v, 4);
        if (op == F_SUB) y = -y;
        z = op == F_MUL ? x * y : op == F_DIV ? x / y : x + y;
        memcpy(&rw, &z, 4);
        r = rw;
        if (op <= F_SUB) {
            float bp = z - x, ap = z - bp;
            inexact = (x - ap) + (y - bp) != 0;
        }
        else
            inexact = -1;
    }
    /* not the top binade either, where TwoSum's own steps could overflow */
    int x = (int) (r >> f) & top;
    if (x < 2 || x >= top - 1) return 0;
    if (inexact < 0) { /* mul: the product fits; div: quotient times b is a */
        uint64_t ma = sig_of(a, n, &ea), mb = sig_of(b, n, &eb),
                 mr = sig_of(r, n, &er);
        /* odd parts of p and q multiply to one of p + q - 1 or p + q bits */
        int sa = bitlen(ma) - __builtin_ctzll(ma),
            sb = bitlen(mb) - __builtin_ctzll(mb),
            sr = bitlen(mr) - __builtin_ctzll(mr);
        if (op == F_MUL && sa + sb != f + 2)
            inexact = sa + sb > f + 2;
        else if (op == F_DIV && sr + sb - 1 > sa)
            inexact = 1;
        else if (op == F_MUL) {
            u128 p = (u128) ma * mb;
            inexact = bitlen(p) - ctz128(p) > f + 1;
        }
        else {
            u128 p = (u128) mr * mb;
            int d = ea - er - eb;
            inexact = d >= 0 ? d >= 64 || p != (u128) ma << d
                             : bitlen(p) - d > 64 || p << -d != ma;
        }
    }
    if (inexact) cpu->fpsr |= IXC;
    *out = r;
    return 1;
}
static uint64_t fop2(
    struct kb_cpu* cpu, int op, uint64_t a, uint64_t b, int n
) {
    a &= nmask(n);
    b &= nmask(n);
    uint64_t r;
    if (op <= F_DIV && n != 16 && fast2(cpu, op, a, b, n, &r)) return r;
    if (op == F_ABD) return fop2(cpu, F_SUB, a, b, n) & (nmask(n) >> 1);
    if (op == F_MAXNM || op == F_MINNM) {
        /* a single quiet NaN loses to the other operand */
        int qa = unpack(cpu, a, n).t == T_QNAN,
            qb = unpack(cpu, b, n).t == T_QNAN;
        if (qa && !qb) a = finf(op == F_MAXNM, n);
        if (qb && !qa) b = finf(op == F_MAXNM, n);
        op = op == F_MAXNM ? F_MAX : F_MIN;
    }
    struct fpv v[2] = {unpack(cpu, a, n), unpack(cpu, b, n)};
    uint64_t ops[2] = {a, b};
    if (pnans(cpu, v, ops, 2, n, &r)) return r;
    struct fpv *x = &v[0], *y = &v[1];
    if (op == F_SUB) y->s ^= 1, op = F_ADD;
    int s = x->s ^ y->s, mode = fmode(cpu), rs, re, st;
    u128 rm;
    switch (op) {
        case F_MAX:
        case F_MIN: {
            double p = fval(x), q = fval(y);
            struct fpv* w = (op == F_MAX ? p > q : p < q) ? x : y;
            if (w->t == T_ZERO)
                return fzero(op == F_MAX ? x->s & y->s : x->s | y->s, n);
            return w == x ? a : b;
        }
        case F_ADD:
            if (x->t == T_INF && y->t == T_INF && x->s != y->s) break;
            if (x->t == T_INF || y->t == T_INF)
                return finf(x->t == T_INF ? x->s : y->s, n);
            if (x->t == T_ZERO && y->t == T_ZERO)
                return fzero(x->s == y->s ? x->s : mode == RM, n);
            if (x->t == T_ZERO)
                return fround(cpu, y->s, y->m, y->e, 0, n, mode);
            if (y->t == T_ZERO)
                return fround(cpu, x->s, x->m, x->e, 0, n, mode);
            if (!fsum(x->s, x->m, x->e, y->s, y->m, y->e, &rs, &rm, &re, &st))
                return fzero(mode == RM, n);
            return fround(cpu, rs, rm, re, st, n, mode);
        case F_MUL:
        case F_MULX:
            if ((x->t == T_INF && y->t == T_ZERO) ||
                (x->t == T_ZERO && y->t == T_INF)) {
                if (op == F_MULX) /* two */
                    return fzero(s, n) | (uint64_t) 1 << (exp_bits(n) - 1)
                                                      << frac_bits(n);
                break;
            }
            if (x->t == T_INF || y->t == T_INF) return finf(s, n);
            if (x->t == T_ZERO || y->t == T_ZERO) return fzero(s, n);
            return fround(cpu, s, (u128) x->m * y->m, x->e + y->e, 0, n, mode);
        case F_DIV: {
            if (x->t == y->t && (x->t == T_INF || x->t == T_ZERO)) break;
            if (x->t == T_INF || y->t == T_ZERO) {
                if (x->t != T_INF) cpu->fpsr |= DZC;
                return finf(s, n);
            }
            if (x->t == T_ZERO || y->t == T_INF) return fzero(s, n);
            /* a quotient of at least 64 bits, the remainder as sticky */
            int k = 64 + bitlen(y->m) - bitlen(x->m);
            u128 num = (u128) x->m << k;
            return fround(
                cpu, s, num / y->m, x->e - k - y->e, num % y->m != 0, n, mode
            );
        }
    }
    cpu->fpsr |= IOC;
    return dnan(n);
}
/* FPMulAdd: c + a * b, rounded once */
static uint64_t ffma(
    struct kb_cpu* cpu, uint64_t c, uint64_t a, uint64_t b, int n
) {
    uint64_t ops[3] = {c & nmask(n), a & nmask(n), b & nmask(n)}, r;
    struct fpv v[3] = {
        unpack(cpu, ops[0], n), unpack(cpu, ops[1], n), unpack(cpu, ops[2], n)
    };
    struct fpv *z = &v[0], *x = &v[1], *y = &v[2];
    int iz =
        (x->t == T_INF && y->t == T_ZERO) || (x->t == T_ZERO && y->t == T_INF);
    int nan = pnans(cpu, v, ops, 3, n, &r);
    if (z->t == T_QNAN && iz) {
        cpu->fpsr |= IOC;
        return dnan(n);
    }
    if (nan) return r;
    int sp = x->s ^ y->s, ip = x->t == T_INF || y->t == T_INF,
        zp = x->t == T_ZERO || y->t == T_ZERO, mode = fmode(cpu), rs, re, st;
    if (iz || (z->t == T_INF && ip && z->s != sp)) {
        cpu->fpsr |= IOC;
        return dnan(n);
    }
    if (z->t == T_INF || ip) return finf(z->t == T_INF ? z->s : sp, n);
    if (zp) {
        if (z->t == T_ZERO) return fzero(z->s == sp ? z->s : mode == RM, n);
        return fround(cpu, z->s, z->m, z->e, 0, n, mode);
    }
    u128 pm = (u128) x->m * y->m, rm;
    int pe = x->e + y->e;
    if (z->t == T_ZERO) return fround(cpu, sp, pm, pe, 0, n, mode);
    if (!fsum(z->s, z->m, z->e, sp, pm, pe, &rs, &rm, &re, &st))
        return fzero(mode == RM, n);
    return fround(cpu, rs, rm, re, st, n, mode);
}
static uint64_t fsqrt(struct kb_cpu* cpu, uint64_t a, int n) {
    a &= nmask(n);
    struct fpv v = unpack(cpu, a, n);
    uint64_t r;
    if (pnans(cpu, &v, &a, 1, n, &r)) return r;
    if (v.t == T_ZERO) return fzero(v.s, n);
    if (v.s) {
        cpu->fpsr |= IOC;
        return dnan(n);
    }
    if (v.t == T_INF) return a;
    /* an even exponent and about 120 bits, then a 60-bit root digit by digit */
    u128 m = v.m, q = 0, bit = (u128) 1 << 126;
    int e = v.e;
    if (e & 1) m <<= 1, e--;
    int k = (120 - bitlen(m)) & ~1;
    m <<= k;
    while (bit > m) bit >>= 2;
    for (; bit; bit >>= 2)
        if (m >= q + bit)
            m -= q + bit, q = (q >> 1) + bit;
        else
            q >>= 1;
    return fround(cpu, 0, q, (e - k) / 2, m != 0, n, fmode(cpu));
}
/* FPConvert between widths; a NaN keeps its sign and the top of its payload */
static uint64_t fcvt(
    struct kb_cpu* cpu, uint64_t a, int from, int to, int mode
) {
    struct fpv v = unpack(cpu, a, from);
    if (v.t >= T_QNAN) {
        if (v.t == T_SNAN) cpu->fpsr |= IOC;
        if (cpu->fpcr & FPCR_DN) return dnan(to);
        int ff = frac_bits(from), tf = frac_bits(to);
        uint64_t pay = ff > tf ? v.m >> (ff - tf) : v.m << (tf - ff);
        return finf(v.s, to) | 1ull << (tf - 1) | pay;
    }
    if (v.t == T_INF) return finf(v.s, to);
    if (v.t == T_ZERO) return fzero(v.s, to);
    return fround(cpu, v.s, v.m, v.e, 0, to, mode);
}
/* FPRoundInt; exact (frintx) signals inexact */
static uint64_t frint(
    struct kb_cpu* cpu, uint64_t a, int n, int mode, int exact
) {
    a &= nmask(n);
    struct fpv v = unpack(cpu, a, n);
    uint64_t r;
    if (pnans(cpu, &v, &a, 1, n, &r)) return r;
    if (v.t == T_ZERO) return fzero(v.s, n);
    if (v.t == T_INF || v.e >= 0) return a;
    int rs = rest(v.m, -v.e, 0);
    uint64_t mag = (uint64_t) shr(v.m, -v.e);
    mag += (uint64_t) round_up(mode, rs, (int) mag & 1, v.s);
    if (exact && rs) cpu->fpsr |= IXC;
    return mag ? fround(cpu, v.s, mag, 0, 0, n, RZ) : fzero(v.s, n);
}
/* FPToFixed: to a bits-wide integer with fb fraction bits, saturating */
static uint64_t tofixed(
    struct kb_cpu* cpu, uint64_t a, int n, int fb, int bits, int uns, int mode
) {
    struct fpv v = unpack(cpu, a, n);
    __int128 hi = uns ? ((__int128) 1 << bits) - 1
                      : ((__int128) 1 << (bits - 1)) - 1,
             lo = uns ? 0 : -hi - 1, val = 0;
    int r = 0;
    if (v.t >= T_QNAN) {
        cpu->fpsr |= IOC;
        return 0;
    }
    int sh = -(v.e + fb);
    if (v.t == T_INF || (v.t == T_NUM && bitlen(v.m) - sh > 100))
        val = v.s ? lo - 1 : hi + 1;
    else if (v.t == T_NUM) {
        r = rest(v.m, sh, 0);
        u128 mag = shr(v.m, sh);
        mag += (u128) round_up(mode, r, (int) mag & 1, v.s);
        val = v.s ? -(__int128) mag : (__int128) mag;
    }
    if (val > hi || val < lo) {
        cpu->fpsr |= IOC;
        val = val > hi ? hi : lo;
    }
    else if (r)
        cpu->fpsr |= IXC;
    return (uint64_t) val & nmask(bits);
}
static uint64_t fromfixed(
    struct kb_cpu* cpu, uint64_t x, int bits, int uns, int fb, int n, int mode
) {
    if (bits == 32) x = uns ? (uint32_t) x : (uint64_t) (int64_t) (int32_t) x;
    int s = !uns && (int64_t) x < 0;
    if (s) x = -x;
    return x ? fround(cpu, s, x, -fb, 0, n, mode) : 0;
}
/* FPCompare: 0 equal, 1 less, 2 greater, 3 unordered; IOC for a signalling
 * NaN, or for any NaN when sig */
static int fcmp(struct kb_cpu* cpu, uint64_t a, uint64_t b, int n, int sig) {
    struct fpv x = unpack(cpu, a, n), y = unpack(cpu, b, n);
    if (x.t >= T_QNAN || y.t >= T_QNAN) {
        if (sig || x.t == T_SNAN || y.t == T_SNAN) cpu->fpsr |= IOC;
        return 3;
    }
    double p = fval(&x), q = fval(&y);
    return p == q ? 0 : p < q ? 1 : 2;
}
/* NZCV: equal 0110, less 1000, greater 0010, unordered 0011 */
static void fcmp_flags(struct kb_cpu* cpu, int r) {
    cpu->n = r == 1;
    cpu->z = r == 0;
    cpu->c = r != 1;
    cpu->v = r == 3;
}
/* fcmeq (quiet), fcmge, fcmgt: all ones or zero */
enum
{
    C_EQ,
    C_GE,
    C_GT
};
static uint64_t fcmpv(
    struct kb_cpu* cpu, int c, uint64_t a, uint64_t b, int n
) {
    int r = fcmp(cpu, a, b, n, c != C_EQ);
    return (c == C_EQ   ? r == 0
            : c == C_GE ? r == 0 || r == 2
                        : r == 2)
               ? nmask(n)
               : 0;
}
static uint64_t vfp_imm(unsigned imm8, int dbl) {
    uint64_t s = imm8 >> 7, b6 = (imm8 >> 6) & 1, low = imm8 & 0x3f;
    if (dbl)
        return (s << 63) | ((b6 ^ 1) << 62) | ((b6 ? 0xffull : 0) << 54) |
               (low << 48);
    return (s << 31) | ((b6 ^ 1) << 30) | ((b6 ? 0x1fu : 0) << 25) |
           (low << 19);
}
/* #endregion */

/* #region loads and stores (address in r[b]) */
static void load_v(struct kb_cpu* cpu, uint64_t a, unsigned rt, int bytes) {
    uint64_t lo = kb_load(cpu, a, bytes >= 8 ? 8 : bytes),
             hi = bytes == 16 ? kb_load(cpu, a + 8, 8) : 0;
    if (!cpu->fault) set_v(cpu, rt, lo, hi);
}
static void store_v(struct kb_cpu* cpu, uint64_t a, unsigned rt, int bytes) {
    kb_store(cpu, a, vr(cpu, rt)[0], bytes >= 8 ? 8 : bytes);
    if (bytes == 16 && !cpu->fault) kb_store(cpu, a + 8, vr(cpu, rt)[1], 8);
}

static int load_store(struct kb_cpu* cpu, uint32_t i, uint64_t a) {
    unsigned rt = i & 31;
    if ((i & 0x3a000000) == 0x28000000) {
        /* ldp/stp of s, d or q */
        int bytes = 4 << (i >> 30);
        unsigned rt2 = (i >> 10) & 31;
        if ((i >> 22) & 1) {
            uint64_t lo1 = kb_load(cpu, a, bytes >= 8 ? 8 : bytes),
                     hi1 = bytes == 16 ? kb_load(cpu, a + 8, 8) : 0;
            uint64_t lo2 = kb_load(cpu, a + bytes, bytes >= 8 ? 8 : bytes),
                     hi2 = bytes == 16 ? kb_load(cpu, a + bytes + 8, 8) : 0;
            if (cpu->fault) return 0;
            set_v(cpu, rt, lo1, hi1);
            set_v(cpu, rt2, lo2, hi2);
        }
        else {
            store_v(cpu, a, rt, bytes);
            if (!cpu->fault) store_v(cpu, a + bytes, rt2, bytes);
        }
        return 0;
    }
    if ((i & 0x3f000000) == 0x1c000000) { /* ldr literal: s, d, q */
        if (i >> 30 == 3) return 1;
        load_v(cpu, a, rt, 4 << (i >> 30));
        return 0;
    }
    if ((i & 0x3a000000) == 0x38000000) {
        /* ldr/str: offset, unscaled, pre and post index, register offset */
        unsigned size = i >> 30, opc = (i >> 22) & 3;
        int bytes = (opc & 2) && size == 0 ? 16 : 1 << size;
        if (opc & 2 && size) return 1;
        if (opc & 1)
            load_v(cpu, a, rt, bytes);
        else
            store_v(cpu, a, rt, bytes);
        return 0;
    }
    if ((i & 0xbf800000) == 0x0c000000 || (i & 0xbf800000) == 0x0c800000) {
        /* ld1-ld4 / st1-st4, multiple structures */
        unsigned op = (i >> 12) & 15, size = (i >> 10) & 3, q = (i >> 30) & 1,
                 l = (i >> 22) & 1;
        int regs, sel;
        switch (op) {
            case 7: regs = 1, sel = 1; break;
            case 10: regs = 2, sel = 1; break;
            case 6: regs = 3, sel = 1; break;
            case 2: regs = 4, sel = 1; break;
            case 8: regs = 1, sel = 2; break;
            case 4: regs = 1, sel = 3; break;
            case 0: regs = 1, sel = 4; break;
            default: return 1;
        }
        int eb = 1 << size, lanes = (q ? 16 : 8) / eb;
        if (sel == 1) { /* whole registers, one after another */
            for (int k = 0; k < regs && !cpu->fault; k++) {
                uint64_t at = a + (uint64_t) k * (q ? 16 : 8);
                if (l)
                    load_v(cpu, at, rt + (unsigned) k, q ? 16 : 8);
                else
                    store_v(cpu, at, rt + (unsigned) k, q ? 16 : 8);
            }
            return 0;
        }
        /* interleaved: element e of structure s is lane s of register e */
        uint64_t at = a;
        uint64_t tmp[4][2] = {{0}};
        for (int e = 0; e < sel; e++)
            memcpy(tmp[e], vr(cpu, rt + (unsigned) e), 16);
        for (int s = 0; s < lanes && !cpu->fault; s++)
            for (int e = 0; e < sel && !cpu->fault; e++, at += (uint64_t) eb) {
                if (l)
                    set_lane(tmp[e], eb, s, kb_load(cpu, at, eb));
                else
                    kb_store(cpu, at, lane(tmp[e], eb, s), eb);
            }
        if (l && !cpu->fault)
            for (int e = 0; e < sel; e++)
                set_v(cpu, rt + (unsigned) e, tmp[e][0], q ? tmp[e][1] : 0);
        return 0;
    }
    if ((i & 0xbf800000) == 0x0d000000 || (i & 0xbf800000) == 0x0d800000) {
        /* ld1-ld4 / st1-st4 of one lane, and ld1r-ld4r */
        unsigned opc = (i >> 13) & 7, s = (i >> 12) & 1, size = (i >> 10) & 3,
                 q = (i >> 30) & 1, l = (i >> 22) & 1, r = (i >> 21) & 1;
        int sel = (int) ((opc & 1) << 1 | r) + 1, eb, idx;
        unsigned scale = opc >> 1;
        if (scale == 3) { /* replicate */
            if (!l) return 1;
            eb = 1 << size;
            for (int e = 0; e < sel && !cpu->fault; e++) {
                uint64_t v = kb_load(cpu, a + (uint64_t) (e * eb), eb), t[2];
                if (cpu->fault) return 0;
                for (int k = 0; k < 16 / eb; k++) set_lane(t, eb, k, v);
                set_v(cpu, rt + (unsigned) e, t[0], q ? t[1] : 0);
            }
            return 0;
        }
        if (scale == 0)
            eb = 1, idx = (int) (q << 3 | s << 2 | size);
        else if (scale == 1)
            eb = 2, idx = (int) (q << 2 | s << 1 | (size >> 1));
        else if (!(size & 1))
            eb = 4, idx = (int) (q << 1 | s);
        else
            eb = 8, idx = (int) q;
        for (int e = 0; e < sel && !cpu->fault; e++) {
            uint64_t at = a + (uint64_t) (e * eb);
            if (l) {
                uint64_t v = kb_load(cpu, at, eb);
                if (!cpu->fault)
                    set_lane(vr(cpu, rt + (unsigned) e), eb, idx, v);
            }
            else
                kb_store(
                    cpu, at, lane(vr(cpu, rt + (unsigned) e), eb, idx), eb
                );
        }
        return 0;
    }
    return 1;
}
/* #endregion */

/* #region scalar floating point */
static uint64_t sreg(struct kb_cpu* cpu, unsigned r, int n) {
    return vr(cpu, r)[0] & nmask(n);
}

static int fp_scalar(struct kb_cpu* cpu, uint32_t i) {
    unsigned type = (i >> 22) & 3, rd = i & 31, rn = (i >> 5) & 31,
             rm = (i >> 16) & 31;
    int n = type == 1 ? 64 : type == 3 ? 16 : 32, mode = fmode(cpu);
    uint64_t sign = 1ull << (n - 1);
    if ((i & 0x5f000000) == 0x1f000000) { /* fmadd fmsub fnmadd fnmsub */
        if (type > 1) return 1;
        unsigned o1 = (i >> 21) & 1, o0 = (i >> 15) & 1, ra = (i >> 10) & 31;
        uint64_t a = sreg(cpu, ra, n), x = sreg(cpu, rn, n),
                 y = sreg(cpu, rm, n);
        if (o1) a ^= sign;
        if (o1 != o0) x ^= sign;
        set_v(cpu, rd, ffma(cpu, a, x, y, n), 0);
        return 0;
    }
    if ((i & 0x5f200000) == 0x1e000000) { /* fixed-point conversions */
        unsigned sf = i >> 31, rmode = (i >> 19) & 3, op = (i >> 16) & 7;
        int fb = 64 - (int) ((i >> 10) & 63), bits = sf ? 64 : 32;
        if (type > 1 || fb > bits) return 1;
        if (rmode == 0 && (op == 2 || op == 3)) {
            set_v(
                cpu, rd, fromfixed(cpu, xr(cpu, rn), bits, op & 1, fb, n, mode),
                0
            );
            return 0;
        }
        if (rmode == 3 && op < 2) {
            set_x(
                cpu, rd,
                tofixed(cpu, sreg(cpu, rn, n), n, fb, bits, op & 1, RZ),
                (int) sf
            );
            return 0;
        }
        return 1;
    }
    if ((i & 0x5f200000) != 0x1e200000) return 1;
    if ((i & 0xfc00) ==
        0) { /* conversions between floating point and integer */
        unsigned sf = i >> 31, rmode = (i >> 19) & 3, op = (i >> 16) & 7;
        int bits = sf ? 64 : 32;
        if (op == 6 || op == 7) { /* fmov between general and vector */
            if (type == 2 && sf && rmode == 1) { /* the top half of a q */
                if (op == 6)
                    set_x(cpu, rd, vr(cpu, rn)[1], 1);
                else
                    vr(cpu, rd)[1] = xr(cpu, rn);
                return 0;
            }
            if (rmode || (type == 0) == (sf == 1) || type > 1) return 1;
            if (op == 6)
                set_x(cpu, rd, sreg(cpu, rn, n), (int) sf);
            else
                set_v(cpu, rd, sf ? xr(cpu, rn) : (uint32_t) xr(cpu, rn), 0);
            return 0;
        }
        if (type > 1) return 1;
        if (op < 2) { /* fcvtns fcvtps fcvtms fcvtzs and the unsigned forms */
            set_x(
                cpu, rd,
                tofixed(cpu, sreg(cpu, rn, n), n, 0, bits, op & 1, (int) rmode),
                (int) sf
            );
            return 0;
        }
        if (rmode) return 1;
        if (op < 4) { /* scvtf ucvtf */
            set_v(
                cpu, rd, fromfixed(cpu, xr(cpu, rn), bits, op & 1, 0, n, mode),
                0
            );
            return 0;
        }
        /* fcvtas fcvtau: to nearest, ties away */
        set_x(
            cpu, rd, tofixed(cpu, sreg(cpu, rn, n), n, 0, bits, op & 1, RA),
            (int) sf
        );
        return 0;
    }
    if ((i & 0x7c00) == 0x4000) { /* one source */
        unsigned op = (i >> 15) & 0x3f;
        uint64_t a = sreg(cpu, rn, n), r;
        if (type == 2 || (type == 3 && op != 4 && op != 5)) return 1;
        if ((op == 4 && n == 32) || (op == 5 && n == 64) ||
            (op == 7 && n == 16))
            return 1;
        switch (op) {
            case 0: r = a; break;
            case 1: r = a & ~sign; break;
            case 2: r = a ^ sign; break;
            case 3: r = fsqrt(cpu, a, n); break;
            case 4: r = fcvt(cpu, a, n, 32, mode); break;
            case 5: r = fcvt(cpu, a, n, 64, mode); break;
            case 7: r = fcvt(cpu, a, n, 16, mode); break;
            case 8:
            case 9:
            case 10:
            case 11: r = frint(cpu, a, n, (int) op - 8, 0); break;
            case 12: r = frint(cpu, a, n, RA, 0); break;
            case 14: r = frint(cpu, a, n, mode, 1); break;
            case 15: r = frint(cpu, a, n, mode, 0); break;
            default: return 1;
        }
        set_v(cpu, rd, r, 0);
        return 0;
    }
    if (type > 1) return 1;
    if ((i & 0x3c00) == 0x2000) { /* fcmp fcmpe, against a register or zero */
        uint64_t b = (i & 8) ? 0 : sreg(cpu, rm, n);
        fcmp_flags(cpu, fcmp(cpu, sreg(cpu, rn, n), b, n, (i >> 4) & 1));
        return 0;
    }
    if ((i & 0x1c00) == 0x1000) { /* fmov immediate */
        set_v(cpu, rd, vfp_imm((i >> 13) & 0xff, n == 64), 0);
        return 0;
    }
    unsigned cond = (i >> 12) & 15;
    switch ((i >> 10) & 3) {
        case 1: /* fccmp fccmpe */
            if (kb_cond(cpu, KB_C_A64 + (int) cond))
                fcmp_flags(
                    cpu,
                    fcmp(
                        cpu, sreg(cpu, rn, n), sreg(cpu, rm, n), n, (i >> 4) & 1
                    )
                );
            else {
                cpu->n = (int) (i >> 3) & 1;
                cpu->z = (int) (i >> 2) & 1;
                cpu->c = (int) (i >> 1) & 1;
                cpu->v = (int) i & 1;
            }
            return 0;
        case 2: { /* two sources */
            static const int ops[9] = {F_MUL, F_DIV,   F_ADD,   F_SUB, F_MAX,
                                       F_MIN, F_MAXNM, F_MINNM, F_MUL};
            unsigned op = (i >> 12) & 15;
            if (op > 8) return 1;
            uint64_t r =
                fop2(cpu, ops[op], sreg(cpu, rn, n), sreg(cpu, rm, n), n);
            /* fnmul: the product negated, a NaN too */
            set_v(cpu, rd, op == 8 ? r ^ sign : r, 0);
            return 0;
        }
        case 3: /* fcsel */
            set_v(
                cpu, rd,
                sreg(cpu, kb_cond(cpu, KB_C_A64 + (int) cond) ? rn : rm, n), 0
            );
            return 0;
    }
    return 1;
}
/* #endregion */

/* #region Advanced SIMD */
/* two-register-misc floating point on one element (op is bits 16:12, a bit
 * 23); 0 when op is not one of these */
static int fmisc(
    struct kb_cpu* cpu, unsigned op, unsigned u, unsigned a, int n, uint64_t x,
    uint64_t* out
) {
    uint64_t s = 1ull << (n - 1);
    switch (op) {
        case 0x1a:
            *out = tofixed(cpu, x, n, 0, n, (int) u, a ? RP : RN);
            return 1;
        case 0x1b:
            *out = tofixed(cpu, x, n, 0, n, (int) u, a ? RZ : RM);
            return 1;
        case 0x1c:
            if (a) return 0;
            *out = tofixed(cpu, x, n, 0, n, (int) u, RA);
            return 1;
        case 0x1d:
            if (a) return 0;
            *out = fromfixed(cpu, x, n, (int) u, 0, n, fmode(cpu));
            return 1;
        case 0x0f:
            if (!a) return 0;
            *out = u ? x ^ s : x & ~s;
            return 1;
        case 0x1f:
            if (!a || !u) return 0;
            *out = fsqrt(cpu, x, n);
            return 1;
        case 0x18: /* frintn frintp; u: frinta */
            if (u && a) return 0;
            *out = frint(cpu, x, n, u ? RA : a ? RP : RN, 0);
            return 1;
        case 0x19: /* frintm frintz; u: frintx frinti by FPCR's mode */
            *out = frint(cpu, x, n, u ? fmode(cpu) : a ? RZ : RM, u && !a);
            return 1;
        case 0x0c: /* against zero: fcmgt fcmge */
        case 0x0d: /* fcmeq fcmle */
        case 0x0e: /* fcmlt */
            if (!a || (op == 0x0e && u)) return 0;
            *out = op == 0x0c   ? fcmpv(cpu, u ? C_GE : C_GT, x, 0, n)
                   : op == 0x0e ? fcmpv(cpu, C_GT, 0, x, n)
                   : u          ? fcmpv(cpu, C_GE, 0, x, n)
                                : fcmpv(cpu, C_EQ, x, 0, n);
            return 1;
    }
    return 0;
}
/* fmul fmulx fmla fmls against element e */
static uint64_t fbyelem(
    struct kb_cpu* cpu, unsigned opc, unsigned u, uint64_t acc, uint64_t a,
    uint64_t e, int n
) {
    if (opc == 9) return fop2(cpu, u ? F_MULX : F_MUL, a, e, n);
    return ffma(cpu, acc, opc == 5 ? a ^ 1ull << (n - 1) : a, e, n);
}
/* the result, zeroed above 64 bits unless q */
static void put_q(struct kb_cpu* cpu, unsigned rd, const uint64_t* t, int q) {
    set_v(cpu, rd, t[0], q ? t[1] : 0);
}
static uint64_t expand_imm(unsigned op, unsigned cmode, unsigned imm8) {
    uint64_t i8 = imm8, r = 0;
    switch (cmode >> 1) {
        case 0:
        case 1:
        case 2:
        case 3: r = i8 << (8 * (cmode >> 1)); return r | r << 32;
        case 4:
        case 5:
            r = i8 << (8 * ((cmode >> 1) & 1));
            return r | r << 16 | r << 32 | r << 48;
        case 6:
            r = cmode & 1 ? (i8 << 16) | 0xffff : (i8 << 8) | 0xff;
            return r | r << 32;
        default:
            if (!(cmode & 1)) {
                if (!op) return i8 * 0x0101010101010101ull;
                for (int k = 0; k < 8; k++)
                    if ((imm8 >> k) & 1) r |= 0xffull << (8 * k);
                return r;
            }
            if (!op) {
                r = vfp_imm(imm8, 0);
                return r | r << 32;
            }
            return vfp_imm(imm8, 1);
    }
}

/* integer three-same element op, 0 when unknown (known ops return 1);
 * saturation sets FPSR.QC */
static int int3(
    struct kb_cpu* cpu, unsigned op, unsigned u, int eb, uint64_t a, uint64_t b,
    uint64_t acc, uint64_t* out
) {
    uint64_t m = mask_of(eb);
    int64_t sa = sext_of(a, eb), sb = sext_of(b, eb);
    a &= m;
    b &= m;
    switch (op) {
        case 0x10: *out = (u ? a - b : a + b) & m; return 1;
        case 0x11: *out = (u ? a == b : (a & b) != 0) ? m : 0; return 1;
        case 0x06: *out = (u ? a > b : sa > sb) ? m : 0; return 1;
        case 0x07: *out = (u ? a >= b : sa >= sb) ? m : 0; return 1;
        case 0x0c:
            *out = u ? (a > b ? a : b) : (uint64_t) (sa > sb ? sa : sb) & m;
            return 1;
        case 0x0d:
            *out = u ? (a < b ? a : b) : (uint64_t) (sa < sb ? sa : sb) & m;
            return 1;
        case 0x13:
            if (u) return 0;
            *out = (a * b) & m;
            return 1;
        case 0x12: *out = (u ? acc - a * b : acc + a * b) & m; return 1;
        case 0x08: { /* sshl ushl: by the signed low byte of b */
            int s = (int8_t) b;
            if (s >= 8 * eb || s <= -8 * eb)
                *out = s < 0 && !u && sa < 0 ? m : 0;
            else if (s >= 0)
                *out = (a << s) & m;
            else
                *out = (u ? a >> -s : (uint64_t) (sa >> -s)) & m;
            return 1;
        }
        case 0x01:   /* sqadd uqadd */
        case 0x05: { /* sqsub uqsub */
            __int128 x = u ? (__int128) a : sa, y = u ? (__int128) b : sb,
                     v = op == 5 ? x - y : x + y;
            __int128 hi = u ? (__int128) m : (__int128) (m >> 1),
                     lo = u ? 0 : -hi - 1;
            if (v > hi || v < lo) {
                cpu->fpsr |= FPSR_QC;
                v = v > hi ? hi : lo;
            }
            *out = (uint64_t) v & m;
            return 1;
        }
        case 0x00: /* shadd uhadd */
            *out = (u ? (a + b) >> 1 : (uint64_t) ((sa + sb) >> 1)) & m;
            return 1;
        case 0x02: /* srhadd urhadd */
            *out = (u ? (a + b + 1) >> 1 : (uint64_t) ((sa + sb + 1) >> 1)) & m;
            return 1;
        case 0x0e: /* sabd uabd */
            *out = (u ? (a > b ? a - b : b - a)
                      : (uint64_t) (sa > sb ? sa - sb : sb - sa)) &
                   m;
            return 1;
    }
    return 0;
}

static int simd(struct kb_cpu* cpu, uint32_t i) {
    unsigned q = (i >> 30) & 1, u = (i >> 29) & 1, size = (i >> 22) & 3,
             rd = i & 31, rn = (i >> 5) & 31, rm = (i >> 16) & 31;
    const uint64_t *n = vr(cpu, rn), *mv = vr(cpu, rm);
    uint64_t t[2] = {0, 0};
    int bytes = q ? 16 : 8;

    if ((i & 0xbf208c00) == 0x0e000800) { /* uzp trn zip */
        unsigned op = (i >> 12) & 7;
        int eb = 1 << size, lanes = bytes / eb, half = lanes / 2;
        for (int k = 0; k < lanes; k++) {
            int p = k / 2;
            uint64_t v;
            switch (op & 3) {
                case 1: /* uzp */
                {
                    int idx = 2 * k + (op >> 2);
                    v = idx < lanes ? lane(n, eb, idx)
                                    : lane(mv, eb, idx - lanes);
                    break;
                }
                case 2: /* trn */
                    v = lane(k & 1 ? mv : n, eb, (k & ~1) + (int) (op >> 2));
                    break;
                case 3: /* zip */
                    v = lane(k & 1 ? mv : n, eb, p + (op >> 2 ? half : 0));
                    break;
                default: return 1;
            }
            set_lane(t, eb, k, v);
        }
        put_q(cpu, rd, t, (int) q);
        return 0;
    }
    if ((i & 0xbfe09c00) == 0x0e000000 || (i & 0xbfe09c00) == 0x0e001000) {
        /* tbl tbx: a table of len + 1 consecutive registers */
        int len = (int) ((i >> 13) & 3) + 1, tbx = (i >> 12) & 1;
        uint8_t table[64];
        for (int k = 0; k < len; k++)
            memcpy(table + 16 * k, vr(cpu, rn + (unsigned) k), 16);
        uint64_t old[2];
        memcpy(old, vr(cpu, rd), 16);
        for (int k = 0; k < bytes; k++) {
            unsigned idx = (unsigned) lane(mv, 1, k);
            set_lane(
                t, 1, k,
                idx < 16u * (unsigned) len ? table[idx]
                : tbx                      ? lane(old, 1, k)
                                           : 0
            );
        }
        put_q(cpu, rd, t, (int) q);
        return 0;
    }
    if ((i & 0xbfe08400) == 0x2e000000) { /* ext */
        unsigned pos = (i >> 11) & 15;
        uint8_t cat[32];
        memcpy(cat, n, 16);
        memcpy(cat + bytes, mv, 16);
        memcpy(t, cat + pos, (size_t) bytes);
        put_q(cpu, rd, t, (int) q);
        return 0;
    }
    if ((i & 0x9fe08400) == 0x0e000400) { /* dup ins smov umov */
        unsigned imm5 = (i >> 16) & 31, imm4 = (i >> 11) & 15;
        int sz = __builtin_ctz(imm5 | 32);
        if (sz > 3) return 1;
        int eb = 1 << sz, idx = (int) (imm5 >> (sz + 1));
        if (u) { /* ins element */
            memcpy(t, vr(cpu, rd), 16);
            set_lane(t, eb, idx, lane(n, eb, (int) (imm4 >> sz)));
            set_v(cpu, rd, t[0], t[1]);
            return 0;
        }
        switch (imm4) {
            case 0:   /* dup element */
            case 1: { /* dup general */
                uint64_t v =
                    imm4 ? xr(cpu, rn) & mask_of(eb) : lane(n, eb, idx);
                for (int k = 0; k < bytes / eb; k++) set_lane(t, eb, k, v);
                put_q(cpu, rd, t, (int) q);
                return 0;
            }
            case 3: /* ins general */
                memcpy(t, vr(cpu, rd), 16);
                set_lane(t, eb, idx, xr(cpu, rn));
                set_v(cpu, rd, t[0], t[1]);
                return 0;
            case 5: /* smov */
                set_x(
                    cpu, rd, (uint64_t) sext_of(lane(n, eb, idx), eb), (int) q
                );
                return 0;
            case 7: /* umov */
                set_x(cpu, rd, lane(n, eb, idx), (int) q);
                return 0;
        }
        return 1;
    }
    if ((i & 0x9f800400) == 0x0f800000 && ((i >> 12) & 1)) {
        /* fmul fmulx fmla fmls by element: sz 0 indexes by h:l, 1 by h */
        unsigned opc = (i >> 12) & 15, h = (i >> 11) & 1, l = (i >> 21) & 1;
        int fn = size & 1 ? 64 : 32, fe = fn / 8;
        if ((fn == 64 && (l || !q)) || (opc != 1 && opc != 5 && opc != 9) ||
            (u && opc != 9))
            return 1;
        uint64_t e = lane(mv, fe, fn == 64 ? (int) h : (int) (h << 1 | l));
        for (int k = 0; k < bytes / fe; k++)
            set_lane(
                t, fe, k,
                fbyelem(
                    cpu, opc, u, lane(vr(cpu, rd), fe, k), lane(n, fe, k), e, fn
                )
            );
        put_q(cpu, rd, t, (int) q);
        return 0;
    }
    if ((i & 0x9ff80400) == 0x0f000400) { /* modified immediate */
        unsigned cmode = (i >> 12) & 15,
                 imm8 = ((i >> 11) & 0xe0) | ((i >> 5) & 31);
        uint64_t v = expand_imm(u, cmode, imm8);
        if (u && cmode == 15 && !q) return 1;
        if (cmode < 12 && (cmode & 1)) /* orr, or bic when u */
            for (int k = 0; k < 2; k++)
                t[k] = u ? vr(cpu, rd)[k] & ~v : vr(cpu, rd)[k] | v;
        else /* movi, fmov, or mvni when u below cmode 14 */
            t[0] = t[1] = u && cmode < 14 ? ~v : v;
        put_q(cpu, rd, t, (int) q);
        return 0;
    }
    if ((i & 0x9f800400) == 0x0f000400) { /* shift by immediate */
        unsigned immh = (i >> 19) & 15, immhb = (i >> 16) & 127,
                 op = (i >> 11) & 31;
        if (!immh) return 1;
        int sz = 31 - __builtin_clz(immh), eb = 1 << sz, lanes = bytes / eb;
        int rsh = 2 * 8 * eb - (int) immhb, lsh = (int) immhb - 8 * eb;
        uint64_t m = mask_of(eb);
        switch (op) {
            case 0x00: /* sshr ushr */
            case 0x02: /* ssra usra */
                for (int k = 0; k < lanes; k++) {
                    uint64_t a = lane(n, eb, k), r;
                    if (u)
                        r = rsh >= 64 ? 0 : (a & m) >> rsh;
                    else
                        r = (uint64_t) (sext_of(a, eb) >>
                                        (rsh > 63 ? 63 : rsh));
                    if (op == 2) r += lane(vr(cpu, rd), eb, k);
                    set_lane(t, eb, k, r & m);
                }
                break;
            case 0x0a: /* shl sli */
                for (int k = 0; k < lanes; k++) {
                    uint64_t r = (lane(n, eb, k) << lsh) & m;
                    if (u) /* sli keeps the destination's low bits */
                        r |= lane(vr(cpu, rd), eb, k) & ((1ull << lsh) - 1);
                    set_lane(t, eb, k, r);
                }
                break;
            case 0x08: /* sri */
                if (!u) return 1;
                for (int k = 0; k < lanes; k++) {
                    uint64_t keep = rsh >= 8 * eb ? m : ~(m >> rsh) & m;
                    uint64_t r = (rsh >= 64 ? 0 : (lane(n, eb, k) & m) >> rsh) |
                                 (lane(vr(cpu, rd), eb, k) & keep);
                    set_lane(t, eb, k, r & m);
                }
                break;
            case 0x1c: /* scvtf ucvtf, fixed point (fraction bits rsh) */
            case 0x1f: /* fcvtzs fcvtzu, fixed point */
                if (sz < 2 || (sz == 3 && !q)) return 1;
                for (int k = 0; k < lanes; k++) {
                    uint64_t a = lane(n, eb, k);
                    set_lane(
                        t, eb, k,
                        op == 0x1c
                            ? fromfixed(
                                  cpu, a, 8 * eb, (int) u, rsh, 8 * eb,
                                  fmode(cpu)
                              )
                            : tofixed(cpu, a, 8 * eb, rsh, 8 * eb, (int) u, RZ)
                    );
                }
                break;
            case 0x14: { /* sshll ushll (and their 2 forms: the upper half) */
                if (sz > 2) return 1;
                int half = 8 / eb;
                for (int k = 0; k < half; k++) {
                    uint64_t a = lane(n, eb, k + (q ? half : 0));
                    uint64_t w = u ? a : (uint64_t) sext_of(a, eb);
                    set_lane(t, 2 * eb, k, (w << lsh) & mask_of(2 * eb));
                }
                set_v(cpu, rd, t[0], t[1]);
                return 0;
            }
            case 0x10: /* shrn (the 2 form fills the upper half) */
            {
                if (sz > 2 || u) return 1;
                int nb = 2 * eb, half = 8 / eb;
                /* immh names the narrow size; the shift is 2 * esize -
                 * immh:immb */
                rsh = 16 * eb - (int) immhb;
                memcpy(t, vr(cpu, rd), 16);
                for (int k = 0; k < half; k++)
                    set_lane(
                        t, eb, k + (q ? half : 0), (lane(n, nb, k) >> rsh) & m
                    );
                if (!q) t[1] = 0;
                set_v(cpu, rd, t[0], t[1]);
                return 0;
            }
            default: return 1;
        }
        put_q(cpu, rd, t, (int) q);
        return 0;
    }
    if ((i & 0x9f3e0c00) == 0x0e300800) { /* across lanes */
        unsigned op = (i >> 12) & 31;
        int eb = 1 << size, lanes = bytes / eb;
        uint64_t m = mask_of(eb), acc;
        if (op == 0x1b && !u) { /* addv */
            acc = 0;
            for (int k = 0; k < lanes; k++) acc += lane(n, eb, k);
            set_v(cpu, rd, acc & m, 0);
            return 0;
        }
        if (op == 0x03) { /* saddlv uaddlv */
            acc = 0;
            for (int k = 0; k < lanes; k++)
                acc +=
                    u ? lane(n, eb, k) : (uint64_t) sext_of(lane(n, eb, k), eb);
            set_v(cpu, rd, acc & mask_of(2 * eb), 0);
            return 0;
        }
        if (op == 0x0a || op == 0x1a) { /* smaxv umaxv sminv uminv */
            int max = op == 0x0a;
            acc = lane(n, eb, 0);
            for (int k = 1; k < lanes; k++) {
                uint64_t v = lane(n, eb, k);
                int bigger = u ? v > acc : sext_of(v, eb) > sext_of(acc, eb);
                if (bigger == max && v != acc) acc = v;
            }
            set_v(cpu, rd, acc & m, 0);
            return 0;
        }
        if ((op == 0x0c || op == 0x0f) && u) {
            /* fmaxnmv fminnmv fmaxv fminv, 4s only: (0 op 1) op (2 op 3) */
            int min = (i >> 23) & 1, f = op == 0x0c ? (min ? F_MINNM : F_MAXNM)
                                                    : (min ? F_MIN : F_MAX);
            if ((i >> 22) & 1 || !q) return 1;
            uint64_t lo = fop2(cpu, f, lane(n, 4, 0), lane(n, 4, 1), 32),
                     hi = fop2(cpu, f, lane(n, 4, 2), lane(n, 4, 3), 32);
            set_v(cpu, rd, fop2(cpu, f, lo, hi, 32), 0);
            return 0;
        }
        return 1;
    }
    if ((i & 0x9f3e0c00) == 0x0e200800) { /* two-register miscellaneous */
        unsigned op = (i >> 12) & 31;
        int eb = 1 << size, lanes = bytes / eb;
        uint64_t m = mask_of(eb);
        if ((op >= 0x0c && op <= 0x0f) || op >= 0x18) { /* floating point */
            int fn = (i >> 22) & 1 ? 64 : 32, fe = fn / 8;
            if (fn == 64 && !q) return 1;
            for (int k = 0; k < bytes / fe; k++) {
                uint64_t r;
                if (!fmisc(cpu, op, u, (i >> 23) & 1, fn, lane(n, fe, k), &r))
                    return 1;
                set_lane(t, fe, k, r);
            }
            put_q(cpu, rd, t, (int) q);
            return 0;
        }
        if (op == 0x16 || op == 0x17) {
            /* fcvtn fcvtxn (to the low half, or the high half keeping the
             * low), fcvtl (from the low or high half) */
            int wide = (i >> 22) & 1 ? 64 : 32, nar = wide / 2, we = wide / 8,
                ne = nar / 8, w = 16 / we;
            if (op == 0x17) {
                if (u) return 1;
                for (int k = 0; k < w; k++)
                    set_lane(
                        t, we, k,
                        fcvt(
                            cpu, lane(n, ne, k + (q ? w : 0)), nar, wide,
                            fmode(cpu)
                        )
                    );
                set_v(cpu, rd, t[0], t[1]);
                return 0;
            }
            if (u && wide != 64) return 1;
            memcpy(t, vr(cpu, rd), 16);
            for (int k = 0; k < w; k++)
                set_lane(
                    t, ne, k + (q ? w : 0),
                    fcvt(cpu, lane(n, we, k), wide, nar, u ? RO : fmode(cpu))
                );
            if (!q) t[1] = 0;
            set_v(cpu, rd, t[0], t[1]);
            return 0;
        }
        switch (op) {
            case 0x00:   /* rev64 rev32 */
            case 0x01: { /* rev16 */
                int group = op ? 2 : u ? 4 : 8;
                if (eb >= group) return 1;
                for (int k = 0; k < bytes; k += group)
                    for (int e = 0; e < group / eb; e++)
                        set_lane(
                            t, eb, (k / eb) + e,
                            lane(n, eb, (k / eb) + group / eb - 1 - e)
                        );
                break;
            }
            case 0x05: /* cnt, not */
                if (size) {
                    if (size == 1 && u) { /* rbit */
                        for (int k = 0; k < bytes; k++) {
                            unsigned b = (unsigned) lane(n, 1, k), r = 0;
                            for (int j = 0; j < 8; j++)
                                r |= ((b >> j) & 1) << (7 - j);
                            set_lane(t, 1, k, r);
                        }
                        break;
                    }
                    return 1;
                }
                for (int k = 0; k < bytes; k++) {
                    uint64_t b = lane(n, 1, k);
                    set_lane(
                        t, 1, k,
                        u ? ~b & 0xff : (uint64_t) __builtin_popcountll(b)
                    );
                }
                break;
            case 0x08: /* cmgt cmge #0 */
            case 0x09: /* cmeq cmle #0 */
            case 0x0a: /* cmlt #0 */
                if (op == 0x0a && u) return 1;
                for (int k = 0; k < lanes; k++) {
                    int64_t v = sext_of(lane(n, eb, k), eb);
                    int r = op == 8   ? (u ? v >= 0 : v > 0)
                            : op == 9 ? (u ? v <= 0 : v == 0)
                                      : v < 0;
                    set_lane(t, eb, k, r ? m : 0);
                }
                break;
            case 0x0b: /* abs neg */
                for (int k = 0; k < lanes; k++) {
                    int64_t v = sext_of(lane(n, eb, k), eb);
                    set_lane(
                        t, eb, k,
                        (uint64_t) (u       ? -v
                                    : v < 0 ? -v
                                            : v) &
                            m
                    );
                }
                break;
            case 0x12:   /* xtn (the 2 form fills the upper half) */
            case 0x13: { /* shll */
                if (op == 0x13 && !u) return 1;
                if (op == 0x12 && u) return 1;
                int half = 8 / eb;
                if (op == 0x13) {
                    for (int k = 0; k < half; k++)
                        set_lane(
                            t, 2 * eb, k,
                            lane(n, eb, k + (q ? half : 0)) << (8 * eb)
                        );
                    set_v(cpu, rd, t[0], t[1]);
                    return 0;
                }
                memcpy(t, vr(cpu, rd), 16);
                for (int k = 0; k < half; k++)
                    set_lane(t, eb, k + (q ? half : 0), lane(n, 2 * eb, k) & m);
                if (!q) t[1] = 0;
                set_v(cpu, rd, t[0], t[1]);
                return 0;
            }
            default: return 1;
        }
        put_q(cpu, rd, t, (int) q);
        return 0;
    }
    if ((i & 0x9f200c00) == 0x0e200000) { /* three different */
        unsigned op = (i >> 12) & 15;
        int eb = 1 << size, half = 8 / eb, wide = 2 * eb, off = q ? half : 0;
        uint64_t wm = mask_of(wide);
        if (size > 2) return 1;
        if (op == 4 || op == 6) { /* addhn subhn; raddhn rsubhn round */
            uint64_t o[2] = {q ? vr(cpu, rd)[0] : 0, 0};
            for (int k = 0; k < half; k++) {
                uint64_t a = lane(n, wide, k), b = lane(mv, wide, k);
                uint64_t r =
                    (op == 4 ? a + b : a - b) + (u ? 1ull << (8 * eb - 1) : 0);
                set_lane(o, eb, k + off, ((r & wm) >> (8 * eb)) & mask_of(eb));
            }
            set_v(cpu, rd, o[0], o[1]);
            return 0;
        }
        for (int k = 0; k < half; k++) {
            uint64_t bn = lane(mv, eb, k + off);
            uint64_t b = u ? bn : (uint64_t) sext_of(bn, eb), a, r;
            if (op == 1 || op == 3) /* saddw ssubw: n is already wide */
                a = lane(n, wide, k);
            else {
                uint64_t an = lane(n, eb, k + off);
                a = u ? an : (uint64_t) sext_of(an, eb);
            }
            switch (op) {
                case 0:
                case 1: r = a + b; break;
                case 2:
                case 3: r = a - b; break;
                case 12:
                    r = u ? a * b : (uint64_t) ((int64_t) a * (int64_t) b);
                    break;
                case 8: r = lane(vr(cpu, rd), wide, k) + a * b; break;
                case 10: r = lane(vr(cpu, rd), wide, k) - a * b; break;
                case 7: /* sabdl uabdl */
                    r = u ? (a > b ? a - b : b - a)
                          : (uint64_t) ((int64_t) a > (int64_t) b
                                            ? (int64_t) a - (int64_t) b
                                            : (int64_t) b - (int64_t) a);
                    break;
                default: return 1;
            }
            set_lane(t, wide, k, r & wm);
        }
        set_v(cpu, rd, t[0], t[1]);
        return 0;
    }
    if ((i & 0x9f200400) == 0x0e200400) { /* three same */
        unsigned op = (i >> 11) & 31;
        if (op == 0x03) { /* and bic orr orn / eor bsl bit bif */
            for (int k = 0; k < 2; k++) {
                uint64_t a = n[k], b = mv[k], d = vr(cpu, rd)[k];
                if (!u)
                    t[k] = size == 0   ? a & b
                           : size == 1 ? a & ~b
                           : size == 2 ? a | b
                                       : a | ~b;
                else
                    t[k] = size == 0   ? a ^ b
                           : size == 1 ? (d & a) | (~d & b)
                           : size == 2 ? (d & ~b) | (a & b)
                                       : (d & b) | (a & ~b);
            }
            put_q(cpu, rd, t, (int) q);
            return 0;
        }
        if (op >=
            0x18) { /* floating point: sz is bit 22, the op's high bit bit 23 */
            int fn = (i >> 22) & 1 ? 64 : 32, fe = fn / 8, fl = bytes / fe;
            unsigned o = (op << 2) | (u << 1) | ((i >> 23) & 1);
            uint64_t sg = 1ull << (fn - 1);
            if (fn == 64 && !q) return 1;
            for (int k = 0; k < fl; k++) {
                uint64_t a = lane(n, fe, k), b = lane(mv, fe, k), r;
                int pw = -1;
                switch (o) {
                    case (0x1a << 2): r = fop2(cpu, F_ADD, a, b, fn); break;
                    case (0x1a << 2) | 1: r = fop2(cpu, F_SUB, a, b, fn); break;
                    case (0x1a << 2) | 3: r = fop2(cpu, F_ABD, a, b, fn); break;
                    case (0x1b << 2): r = fop2(cpu, F_MULX, a, b, fn); break;
                    case (0x1b << 2) | 2: r = fop2(cpu, F_MUL, a, b, fn); break;
                    case (0x1f << 2) | 2: r = fop2(cpu, F_DIV, a, b, fn); break;
                    case (0x1e << 2): r = fop2(cpu, F_MAX, a, b, fn); break;
                    case (0x1e << 2) | 1: r = fop2(cpu, F_MIN, a, b, fn); break;
                    case (0x18 << 2): r = fop2(cpu, F_MAXNM, a, b, fn); break;
                    case (0x18 << 2) | 1:
                        r = fop2(cpu, F_MINNM, a, b, fn);
                        break;
                    /* pairwise: pairs of n then of m */
                    case (0x1a << 2) | 2: pw = F_ADD; break;
                    case (0x1e << 2) | 2: pw = F_MAX; break;
                    case (0x1e << 2) | 3: pw = F_MIN; break;
                    case (0x18 << 2) | 2: pw = F_MAXNM; break;
                    case (0x18 << 2) | 3: pw = F_MINNM; break;
                    case (0x19 << 2):
                        r = ffma(cpu, lane(vr(cpu, rd), fe, k), a, b, fn);
                        break;
                    case (0x19 << 2) | 1:
                        r = ffma(cpu, lane(vr(cpu, rd), fe, k), a ^ sg, b, fn);
                        break;
                    case (0x1c << 2): r = fcmpv(cpu, C_EQ, a, b, fn); break;
                    case (0x1c << 2) | 2: r = fcmpv(cpu, C_GE, a, b, fn); break;
                    case (0x1c << 2) | 3: r = fcmpv(cpu, C_GT, a, b, fn); break;
                    case (0x1d << 2) | 2: /* facge facgt */
                    case (0x1d << 2) | 3:
                        r = fcmpv(
                            cpu, o & 1 ? C_GT : C_GE, a & ~sg, b & ~sg, fn
                        );
                        break;
                    default: return 1;
                }
                if (pw >= 0) {
                    const uint64_t* s = 2 * k < fl ? n : mv;
                    int j = (2 * k) % fl;
                    r = fop2(cpu, pw, lane(s, fe, j), lane(s, fe, j + 1), fn);
                }
                set_lane(t, fe, k, r);
            }
            put_q(cpu, rd, t, (int) q);
            return 0;
        }
        int eb = 1 << size, lanes = bytes / eb;
        if (op == 0x17 && !u) { /* addp: pairs of n then of m */
            for (int k = 0; k < lanes; k++) {
                const uint64_t* s = 2 * k < lanes ? n : mv;
                int j = (2 * k) % lanes;
                set_lane(
                    t, eb, k,
                    (lane(s, eb, j) + lane(s, eb, j + 1)) & mask_of(eb)
                );
            }
            put_q(cpu, rd, t, (int) q);
            return 0;
        }
        if (op == 0x14 || op == 0x15) { /* smaxp umaxp sminp uminp */
            for (int k = 0; k < lanes; k++) {
                const uint64_t* s = 2 * k < lanes ? n : mv;
                int j = (2 * k) % lanes;
                uint64_t a = lane(s, eb, j), b = lane(s, eb, j + 1), r;
                int agt = u ? a > b : sext_of(a, eb) > sext_of(b, eb);
                r = (op == 0x14) == agt ? a : b;
                set_lane(t, eb, k, r);
            }
            put_q(cpu, rd, t, (int) q);
            return 0;
        }
        for (int k = 0; k < lanes; k++) {
            uint64_t r;
            if (!int3(
                    cpu, op, u, eb, lane(n, eb, k), lane(mv, eb, k),
                    lane(vr(cpu, rd), eb, k), &r
                ))
                return 1;
            set_lane(t, eb, k, r);
        }
        put_q(cpu, rd, t, (int) q);
        return 0;
    }
    return 1;
}

/* the scalar forms: one 64-bit (or narrower) element in the low lane */
static int simd_scalar(struct kb_cpu* cpu, uint32_t i) {
    unsigned u = (i >> 29) & 1, size = (i >> 22) & 3, rd = i & 31,
             rn = (i >> 5) & 31, rm = (i >> 16) & 31;
    uint64_t a = vr(cpu, rn)[0], b = vr(cpu, rm)[0];
    if ((i & 0xdf800400) == 0x5f800000) {
        /* fmul fmulx fmla fmls by element */
        unsigned opc = (i >> 12) & 15, h = (i >> 11) & 1, l = (i >> 21) & 1;
        int fn = size & 1 ? 64 : 32;
        if ((fn == 64 && l) || (opc != 1 && opc != 5 && opc != 9) ||
            (u && opc != 9))
            return 1;
        uint64_t e =
            lane(vr(cpu, rm), fn / 8, fn == 64 ? (int) h : (int) (h << 1 | l));
        set_v(
            cpu, rd,
            fbyelem(
                cpu, opc, u, vr(cpu, rd)[0] & nmask(fn), a & nmask(fn), e, fn
            ),
            0
        );
        return 0;
    }
    if ((i & 0xdf800400) == 0x5f000400) { /* shift by immediate */
        unsigned immh = (i >> 19) & 15, immhb = (i >> 16) & 127,
                 op = (i >> 11) & 31;
        if (op == 0x1c || op == 0x1f) { /* fixed point: s or d */
            if (!(immh & 12)) return 1;
            int fn = immh & 8 ? 64 : 32, fb = 2 * fn - (int) immhb;
            uint64_t x = a & nmask(fn);
            set_v(
                cpu, rd,
                op == 0x1c ? fromfixed(cpu, x, fn, (int) u, fb, fn, fmode(cpu))
                           : tofixed(cpu, x, fn, fb, fn, (int) u, RZ),
                0
            );
            return 0;
        }
        if (!(immh & 8)) return 1;
        int rsh = 128 - (int) immhb, lsh = (int) immhb - 64;
        switch (op) {
            case 0x00:
                set_v(
                    cpu, rd,
                    u ? (rsh >= 64 ? 0 : a >> rsh)
                      : (uint64_t) ((int64_t) a >> (rsh > 63 ? 63 : rsh)),
                    0
                );
                return 0;
            case 0x02: {
                uint64_t r =
                    u ? (rsh >= 64 ? 0 : a >> rsh)
                      : (uint64_t) ((int64_t) a >> (rsh > 63 ? 63 : rsh));
                set_v(cpu, rd, vr(cpu, rd)[0] + r, 0);
                return 0;
            }
            case 0x0a:
                if (u) return 1;
                set_v(cpu, rd, a << lsh, 0);
                return 0;
        }
        return 1;
    }
    if ((i & 0xdfe08400) == 0x5e000400) { /* dup (mov) element to scalar */
        unsigned imm5 = (i >> 16) & 31;
        int sz = __builtin_ctz(imm5 | 32);
        if (sz > 3 || u) return 1;
        int eb = 1 << sz;
        set_v(cpu, rd, lane(vr(cpu, rn), eb, (int) (imm5 >> (sz + 1))), 0);
        return 0;
    }
    if ((i & 0xdf3e0c00) ==
        0x5e300800) { /* pairwise: addp d, faddp, fmax(nm)p */
        unsigned op = (i >> 12) & 31, min = (i >> 23) & 1;
        if (op == 0x1b && !u && size == 3) {
            set_v(cpu, rd, vr(cpu, rn)[0] + vr(cpu, rn)[1], 0);
            return 0;
        }
        if ((op == 0x0c || op == 0x0d || op == 0x0f) && u) {
            int fn = size & 1 ? 64 : 32, f = op == 0x0d ? F_ADD
                                             : op == 0x0c
                                                 ? (min ? F_MINNM : F_MAXNM)
                                                 : (min ? F_MIN : F_MAX);
            if (op == 0x0d && min) return 1;
            uint64_t r = fn == 64
                             ? fop2(cpu, f, vr(cpu, rn)[0], vr(cpu, rn)[1], 64)
                             : fop2(cpu, f, a, a >> 32, 32);
            set_v(cpu, rd, r, 0);
            return 0;
        }
        return 1;
    }
    if ((i & 0xdf3e0c00) == 0x5e200800) { /* two-register misc */
        unsigned op = (i >> 12) & 31;
        if ((op >= 0x0c && op <= 0x0f) || op >= 0x18) { /* floating point */
            int fn = (i >> 22) & 1 ? 64 : 32;
            uint64_t r;
            if (!fmisc(cpu, op, u, (i >> 23) & 1, fn, a & nmask(fn), &r))
                return 1;
            set_v(cpu, rd, r, 0);
            return 0;
        }
        if (op == 0x16 && u && size == 1) { /* fcvtxn s, d: round to odd */
            set_v(cpu, rd, fcvt(cpu, a, 64, 32, RO), 0);
            return 0;
        }
        if (size != 3) return 1;
        int64_t v = (int64_t) a;
        switch (op) {
            case 0x0b:
                set_v(
                    cpu, rd, u ? (uint64_t) -v : (uint64_t) (v < 0 ? -v : v), 0
                );
                return 0;
            case 0x08:
                set_v(cpu, rd, (u ? v >= 0 : v > 0) ? ~0ull : 0, 0);
                return 0;
            case 0x09:
                set_v(cpu, rd, (u ? v <= 0 : v == 0) ? ~0ull : 0, 0);
                return 0;
            case 0x0a:
                if (u) return 1;
                set_v(cpu, rd, v < 0 ? ~0ull : 0, 0);
                return 0;
        }
        return 1;
    }
    if ((i & 0xdf200400) == 0x5e200400) { /* three same */
        unsigned op = (i >> 11) & 31;
        uint64_t r;
        if (op >= 0x18) { /* floating point: sz is bit 22, a bit 23 */
            int fn = (i >> 22) & 1 ? 64 : 32;
            unsigned o = (op << 2) | (u << 1) | ((i >> 23) & 1);
            uint64_t x = a & nmask(fn), y = b & nmask(fn),
                     sg = 1ull << (fn - 1);
            switch (o) {
                case (0x1a << 2) | 3: r = fop2(cpu, F_ABD, x, y, fn); break;
                case (0x1b << 2): r = fop2(cpu, F_MULX, x, y, fn); break;
                case (0x1c << 2): r = fcmpv(cpu, C_EQ, x, y, fn); break;
                case (0x1c << 2) | 2: r = fcmpv(cpu, C_GE, x, y, fn); break;
                case (0x1c << 2) | 3: r = fcmpv(cpu, C_GT, x, y, fn); break;
                case (0x1d << 2) | 2: /* facge facgt */
                case (0x1d << 2) | 3:
                    r = fcmpv(cpu, o & 1 ? C_GT : C_GE, x & ~sg, y & ~sg, fn);
                    break;
                default: return 1;
            }
            set_v(cpu, rd, r, 0);
            return 0;
        }
        if (size != 3) return 1;
        if (!int3(cpu, op, u, 8, a, b, vr(cpu, rd)[0], &r) || op == 0x13)
            return 1;
        set_v(cpu, rd, r, 0);
        return 0;
    }
    return 1;
}
/* #endregion */

/* the writable bits of FPCR and FPSR, as an arm64 host keeps them */
#define FPCR_BITS 0x07ff9f00u
#define FPSR_BITS 0x0800009fu

static int sysreg(struct kb_cpu* cpu, uint32_t i) {
    unsigned rt = i & 31;
    switch (i & ~31u) {
        case 0xd53b4400: set_x(cpu, rt, cpu->fpcr, 1); return 0; /* mrs fpcr */
        case 0xd51b4400:
            cpu->fpcr = (uint32_t) xr(cpu, rt) & FPCR_BITS;
            return 0;
        case 0xd53b4420: set_x(cpu, rt, cpu->fpsr, 1); return 0; /* mrs fpsr */
        case 0xd51b4420:
            cpu->fpsr = (uint32_t) xr(cpu, rt) & FPSR_BITS;
            return 0;
    }
    return 1;
}

int kb_a64v(struct kb_cpu* cpu, const struct kb_ins* x) {
    uint32_t i = (uint32_t) x->imm;
    if ((i & 0xffc00000) == 0xd5000000) return sysreg(cpu, i);
    if ((i >> 26 & 1) && ((i & 0x0a000000) == 0x08000000))
        return load_store(cpu, i, cpu->r[x->b]);
    if ((i & 0x7f000000) == 0x1e000000 || (i & 0x7f000000) == 0x1f000000)
        return fp_scalar(cpu, i);
    if ((i & 0xde000000) == 0x5e000000) return simd_scalar(cpu, i);
    if ((i & 0x9f000000) == 0x0e000000 || (i & 0x9f800000) == 0x0f000000 ||
        (i & 0x9f800000) == 0x0f800000 || (i & 0xbf000000) == 0x2e000000)
        return simd(cpu, i);
    return 1;
}
