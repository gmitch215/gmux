#include <math.h>
#include <string.h>

#include "libm.h"

/*
 * exp, log and pow for the guests' libm calls: musl 1.2.5's src/math/exp.c,
 * log.c and pow.c reduced to the paths that return a normal finite value
 * (Copyright (c) 2018, Arm Limited, SPDX-License-Identifier: MIT). glibc 2.36
 * and 2.39 run the same arithmetic on those paths; the differences are
 * tabulated in tests/c/katybug/libm-tables.txt. Every other input gives up and
 * the guest's code runs. A fused multiply-add anywhere would change bits, so
 * the file asks the compiler not to contract and kb_libm_ok checks that it did
 */
#if defined(__clang__)
    #pragma STDC FP_CONTRACT OFF
#elif defined(__GNUC__)
    #pragma GCC optimize("fp-contract=off")
#endif

static inline uint64_t asuint64(double f) {
    uint64_t i;
    memcpy(&i, &f, sizeof i);
    return i;
}

static inline double asdouble(uint64_t i) {
    double f;
    memcpy(&f, &i, sizeof f);
    return f;
}

static inline uint32_t top12(double x) {
    return (uint32_t) (asuint64(x) >> 52);
}

static inline int normal(double y) {
    return isnormal(y);
}

int kb_libm_ok(void) {
    volatile double a = 1.0 + 0x1p-27, b = 1.0 - 0x1p-27, c = -1.0;
    return a * b + c == 0.0;
}

#define EN (1 << EXP_TABLE_BITS)
#define InvLn2N kb_exp_data.invln2N
#define NegLn2hiN kb_exp_data.negln2hiN
#define NegLn2loN kb_exp_data.negln2loN
#define Shift kb_exp_data.shift
#define ET kb_exp_data.tab
#define C2 kb_exp_data.poly[5 - EXP_POLY_ORDER]
#define C3 kb_exp_data.poly[6 - EXP_POLY_ORDER]
#define C4 kb_exp_data.poly[7 - EXP_POLY_ORDER]
#define C5 kb_exp_data.poly[8 - EXP_POLY_ORDER]

/* a tie in z = InvLn2N * x rounds one way as x + shift does and the other as
 * round does (AArch64 glibc); musl and x86-64 glibc agree with each other */
static inline int tie(double z) {
    return z - floor(z) == 0.5;
}

/* scale * (1 + tmp) with the exponent adjustment of the large |x| arguments;
 * 0 when the result overflows or reaches the subnormal range */
static int scaled(double tmp, uint64_t sbits, uint64_t ki, double* y) {
    double scale, v;
    if ((ki & 0x80000000) == 0) {
        sbits -= 1009ull << 52;
        scale = asdouble(sbits);
        v = 0x1p1009 * (scale + scale * tmp);
        if (!isfinite(v)) return 0;
        return *y = v, 1;
    }
    sbits += 1022ull << 52;
    scale = asdouble(sbits);
    v = scale + scale * tmp;
    if (fabs(v) < 1.0) return 0;
    return *y = 0x1p-1022 * v, 1;
}

int kb_libm_exp(double x, int fused, double* out) {
    (void) fused;
    uint32_t abstop = top12(x) & 0x7ff;
    if (abstop < 0x3c9 || abstop >= 0x409) return 0;
    double z = InvLn2N * x;
    if (tie(z)) return 0;
    double kd = z + Shift;
    uint64_t ki = asuint64(kd);
    kd -= Shift;
    double r = x + kd * NegLn2hiN + kd * NegLn2loN;
    uint64_t idx = 2 * (ki % EN);
    uint64_t top = ki << (52 - EXP_TABLE_BITS);
    double tail = asdouble(ET[idx]);
    uint64_t sbits = ET[idx + 1] + top;
    double r2 = r * r;
    double tmp = tail + r + r2 * (C2 + r * C3) + r2 * r2 * (C4 + r * C5);
    double y;
    if (abstop == 0x408) {
        if (!scaled(tmp, sbits, ki, &y)) return 0;
    }
    else {
        double scale = asdouble(sbits);
        y = scale + scale * tmp;
    }
    if (!normal(y)) return 0;
    return *out = y, 1;
}

#define LT kb_log_data.tab
#define LT2 kb_log_data.tab2
#define LB kb_log_data.poly1
#define LA kb_log_data.poly
#define Ln2hi kb_log_data.ln2hi
#define Ln2lo kb_log_data.ln2lo
#define LN (1 << LOG_TABLE_BITS)
#define LOFF 0x3fe6000000000000

int kb_libm_log(double x, int fused, double* out) {
    uint64_t ix = asuint64(x), iz, tmp;
    uint32_t top = (uint32_t) (ix >> 48);
    double w, z, r, r2, r3, y, invc, logc, kd, hi, lo;
    int k, i;
#define LO asuint64(1.0 - 0x1p-4)
#define HI asuint64(1.0 + 0x1.09p-4)
    if (ix - LO < HI - LO) {
        if (ix == asuint64(1.0)) return 0;
        r = x - 1.0;
        r2 = r * r;
        r3 = r * r2;
        y = r3 * (LB[1] + r * LB[2] + r2 * LB[3] +
                  r3 * (LB[4] + r * LB[5] + r2 * LB[6] +
                        r3 * (LB[7] + r * LB[8] + r2 * LB[9] + r3 * LB[10])));
        w = r * 0x1p27;
        double rhi = r + w - w;
        double rlo = r - rhi;
        w = rhi * rhi * LB[0];
        hi = r + w;
        lo = r - hi + w;
        lo += LB[0] * rlo * (rhi + r);
        y += lo;
        y += hi;
        if (!normal(y)) return 0;
        return *out = y, 1;
    }
    if (top - 0x0010 >= 0x7ff0 - 0x0010) return 0;
    tmp = ix - LOFF;
    i = (int) ((tmp >> (52 - LOG_TABLE_BITS)) % LN);
    k = (int) ((int64_t) tmp >> 52);
    iz = ix - (tmp & 0xfffULL << 52);
    invc = LT[i].invc;
    logc = LT[i].logc;
    z = asdouble(iz);
    if (fused)
        r = fma(z, invc, -1.0);
    else
        r = (z - LT2[i].chi - LT2[i].clo) * invc;
    kd = (double) k;
    w = kd * Ln2hi + logc;
    hi = w + r;
    lo = w - hi + r + kd * Ln2lo;
    r2 = r * r;
    y = lo + r2 * LA[0] +
        r * r2 * (LA[1] + r * LA[2] + r2 * (LA[3] + r * LA[4])) + hi;
    if (!normal(y)) return 0;
    return *out = y, 1;
}

#define PT kb_pow_log_data.tab
#define PA kb_pow_log_data.poly
#define PLn2hi kb_pow_log_data.ln2hi
#define PLn2lo kb_pow_log_data.ln2lo
#define PN (1 << POW_LOG_TABLE_BITS)
#define POFF 0x3fe6955500000000
#define SIGN_BIAS (0x800 << EXP_TABLE_BITS)

static double log_inline(uint64_t ix, int fused, double* tail) {
    double z, r, y, invc, logc, logctail, kd, hi, t1, t2, lo, lo1, lo2, p;
    uint64_t iz, tmp;
    int k, i;
    tmp = ix - POFF;
    i = (int) ((tmp >> (52 - POW_LOG_TABLE_BITS)) % PN);
    k = (int) ((int64_t) tmp >> 52);
    iz = ix - (tmp & 0xfffULL << 52);
    z = asdouble(iz);
    kd = (double) k;
    invc = PT[i].invc;
    logc = PT[i].logc;
    logctail = PT[i].logctail;
    double zhi = asdouble((iz + (1ULL << 31)) & (-1ULL << 32));
    double zlo = z - zhi;
    double rhi = zhi * invc - 1.0;
    double rlo = zlo * invc;
    r = fused ? fma(z, invc, -1.0) : rhi + rlo;
    t1 = kd * PLn2hi + logc;
    t2 = t1 + r;
    lo1 = kd * PLn2lo + logctail;
    lo2 = t1 - t2 + r;
    double ar, ar2, ar3, lo3, lo4;
    ar = PA[0] * r;
    ar2 = r * ar;
    ar3 = r * ar2;
    if (fused) {
        hi = t2 + ar2;
        lo3 = fma(ar, r, -ar2);
        lo4 = t2 - hi + ar2;
    }
    else {
        double arhi = PA[0] * rhi;
        double arhi2 = rhi * arhi;
        hi = t2 + arhi2;
        lo3 = rlo * (ar + arhi);
        lo4 = t2 - hi + arhi2;
    }
    p =
        (ar3 * (PA[1] + r * PA[2] +
                ar2 * (PA[3] + r * PA[4] + ar2 * (PA[5] + r * PA[6]))));
    lo = lo1 + lo2 + lo3 + lo4 + p;
    y = hi + lo;
    *tail = hi - y + lo;
    return y;
}

static int exp_inline(double x, double xtail, uint32_t sign_bias, double* out) {
    uint32_t abstop = top12(x) & 0x7ff;
    if (abstop < 0x3c9 || abstop >= 0x409) return 0;
    double z = InvLn2N * x;
    if (tie(z)) return 0;
    double kd = z + Shift;
    uint64_t ki = asuint64(kd);
    kd -= Shift;
    double r = x + kd * NegLn2hiN + kd * NegLn2loN;
    r += xtail;
    uint64_t idx = 2 * (ki % EN);
    uint64_t top = (ki + sign_bias) << (52 - EXP_TABLE_BITS);
    double tail = asdouble(ET[idx]);
    uint64_t sbits = ET[idx + 1] + top;
    double r2 = r * r;
    double tmp = tail + r + r2 * (C2 + r * C3) + r2 * r2 * (C4 + r * C5);
    double y;
    if (abstop == 0x408) {
        if (!scaled(tmp, sbits, ki, &y)) return 0;
    }
    else {
        double scale = asdouble(sbits);
        y = scale + scale * tmp;
    }
    if (!normal(y)) return 0;
    return *out = y, 1;
}

static inline int checkint(uint64_t iy) {
    int e = (int) (iy >> 52 & 0x7ff);
    if (e < 0x3ff) return 0;
    if (e > 0x3ff + 52) return 2;
    if (iy & ((1ULL << (0x3ff + 52 - e)) - 1)) return 0;
    if (iy & (1ULL << (0x3ff + 52 - e))) return 1;
    return 2;
}

int kb_libm_pow(double x, double y, int fused, double* out) {
    uint32_t sign_bias = 0;
    uint64_t ix = asuint64(x), iy = asuint64(y);
    uint32_t topx = top12(x), topy = top12(y);
    if ((topy & 0x7ff) - 0x3be >= 0x43e - 0x3be) return 0;
    if (topx - 0x001 >= 0x7ff - 0x001) {
        if (!(topx & 0x800) || (topx & 0x7ff) == 0 || (topx & 0x7ff) == 0x7ff)
            return 0;
        int yint = checkint(iy);
        if (yint == 0) return 0;
        if (yint == 1) sign_bias = SIGN_BIAS;
        ix &= 0x7fffffffffffffff;
    }
    if (ix == asuint64(1.0)) return 0;
    double lo;
    double hi = log_inline(ix, fused, &lo);
    double ehi, elo;
    if (fused) {
        ehi = y * hi;
        elo = y * lo + fma(y, hi, -ehi);
    }
    else {
        double yhi = asdouble(iy & -1ULL << 27);
        double ylo = y - yhi;
        double lhi = asdouble(asuint64(hi) & -1ULL << 27);
        double llo = hi - lhi + lo;
        ehi = yhi * lhi;
        elo = ylo * lhi + y * llo;
    }
    return exp_inline(ehi, elo, sign_bias, out);
}
