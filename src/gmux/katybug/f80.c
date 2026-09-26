#include <math.h>
#include <string.h>

#include "f80.h"

typedef unsigned __int128 u128;

/* unpacked: value = m / 2^127 * 2^e, bit 127 of m set unless zero */
struct un {
    int s;
    int32_t e;
    u128 m;
};

enum
{
    BIAS = 16383
};

static const f80 QNAN = {0xc000000000000000ull, 0xffff};

int f80_c1; /* the last rounding went up in magnitude (the x87's C1 after an
               inexact result) */

int f80_isnan(f80 a) {
    return (a.se & 0x7fff) == 0x7fff && (a.sig << 1) != 0;
}
int f80_isinf(f80 a) {
    return (a.se & 0x7fff) == 0x7fff && (a.sig << 1) == 0;
}
int f80_iszero(f80 a) {
    return (a.se & 0x7fff) == 0 && a.sig == 0;
}
static int sgn(f80 a) {
    return a.se >> 15;
}
static f80 make(int s, int exp, uint64_t sig) {
    return (f80){sig, (uint16_t) ((s << 15) | exp)};
}
static f80 inf(int s) {
    return make(s, 0x7fff, 0x8000000000000000ull);
}
static f80 zero(int s) {
    return make(s, 0, 0);
}
static f80 quiet(f80 a) {
    a.sig |= 0x4000000000000000ull;
    return a;
}

static u128 shr_sticky(u128 m, int n) {
    if (n <= 0) return m;
    if (n >= 128) return m != 0;
    return (m >> n) | ((m & (((u128) 1 << n) - 1)) != 0);
}

static int clz128(u128 m) {
    uint64_t hi = (uint64_t) (m >> 64);
    if (hi) return __builtin_clzll(hi);
    return 64 + __builtin_clzll((uint64_t) m);
}

static struct un unpack(f80 a) {
    struct un u = {sgn(a), 0, 0};
    int exp = a.se & 0x7fff;
    u.m = (u128) a.sig << 64;
    if (!a.sig) return u;
    u.e = (exp ? exp : 1) - BIAS;
    int z = clz128(u.m);
    u.m <<= z;
    u.e -= z;
    return u;
}

/* rounds m (bit 127 set) to 64 bits by the rounding control: 0 nearest, 1 down,
 * 2 up, 3 zero */
static f80 round_pack(int s, int32_t e, u128 m, int rc) {
    if (!m) return zero(s);
    int z = clz128(m);
    m <<= z;
    e -= z;
    int32_t biased = e + BIAS;
    if (biased >= 0x7fff) {
        int to_inf = rc == 0 || (rc == 2 && !s) || (rc == 1 && s);
        f80_c1 = to_inf;
        return to_inf ? inf(s) : make(s, 0x7ffe, ~0ull);
    }
    if (biased <= 0) {
        m = shr_sticky(m, 1 - biased);
        biased = 0;
    }
    uint64_t sig = (uint64_t) (m >> 64), rest = (uint64_t) m;
    int up;
    switch (rc) {
        case 0:
            up = rest > 0x8000000000000000ull ||
                 (rest == 0x8000000000000000ull && (sig & 1));
            break;
        case 1: up = s && rest; break;
        case 2: up = !s && rest; break;
        default: up = 0; break;
    }
    if (up) {
        f80_c1 = 1;
        sig++;
        if (!sig) {
            sig = 0x8000000000000000ull;
            biased++;
            if (biased >= 0x7fff) return inf(s);
        }
    }
    if (biased == 0 && (sig >> 63)) biased = 1;
    return make(s, biased, sig);
}

static f80 nan2(f80 a, f80 b) {
    if (f80_isnan(a) && f80_isnan(b))
        return quiet(
            (a.sig | 0x4000000000000000ull) >= (b.sig | 0x4000000000000000ull)
                ? a
                : b
        );
    if (f80_isnan(a)) return quiet(a);
    return quiet(b);
}

f80 f80_add(f80 a, f80 b, int negate_b, int rc) {
    if (f80_isnan(a) || f80_isnan(b)) return nan2(a, b);
    if (negate_b) b.se ^= 0x8000;
    if (f80_isinf(a)) {
        if (f80_isinf(b) && sgn(a) != sgn(b)) return QNAN;
        return a;
    }
    if (f80_isinf(b)) return b;
    if (f80_iszero(a) && f80_iszero(b))
        return zero(sgn(a) == sgn(b) ? sgn(a) : rc == 1);
    if (f80_iszero(a)) return b;
    if (f80_iszero(b)) return a;
    struct un x = unpack(a), y = unpack(b);
    if (x.e < y.e || (x.e == y.e && x.m < y.m)) {
        struct un t = x;
        x = y;
        y = t;
    }
    x.m = shr_sticky(x.m, 1);
    y.m = shr_sticky(y.m, 1 + (x.e - y.e));
    u128 m;
    if (x.s == y.s)
        m = x.m + y.m;
    else {
        m = x.m - y.m;
        if (!m) return zero(rc == 1);
    }
    return round_pack(x.s, x.e + 1, m, rc);
}

f80 f80_mul(f80 a, f80 b, int rc) {
    int s = sgn(a) ^ sgn(b);
    if (f80_isnan(a) || f80_isnan(b)) return nan2(a, b);
    if (f80_isinf(a) || f80_isinf(b)) {
        if (f80_iszero(a) || f80_iszero(b)) return QNAN;
        return inf(s);
    }
    if (f80_iszero(a) || f80_iszero(b)) return zero(s);
    struct un x = unpack(a), y = unpack(b);
    u128 p = (u128) (uint64_t) (x.m >> 64) * (uint64_t) (y.m >> 64);
    /* p / 2^126 * 2^(ex + ey) */
    return round_pack(s, x.e + y.e + 1, p, rc);
}

f80 f80_div(f80 a, f80 b, int rc, int* zerodiv) {
    int s = sgn(a) ^ sgn(b);
    if (zerodiv) *zerodiv = 0;
    if (f80_isnan(a) || f80_isnan(b)) return nan2(a, b);
    if (f80_isinf(a)) return f80_isinf(b) ? QNAN : inf(s);
    if (f80_isinf(b)) return zero(s);
    if (f80_iszero(b)) {
        if (f80_iszero(a)) return QNAN;
        if (zerodiv) *zerodiv = 1;
        return inf(s);
    }
    if (f80_iszero(a)) return zero(s);
    struct un x = unpack(a), y = unpack(b);
    uint64_t A = (uint64_t) (x.m >> 64), B = (uint64_t) (y.m >> 64);
    u128 n1 = (u128) A << 64;
    u128 q1 = n1 / B, r1 = n1 % B;
    u128 n2 = r1 << 64;
    u128 q2 = n2 / B, r2 = n2 % B;
    u128 m = (q1 << 63) | (q2 >> 1) | ((q2 & 1) || r2);
    return round_pack(s, x.e - y.e, m, rc);
}

static uint64_t isqrt128(u128 n, u128* rem) {
    u128 r = 0, bit = (u128) 1 << 126;
    while (bit > n) bit >>= 2;
    while (bit) {
        if (n >= r + bit) {
            n -= r + bit;
            r = (r >> 1) + bit;
        }
        else
            r >>= 1;
        bit >>= 2;
    }
    *rem = n;
    return (uint64_t) r;
}

f80 f80_sqrt(f80 a, int rc) {
    if (f80_isnan(a)) return quiet(a);
    if (f80_iszero(a)) return a;
    if (sgn(a)) return QNAN;
    if (f80_isinf(a)) return a;
    struct un x = unpack(a);
    uint64_t A = (uint64_t) (x.m >> 64);
    int32_t e = x.e;
    u128 n;
    int32_t E;
    if (e & 1) {
        n = (u128) A << 64;
        E = e + 1;
    }
    else {
        n = (u128) A << 63;
        E = e + 2;
    }
    u128 rem;
    uint64_t r = isqrt128(n, &rem);
    u128 m = (u128) r << 64;
    if (rem > r)
        m |= ((u128) 1 << 63) |
             1; /* above halfway (never exactly: that would be exact) */
    else if (rem)
        m |= 1;
    return round_pack(0, E / 2 - 1, m, rc);
}

/* -1, 0, 1, or 2 when unordered */
int f80_cmp(f80 a, f80 b) {
    if (f80_isnan(a) || f80_isnan(b)) return 2;
    if (f80_iszero(a) && f80_iszero(b)) return 0;
    int sa = sgn(a), sb = sgn(b);
    if (sa != sb) return sa ? -1 : 1;
    int c;
    uint16_t ea = a.se & 0x7fff, eb = b.se & 0x7fff;
    if (ea != eb)
        c = ea < eb ? -1 : 1;
    else if (a.sig != b.sig)
        c = a.sig < b.sig ? -1 : 1;
    else
        c = 0;
    return sa ? -c : c;
}

f80 f80_from_i64(int64_t v) {
    if (!v) return zero(0);
    int s = v < 0;
    uint64_t mag = s ? (uint64_t) 0 - (uint64_t) v : (uint64_t) v;
    int z = __builtin_clzll(mag);
    return make(s, BIAS + 63 - z, mag << z);
}

/* to an integer by the rounding control; *overflow when it does not fit in bits
 */
int64_t f80_to_i64(f80 a, int rc, int bits, int* overflow) {
    int64_t indefinite = bits == 64   ? INT64_MIN
                         : bits == 32 ? INT32_MIN
                                      : INT16_MIN;
    *overflow = 0;
    if (f80_isnan(a) || f80_isinf(a)) {
        *overflow = 1;
        return indefinite;
    }
    if (f80_iszero(a)) return 0;
    struct un x = unpack(a);
    if (x.e >= 64) {
        *overflow = 1;
        return indefinite;
    }
    uint64_t ip;
    int up;
    if (x.e < -1) /* |a| < 1/2 */
    {
        ip = 0;
        up = rc == 1 ? x.s : rc == 2 ? !x.s : 0;
    }
    else if (x.e == -1) /* 1/2 <= |a| < 1 */
    {
        ip = 0;
        int tie = x.m == ((u128) 1 << 127);
        up = rc == 0 ? !tie : rc == 1 ? x.s : rc == 2 ? !x.s : 0;
    }
    else {
        int shift = 127 - x.e; /* 64..127 */
        ip = (uint64_t) (x.m >> shift);
        u128 frac = x.m & (((u128) 1 << shift) - 1),
             half = (u128) 1 << (shift - 1);
        if (!frac)
            up = 0;
        else if (rc == 0)
            up = frac > half || (frac == half && (ip & 1));
        else
            up = rc == 1 ? x.s : rc == 2 ? !x.s : 0;
    }
    if (up) f80_c1 = 1;
    u128 mag = (u128) ip + (uint64_t) up;
    u128 limit = (u128) 1 << (bits - 1);
    if ((!x.s && mag >= limit) || (x.s && mag > limit)) {
        *overflow = 1;
        return indefinite;
    }
    return x.s ? (int64_t) ((uint64_t) 0 - (uint64_t) mag)
               : (int64_t) (uint64_t) mag;
}

f80 f80_from_bits(uint64_t bits, int fbits, int ebits) {
    int s = (int) (bits >> (fbits + ebits));
    int exp = (int) ((bits >> fbits) & ((1u << ebits) - 1));
    uint64_t frac = bits & ((1ull << fbits) - 1);
    int bias = (1 << (ebits - 1)) - 1;
    if (exp == (1 << ebits) - 1) {
        if (!frac) return inf(s);
        return make(s, 0x7fff, 0xc000000000000000ull | (frac << (63 - fbits)));
    }
    if (!exp) {
        if (!frac) return zero(s);
        int z = __builtin_clzll(frac) - (63 - fbits);
        return make(s, BIAS - bias + 1 - z, frac << (63 - fbits + z));
    }
    return make(
        s, exp - bias + BIAS, 0x8000000000000000ull | (frac << (63 - fbits))
    );
}

/* to an IEEE format of fbits fraction bits and ebits exponent bits, rounded by
 * rc */
uint64_t f80_to_bits(f80 a, int fbits, int ebits, int rc) {
    int s = sgn(a);
    uint64_t sbit = (uint64_t) s << (fbits + ebits);
    uint64_t emax = (1ull << ebits) - 1;
    int bias = (1 << (ebits - 1)) - 1;
    if (f80_isnan(a))
        return sbit | (emax << fbits) | (1ull << (fbits - 1)) |
               ((a.sig << 2) >> (66 - fbits));
    if (f80_isinf(a)) return sbit | (emax << fbits);
    if (f80_iszero(a)) return sbit;
    struct un x = unpack(a);
    int32_t biased = x.e + bias;
    u128 m = x.m;
    if (biased <= 0) {
        m = shr_sticky(m, 1 - biased);
        biased = 0;
    }
    int keep = fbits + 1; /* the integer bit and the fraction */
    uint64_t sig = (uint64_t) (m >> (128 - keep));
    u128 rest = m & (((u128) 1 << (128 - keep)) - 1);
    u128 half = (u128) 1 << (127 - keep);
    int up;
    switch (rc) {
        case 0: up = rest > half || (rest == half && (sig & 1)); break;
        case 1: up = s && rest; break;
        case 2: up = !s && rest; break;
        default: up = 0; break;
    }
    if (up) {
        f80_c1 = 1;
        sig++;
        if (sig >> keep) {
            sig >>= 1;
            biased++;
        }
    }
    if (biased == 0 && (sig >> fbits)) biased = 1;
    if ((uint64_t) biased >= emax) {
        int to_inf = rc == 0 || (rc == 2 && !s) || (rc == 1 && s);
        return to_inf ? sbit | (emax << fbits)
                      : sbit | ((emax - 1) << fbits) | ((1ull << fbits) - 1);
    }
    return sbit | ((uint64_t) biased << fbits) | (sig & ((1ull << fbits) - 1));
}

f80 f80_round_int(f80 a, int rc) {
    if (f80_isnan(a) || f80_isinf(a) || f80_iszero(a)) return a;
    struct un x = unpack(a);
    if (x.e >= 63) return a;
    int of;
    int64_t v = f80_to_i64(a, rc, 64, &of);
    f80 r = f80_from_i64(v);
    if (!v) return zero(x.s);
    return r;
}

f80 f80_scale(f80 a, f80 b, int rc) {
    if (f80_isnan(a) || f80_isnan(b)) return nan2(a, b);
    if (f80_isinf(b) && (f80_iszero(a) ? !sgn(b) : f80_isinf(a) && sgn(b)))
        return QNAN; /* 0 * 2^inf, inf / 2^inf */
    if (f80_iszero(a) || f80_isinf(a)) return a;
    if (f80_isinf(b))
        return sgn(b) ? zero(sgn(a))
                      : inf(sgn(a)); /* exact: no overflow, no C1 */
    int of = 0, c1 = f80_c1;
    int64_t n = f80_to_i64(b, 3, 64, &of);
    f80_c1 = c1;
    if (of) n = sgn(b) ? -100000 : 100000;
    if (n > 100000) n = 100000;
    if (n < -100000) n = -100000;
    struct un x = unpack(a);
    return round_pack(x.s, x.e + (int32_t) n, x.m, rc);
}

/* the remainder with a truncated (fprem) or nearest (fprem1) quotient; q gets
   the quotient's low 3 bits, or -1 for a partial remainder (exponents 64+
   apart: the x87 reduces by 32 + d % 32 bits with a truncated quotient and sets
   C2, as AMD documents and Intel does) */
f80 f80_rem(f80 a, f80 b, int nearest, int* q) {
    *q = 0;
    if (f80_isnan(a) || f80_isnan(b)) return nan2(a, b);
    if (f80_isinf(a) || f80_iszero(b)) return QNAN;
    if (f80_iszero(a) || f80_isinf(b)) return a;
    struct un x = unpack(a), y = unpack(b);
    uint64_t A = (uint64_t) (x.m >> 64), B = (uint64_t) (y.m >> 64);
    int32_t d = x.e - y.e;
    int s = x.s;
    if (d < 0) {
        /* the quotient truncates to 0; to nearest it is 1 only when |a| > |b| /
         * 2 */
        if (!nearest || d < -1 || A <= B) return a;
        *q = 1;
        return round_pack(!s, y.e - 1, ((u128) (2 * (u128) B - A)) << 64, 0);
    }
    u128 r = A;
    uint64_t quo = 0;
    int32_t n = d >= 64 ? 32 + d % 32 : d;
    for (int32_t k = n; k >= 0; k--) {
        quo <<= 1;
        if (r >= B) {
            r -= B;
            quo |= 1;
        }
        if (k) r <<= 1;
    }
    if (n != d) {
        *q = -1;
        return r ? round_pack(s, y.e + d - n, r << 64, 0) : zero(x.s);
    }
    if (nearest && (r << 1 > B || (r << 1 == B && (quo & 1)))) {
        r = B - r;
        s = !s;
        quo++;
    }
    *q = (int) (quo & 7);
    if (!r) return zero(x.s);
    return round_pack(s, y.e, r << 64, 0);
}
