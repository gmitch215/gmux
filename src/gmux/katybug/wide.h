#ifndef KB_WIDE_H
#define KB_WIDE_H

#include <stdint.h>

/* 128-bit products and quotients in 64-bit halves: in wasm, __int128 turns
 * them into compiler-rt calls (__multi3, __udivti3, __divti3) */

/** the high half of a * b; the low half is a * b (natively one instruction) */
static inline uint64_t kb_umulh(uint64_t a, uint64_t b) {
#ifdef __wasm__
    uint64_t a0 = (uint32_t) a, a1 = a >> 32, b0 = (uint32_t) b, b1 = b >> 32;
    uint64_t p01 = a0 * b1, p10 = a1 * b0;
    uint64_t mid = ((a0 * b0) >> 32) + (uint32_t) p01 + (uint32_t) p10;
    return a1 * b1 + (p01 >> 32) + (p10 >> 32) + (mid >> 32);
#else
    return (uint64_t) (((unsigned __int128) a * b) >> 64);
#endif
}

static inline uint64_t kb_smulh(uint64_t a, uint64_t b) {
    return kb_umulh(a, b) - ((int64_t) a < 0 ? b : 0) -
           ((int64_t) b < 0 ? a : 0);
}

static inline int64_t kb_sext_w(uint64_t v, int w) {
    return w == 1   ? (int8_t) v
           : w == 2 ? (int16_t) v
           : w == 4 ? (int32_t) v
                    : (int64_t) v;
}

/** x86 mul (signed 0) or imul (1) of rax (al for bytes) by v, w bytes wide,
 * into rdx:rax (ax); 1 when the high half is significant (CF and OF) */
/* inlined whole: the width and kind are constants at each lifted site */
static inline __attribute__((always_inline)) int kb_mul(
    int sgn, int w, uint64_t* rax, uint64_t* rdx, uint64_t v
) {
    int bits = 8 * w;
    uint64_t m = w == 8 ? ~0ull : (1ull << bits) - 1, lo, hi;
    int ov;
    if (w == 8) {
        lo = *rax * v;
        hi = sgn ? kb_smulh(*rax, v) : kb_umulh(*rax, v);
        ov = hi != (sgn ? (uint64_t) ((int64_t) lo >> 63) : 0);
    }
    else if (!sgn) {
        uint64_t p = (*rax & m) * (v & m);
        lo = p & m;
        hi = (p >> bits) & m;
        ov = hi != 0;
    }
    else {
        int64_t p = kb_sext_w(*rax, w) * kb_sext_w(v, w);
        lo = (uint64_t) p & m;
        hi = (uint64_t) (p >> bits) & m;
        ov = p != kb_sext_w(lo, w);
    }
    if (w == 1)
        *rax = (*rax & ~0xffffull) | (hi << 8) | lo;
    else if (w == 2) {
        *rax = (*rax & ~0xffffull) | lo;
        *rdx = (*rdx & ~0xffffull) | hi;
    }
    else {
        *rax = lo;
        *rdx = hi;
    }
    return ov;
}

/* u1:u0 / v for u1 < v, remainder in *rem (Hacker's Delight divlu) */
static __attribute__((noinline, unused)) uint64_t
kb_divlu(uint64_t u1, uint64_t u0, uint64_t v, uint64_t* rem) {
    const uint64_t b = 1ull << 32;
    int s = __builtin_clzll(v);
    v <<= s;
    uint64_t vn1 = v >> 32, vn0 = v & 0xffffffff;
    uint64_t un32 = s ? (u1 << s) | (u0 >> (64 - s)) : u1, un10 = u0 << s;
    uint64_t un1 = un10 >> 32, un0 = un10 & 0xffffffff;
    uint64_t q1 = un32 / vn1, rhat = un32 - q1 * vn1;
    while (q1 >= b || q1 * vn0 > b * rhat + un1) {
        q1--;
        rhat += vn1;
        if (rhat >= b) break;
    }
    uint64_t un21 = un32 * b + un1 - q1 * v;
    uint64_t q0 = un21 / vn1;
    rhat = un21 - q0 * vn1;
    while (q0 >= b || q0 * vn0 > b * rhat + un0) {
        q0--;
        rhat += vn1;
        if (rhat >= b) break;
    }
    *rem = (un21 * b + un0 - q0 * v) >> s;
    return q1 * b + q0;
}

/** x86 div (signed 0) or idiv (1) of rdx:rax (ax for bytes) by v, w bytes
 * wide, into *rax and *rdx; 1 for a divide error (a zero divisor, or a
 * quotient wider than w), which leaves both as they were */
static inline __attribute__((always_inline)) int kb_divide(
    int sgn, int w, uint64_t* rax, uint64_t* rdx, uint64_t v
) {
    int bits = 8 * w;
    uint64_t m = w == 8 ? ~0ull : (1ull << bits) - 1;
    if ((v & m) == 0) return 1;
    uint64_t q, rem;
    if (w < 8) {
        uint64_t n = w == 1 ? *rax & 0xffff : ((*rdx & m) << bits) | (*rax & m);
        if (!sgn) {
            q = n / (v & m);
            rem = n % (v & m);
            if (q > m) return 1;
        }
        else {
            int64_t sn = kb_sext_w(n, 2 * w), d = kb_sext_w(v, w);
            if (d == -1 && sn == INT64_MIN) return 1;
            int64_t sq = sn / d, lim = (int64_t) 1 << (bits - 1);
            if (sq < -lim || sq >= lim) return 1;
            q = (uint64_t) sq & m;
            rem = (uint64_t) (sn % d) & m;
        }
    }
    else if (!sgn && *rdx == 0) {
        q = *rax / v;
        rem = *rax % v;
    }
    else if (!sgn) {
        if (*rdx >= v) return 1;
        q = kb_divlu(*rdx, *rax, v, &rem);
    }
    else if (*rdx == (uint64_t) ((int64_t) *rax >> 63)) {
        /* a dividend that fits 64 bits: only min / -1 overflows */
        if ((int64_t) v == -1 && *rax == 1ull << 63) return 1;
        q = (uint64_t) ((int64_t) *rax / (int64_t) v);
        rem = (uint64_t) ((int64_t) *rax % (int64_t) v);
    }
    else {
        /* on magnitudes: the quotient's sign is the operands', the
         * remainder's the dividend's */
        int nn = (int64_t) *rdx < 0, nd = (int64_t) v < 0;
        uint64_t hi = *rdx, lo = *rax, d = nd ? -v : v;
        if (nn) {
            hi = ~hi + (lo == 0);
            lo = -lo;
        }
        if (hi >= d) return 1;
        q = kb_divlu(hi, lo, d, &rem);
        if (q > (nn != nd ? 1ull << 63 : (1ull << 63) - 1)) return 1;
        if (nn != nd) q = -q;
        if (nn) rem = -rem;
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

#endif
