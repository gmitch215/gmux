#include <math.h>
#include <string.h>

#include "kb.h"

typedef struct {
    uint64_t q[2];
} v128;

static v128 xload(struct kb_cpu* cpu, const struct kb_ins* x, int bytes) {
    v128 v = {{0, 0}};
    if (x->c & 0x80) {
        uint64_t a = cpu->r[x->b];
        if (bytes >= 8)
            v.q[0] = kb_load(cpu, a, 8);
        else
            v.q[0] = kb_load(cpu, a, bytes);
        if (bytes == 16) v.q[1] = kb_load(cpu, a + 8, 8);
    }
    else
        memcpy(&v, cpu->x[x->c & 15], 16);
    return v;
}

static void xstore(
    struct kb_cpu* cpu, const struct kb_ins* x, v128 v, int bytes
) {
    if (x->c & 0x80) {
        uint64_t a = cpu->r[x->b];
        kb_store(cpu, a, v.q[0], bytes >= 8 ? 8 : bytes);
        if (bytes == 16) kb_store(cpu, a + 8, v.q[1], 8);
    }
    else if (bytes == 16)
        memcpy(cpu->x[x->c & 15], &v, 16);
    else if (bytes == 8)
        cpu->x[x->c & 15][0] = v.q[0];
    else
        cpu->x[x->c & 15][0] =
            (cpu->x[x->c & 15][0] & ~0xffffffffull) | (v.q[0] & 0xffffffff);
}

/* the r/m operand as a GPR (for movd/movq, cvtsi2sd and friends) */
static uint64_t gpr_or_mem(
    struct kb_cpu* cpu, const struct kb_ins* x, int bytes
) {
    if (x->c & 0x80) return kb_load(cpu, cpu->r[x->b], bytes);
    uint64_t v = cpu->r[x->c & 15];
    return bytes == 8 ? v : v & 0xffffffffull;
}

static double d(uint64_t q) {
    double v;
    memcpy(&v, &q, 8);
    return v;
}
static uint64_t q(double v) {
    uint64_t r;
    memcpy(&r, &v, 8);
    return r;
}
static float f(uint32_t u) {
    float v;
    memcpy(&v, &u, 4);
    return v;
}
static uint32_t u(float v) {
    uint32_t r;
    memcpy(&r, &v, 4);
    return r;
}

static void compare(struct kb_cpu* cpu, double a, double b) {
    cpu->n = cpu->v = 0;
    if (isnan(a) || isnan(b))
        cpu->z = cpu->p = cpu->c = 1;
    else {
        cpu->z = a == b;
        cpu->p = 0;
        cpu->c = a < b;
    }
}

/* truncating conversion with x86's integer indefinite for NaN and out of range
 */
static int64_t trunc_to(double v, int w) {
    double lim = w == 8 ? 9223372036854775808.0 : 2147483648.0;
    if (isnan(v) || v >= lim || v < -lim) return w == 8 ? INT64_MIN : INT32_MIN;
    return (int64_t) v;
}

/* SSE arithmetic at the bit level for NaNs, which host floats (ARM, wasm) do
   not propagate the x86 way: a NaN operand comes back quieted (the
   destination's first), min/max return the source untouched when either is NaN,
   and an invalid result is the negative default NaN */
static uint64_t op64(int op, uint64_t a, uint64_t b) {
    double x = d(a), y = d(b);
    const uint64_t quiet = 1ull << 51, dflt = 0xfff8000000000000ull;
    if (op == 0x5d) return x < y ? a : b;
    if (op == 0x5f) return x > y ? a : b;
    if (op == 0x51) {
        if (isnan(y)) return b | quiet;
        return y < 0 ? dflt : q(sqrt(y));
    }
    if (isnan(x)) return a | quiet;
    if (isnan(y)) return b | quiet;
    double r = op == 0x58   ? x + y
               : op == 0x59 ? x * y
               : op == 0x5c ? x - y
                            : x / y;
    return isnan(r) ? dflt : q(r);
}

static uint32_t op32(int op, uint32_t a, uint32_t b) {
    float x = f(a), y = f(b);
    const uint32_t quiet = 1u << 22, dflt = 0xffc00000u;
    if (op == 0x5d) return x < y ? a : b;
    if (op == 0x5f) return x > y ? a : b;
    if (op == 0x51) {
        if (isnan(y)) return b | quiet;
        return y < 0 ? dflt : u(sqrtf(y));
    }
    if (isnan(x)) return a | quiet;
    if (isnan(y)) return b | quiet;
    float r = op == 0x58   ? x + y
              : op == 0x59 ? x * y
              : op == 0x5c ? x - y
                           : x / y;
    return isnan(r) ? dflt : u(r);
}

static v128 lanes32(v128 a, v128 b, int op) {
    v128 r;
    for (int i = 0; i < 4; i++) {
        uint32_t x = (uint32_t) (a.q[i / 2] >> (32 * (i & 1)));
        uint32_t y = (uint32_t) (b.q[i / 2] >> (32 * (i & 1)));
        uint32_t z;
        switch (op) {
            case 0xfe: z = x + y; break;
            case 0xfa: z = x - y; break;
            case 0x66: z = (int32_t) x > (int32_t) y ? ~0u : 0; break;
            case 0x76: z = x == y ? ~0u : 0; break;
            default: z = 0; break;
        }
        if (i & 1)
            r.q[i / 2] |= (uint64_t) z << 32;
        else
            r.q[i / 2] = z;
    }
    return r;
}

static v128 lanes8(v128 a, v128 b, int op) {
    uint8_t x[16], y[16], z[16];
    memcpy(x, &a, 16);
    memcpy(y, &b, 16);
    for (int i = 0; i < 16; i++) {
        switch (op) {
            case 0x74: z[i] = x[i] == y[i] ? 0xff : 0; break;
            case 0x64: z[i] = (int8_t) x[i] > (int8_t) y[i] ? 0xff : 0; break;
            case 0xfc: z[i] = (uint8_t) (x[i] + y[i]); break;
            case 0xf8: z[i] = (uint8_t) (x[i] - y[i]); break;
            case 0xda: z[i] = x[i] < y[i] ? x[i] : y[i]; break;
            case 0xde: z[i] = x[i] > y[i] ? x[i] : y[i]; break;
            default: z[i] = 0; break;
        }
    }
    v128 r;
    memcpy(&r, z, 16);
    return r;
}

static v128 lanes16(v128 a, v128 b, int op) {
    uint16_t x[8], y[8], z[8];
    memcpy(x, &a, 16);
    memcpy(y, &b, 16);
    for (int i = 0; i < 8; i++) {
        switch (op) {
            case 0x75: z[i] = x[i] == y[i] ? 0xffff : 0; break;
            case 0x65:
                z[i] = (int16_t) x[i] > (int16_t) y[i] ? 0xffff : 0;
                break;
            case 0xfd: z[i] = (uint16_t) (x[i] + y[i]); break;
            case 0xf9: z[i] = (uint16_t) (x[i] - y[i]); break;
            default: z[i] = 0; break;
        }
    }
    v128 r;
    memcpy(&r, z, 16);
    return r;
}

/* shifts of lanes of width lw by n bits (right logical, right arithmetic, left)
 */
static v128 shift(v128 v, int lw, unsigned n, int kind) {
    v128 r = {{0, 0}};
    int count = 16 / lw;
    for (int i = 0; i < count; i++) {
        uint64_t x = 0;
        memcpy(&x, (uint8_t*) &v + i * lw, (size_t) lw);
        uint64_t y;
        int bits = 8 * lw;
        if (kind == 0)
            y = n >= (unsigned) bits ? 0 : x >> n;
        else if (kind == 2)
            y = n >= (unsigned) bits ? 0 : x << n;
        else {
            int64_t sx = (int64_t) (x << (64 - bits)) >> (64 - bits);
            y = (uint64_t) (sx >> (n >= (unsigned) bits ? bits - 1 : (int) n));
        }
        memcpy((uint8_t*) &r + i * lw, &y, (size_t) lw);
    }
    return r;
}

static v128 byteshift(v128 v, unsigned n, int left) {
    uint8_t in[16], out[16] = {0};
    memcpy(in, &v, 16);
    if (n > 16) n = 16;
    for (int i = 0; i < 16; i++) {
        int from = left ? i - (int) n : i + (int) n;
        if (from >= 0 && from < 16) out[i] = in[from];
    }
    v128 r;
    memcpy(&r, out, 16);
    return r;
}

static uint32_t lane(v128 v, int i) {
    return (uint32_t) (v.q[i / 2] >> (32 * (i & 1)));
}
static void setlane(v128* v, int i, uint32_t x) {
    uint64_t m = 0xffffffffull << (32 * (i & 1));
    v->q[i / 2] = (v->q[i / 2] & ~m) | ((uint64_t) x << (32 * (i & 1)));
}

/** one SSE/SSE2 instruction; 0, or -1 for one katybug does not know */
int kb_sse(struct kb_cpu* cpu, const struct kb_ins* x) {
    int pre = (int) ((x->imm >> 8) & 0xff), op = (int) (x->imm & 0xff),
        ext = (int) ((x->imm >> 16) & 0xff);
    int rex_w = x->w == 8;
    uint64_t* dst = cpu->x[x->a & 15];
    v128 dv;
    memcpy(&dv, dst, 16);
#define PUT(v) memcpy(dst, &(v), 16)
    if (op == 0xae) {
        /* fxsave fxrstor ldmxcsr stmxcsr clflush; lfence mfence sfence (one
         * thread: nothing to order) */
        int reg = x->a & 7;
        uint64_t at = cpu->r[x->b];
        if (pre) return -1;
        if (!(x->c & 0x80)) return reg >= 5 ? 0 : -1;
        switch (reg) {
            case 0: kb_fxsave(cpu, at); return 0;
            case 1: kb_fxrstor(cpu, at); return 0;
            case 2:
                cpu->mxcsr = (uint32_t) kb_load(cpu, at, 4) & 0xffff;
                return 0;
            case 3: kb_store(cpu, at, cpu->mxcsr, 4); return 0;
            case 7: return 0;
        }
        return -1;
    }
    switch (op) {
        case 0x10:
        case 0x28:
        case 0x6f: /* loads: movups movupd movss movsd movaps movapd movdqa
                      movdqu */
            if (op == 0x10 && (pre == 0xf3 || pre == 0xf2)) {
                int bytes = pre == 0xf3 ? 4 : 8;
                v128 s = xload(cpu, x, bytes);
                if (x->c & 0x80) /* from memory: the rest cleared */
                {
                    v128 z = {
                        {s.q[0] & (bytes == 4 ? 0xffffffffull : ~0ull), 0}
                    };
                    PUT(z);
                }
                else if (bytes == 8)
                    dst[0] = s.q[0];
                else
                    dst[0] = (dst[0] & ~0xffffffffull) | (s.q[0] & 0xffffffff);
                return 0;
            }
            if (op == 0x6f && pre == 0) return -1; /* mmx */
            {
                v128 s = xload(cpu, x, 16);
                PUT(s);
            }
            return 0;
        case 0x11:
        case 0x29:
        case 0x7f: /* stores */
            if (op == 0x11 && (pre == 0xf3 || pre == 0xf2)) {
                v128 s = {{dst[0], 0}};
                xstore(cpu, x, s, pre == 0xf3 ? 4 : 8);
                return 0;
            }
            if (op == 0x7f && pre == 0) return -1;
            xstore(cpu, x, dv, 16);
            return 0;
        case 0x12: /* movhlps (register form), movlps/movlpd from memory */
            if (x->c & 0x80)
                dst[0] = kb_load(cpu, cpu->r[x->b], 8);
            else
                dst[0] = cpu->x[x->c & 15][1];
            return 0;
        case 0x16: /* movlhps (register), movhps/movhpd from memory */
            if (x->c & 0x80)
                dst[1] = kb_load(cpu, cpu->r[x->b], 8);
            else
                dst[1] = cpu->x[x->c & 15][0];
            return 0;
        case 0x13:
        case 0x17: /* movlps/movhps stores */
            if (!(x->c & 0x80)) return -1;
            kb_store(cpu, cpu->r[x->b], dst[op == 0x17], 8);
            return 0;
        case 0x14: /* unpcklps, unpcklpd */
        {
            v128 s = xload(cpu, x, 16);
            v128 r;
            if (pre == 0x66)
                r = (v128){{dv.q[0], s.q[0]}};
            else {
                r = dv;
                setlane(&r, 0, lane(dv, 0));
                setlane(&r, 1, lane(s, 0));
                setlane(&r, 2, lane(dv, 1));
                setlane(&r, 3, lane(s, 1));
            }
            PUT(r);
            return 0;
        }
        case 0x15: /* unpckhpd */
        {
            if (pre != 0x66) return -1;
            v128 s = xload(cpu, x, 16);
            v128 r = {{dv.q[1], s.q[1]}};
            PUT(r);
            return 0;
        }
        case 0x2a: /* cvtsi2ss, cvtsi2sd */
        {
            int64_t v = rex_w ? (int64_t) gpr_or_mem(cpu, x, 8)
                              : (int32_t) gpr_or_mem(cpu, x, 4);
            if (pre == 0xf2)
                dst[0] = q((double) v);
            else if (pre == 0xf3)
                dst[0] = (dst[0] & ~0xffffffffull) | u((float) v);
            else
                return -1;
            return 0;
        }
        case 0x2c:
        case 0x2d: /* cvttss2si, cvttsd2si (and the rounding forms, as
                      truncation) */
        {
            double v = pre == 0xf2
                           ? d(xload(cpu, x, 8).q[0])
                           : (double) f((uint32_t) xload(cpu, x, 4).q[0]);
            if (op == 0x2d) v = nearbyint(v);
            int64_t r = trunc_to(v, rex_w ? 8 : 4);
            cpu->r[x->a & 15] = rex_w ? (uint64_t) r : (uint64_t) (uint32_t) r;
            return 0;
        }
        case 0x2e:
        case 0x2f: /* ucomiss comiss ucomisd comisd */
            if (pre == 0x66)
                compare(cpu, d(dst[0]), d(xload(cpu, x, 8).q[0]));
            else
                compare(
                    cpu, f((uint32_t) dst[0]),
                    f((uint32_t) xload(cpu, x, 4).q[0])
                );
            return 0;
        case 0x50: /* movmskps, movmskpd */
        {
            v128 s = xload(cpu, x, 16);
            uint64_t m = pre == 0x66 ? ((s.q[0] >> 63) | ((s.q[1] >> 63) << 1))
                                     : ((uint64_t) (lane(s, 0) >> 31) |
                                        ((uint64_t) (lane(s, 1) >> 31) << 1) |
                                        ((uint64_t) (lane(s, 2) >> 31) << 2) |
                                        ((uint64_t) (lane(s, 3) >> 31) << 3));
            cpu->r[x->a & 15] = m;
            return 0;
        }
        case 0x51:
        case 0x58:
        case 0x59:
        case 0x5c:
        case 0x5d:
        case 0x5e:
        case 0x5f: {
            if (pre == 0xf2)
                dst[0] = op64(op, dst[0], xload(cpu, x, 8).q[0]);
            else if (pre == 0xf3)
                dst[0] =
                    (dst[0] & ~0xffffffffull) |
                    op32(
                        op, (uint32_t) dst[0], (uint32_t) xload(cpu, x, 4).q[0]
                    );
            else if (pre == 0x66) {
                v128 s = xload(cpu, x, 16);
                for (int i = 0; i < 2; i++) dst[i] = op64(op, dst[i], s.q[i]);
            }
            else {
                v128 s = xload(cpu, x, 16), r = dv;
                for (int i = 0; i < 4; i++)
                    setlane(&r, i, op32(op, lane(dv, i), lane(s, i)));
                PUT(r);
            }
            return 0;
        }
        case 0x54:
        case 0x55:
        case 0x56:
        case 0x57:
        case 0xdb:
        case 0xdf:
        case 0xeb:
        case 0xef: {
            if (pre != 0 && pre != 0x66) return -1;
            if (op >= 0xdb && pre != 0x66) return -1;
            v128 s = xload(cpu, x, 16), r;
            for (int i = 0; i < 2; i++) {
                switch (op) {
                    case 0x54:
                    case 0xdb: r.q[i] = dv.q[i] & s.q[i]; break;
                    case 0x55:
                    case 0xdf: r.q[i] = ~dv.q[i] & s.q[i]; break;
                    case 0x56:
                    case 0xeb: r.q[i] = dv.q[i] | s.q[i]; break;
                    default: r.q[i] = dv.q[i] ^ s.q[i]; break;
                }
            }
            PUT(r);
            return 0;
        }
        case 0x5a: /* cvtss2sd, cvtsd2ss, cvtps2pd, cvtpd2ps */
            if (pre == 0xf3)
                dst[0] = q((double) f((uint32_t) xload(cpu, x, 4).q[0]));
            else if (pre == 0xf2)
                dst[0] = (dst[0] & ~0xffffffffull) |
                         u((float) d(xload(cpu, x, 8).q[0]));
            else if (pre == 0) {
                v128 s = xload(cpu, x, 8);
                v128 r = {
                    {q((double) f(lane(s, 0))), q((double) f(lane(s, 1)))}
                };
                PUT(r);
            }
            else {
                v128 s = xload(cpu, x, 16);
                v128 r = {
                    {(uint64_t) u((float) d(s.q[0])) |
                         ((uint64_t) u((float) d(s.q[1])) << 32),
                     0}
                };
                PUT(r);
            }
            return 0;
        case 0x5b: /* cvtdq2ps, cvtps2dq, cvttps2dq */
        {
            v128 s = xload(cpu, x, 16), r = s;
            for (int i = 0; i < 4; i++) {
                if (pre == 0)
                    setlane(&r, i, u((float) (int32_t) lane(s, i)));
                else {
                    double v = f(lane(s, i));
                    if (pre == 0x66) v = nearbyint(v);
                    setlane(&r, i, (uint32_t) trunc_to(v, 4));
                }
            }
            PUT(r);
            return 0;
        }
        case 0xe6: /* cvttpd2dq, cvtdq2pd, cvtpd2dq */
        {
            if (pre == 0xf3) {
                v128 s = xload(cpu, x, 8);
                v128 r = {
                    {q((double) (int32_t) lane(s, 0)),
                     q((double) (int32_t) lane(s, 1))}
                };
                PUT(r);
            }
            else {
                v128 s = xload(cpu, x, 16);
                double a = d(s.q[0]), b = d(s.q[1]);
                if (pre == 0xf2) a = nearbyint(a), b = nearbyint(b);
                v128 r = {
                    {(uint64_t) (uint32_t) trunc_to(a, 4) |
                         ((uint64_t) (uint32_t) trunc_to(b, 4) << 32),
                     0}
                };
                PUT(r);
            }
            return 0;
        }
        case 0x60:
        case 0x61:
        case 0x62:
        case 0x6c:
        case 0x68:
        case 0x69:
        case 0x6a:
        case 0x6d: {
            if (pre != 0x66) return -1;
            v128 s = xload(cpu, x, 16), r;
            uint8_t a8[16], b8[16], o[16];
            memcpy(a8, &dv, 16);
            memcpy(b8, &s, 16);
            int lw = op == 0x60 || op == 0x68   ? 1
                     : op == 0x61 || op == 0x69 ? 2
                     : op == 0x62 || op == 0x6a ? 4
                                                : 8;
            int high = (op >= 0x68 && op <= 0x6a) ||
                       op == 0x6d; /* 0x6c is punpcklqdq, a low unpack */
            int half = 8 / lw;
            for (int i = 0; i < half; i++) {
                int from = (high ? half : 0) + i;
                memcpy(o + 2 * i * lw, a8 + from * lw, (size_t) lw);
                memcpy(o + (2 * i + 1) * lw, b8 + from * lw, (size_t) lw);
            }
            memcpy(&r, o, 16);
            PUT(r);
            return 0;
        }
        case 0x64:
        case 0x65:
        case 0x66:
        case 0x74:
        case 0x75:
        case 0x76:
        case 0xfa:
        case 0xfe:
        case 0xf8:
        case 0xf9:
        case 0xfc:
        case 0xfd:
        case 0xda:
        case 0xde:
        case 0xd4:
        case 0xfb: {
            if (pre != 0x66) return -1;
            v128 s = xload(cpu, x, 16), r;
            if (op == 0xd4 || op == 0xfb)
                for (int i = 0; i < 2; i++)
                    r.q[i] = op == 0xd4 ? dv.q[i] + s.q[i] : dv.q[i] - s.q[i];
            else if (op == 0x66 || op == 0x76 || op == 0xfa || op == 0xfe)
                r = lanes32(dv, s, op);
            else if (op == 0x65 || op == 0x75 || op == 0xf9 || op == 0xfd)
                r = lanes16(dv, s, op);
            else
                r = lanes8(dv, s, op);
            PUT(r);
            return 0;
        }
        case 0x6e: /* movd, movq xmm, r/m */
        {
            if (pre != 0x66) return -1;
            v128 r = {{gpr_or_mem(cpu, x, rex_w ? 8 : 4), 0}};
            PUT(r);
            return 0;
        }
        case 0x7e:
            if (pre == 0xf3) /* movq xmm, xmm/m64 */
            {
                v128 r = {{xload(cpu, x, 8).q[0], 0}};
                PUT(r);
                return 0;
            }
            if (pre != 0x66) return -1;
            /* movd/movq r/m, xmm */
            if (x->c & 0x80)
                kb_store(cpu, cpu->r[x->b], dst[0], rex_w ? 8 : 4);
            else
                cpu->r[x->c & 15] = rex_w ? dst[0] : (dst[0] & 0xffffffffull);
            return 0;
        case 0xd6: /* movq xmm/m64, xmm */
        {
            if (pre != 0x66) return -1;
            if (x->c & 0x80)
                kb_store(cpu, cpu->r[x->b], dst[0], 8);
            else {
                cpu->x[x->c & 15][0] = dst[0];
                cpu->x[x->c & 15][1] = 0;
            }
            return 0;
        }
        case 0x70: /* pshufd, pshuflw, pshufhw */
        {
            v128 s = xload(cpu, x, 16), r = s;
            if (pre == 0x66)
                for (int i = 0; i < 4; i++)
                    setlane(&r, i, lane(s, (ext >> (2 * i)) & 3));
            else {
                uint16_t w[8], o[8];
                memcpy(w, &s, 16);
                memcpy(o, &s, 16);
                int base = pre == 0xf3 ? 4 : 0;
                if (pre != 0xf2 && pre != 0xf3) return -1;
                for (int i = 0; i < 4; i++)
                    o[base + i] = w[base + ((ext >> (2 * i)) & 3)];
                memcpy(&r, o, 16);
            }
            PUT(r);
            return 0;
        }
        case 0x71:
        case 0x72:
        case 0x73: /* shifts by an immediate; the ModRM reg field picks one */
        {
            if (pre != 0x66) return -1;
            int kind = x->a & 7; /* the destination here is the r/m register */
            uint64_t* t = cpu->x[x->c & 15];
            v128 v;
            memcpy(&v, t, 16);
            int lw = op == 0x71 ? 2 : op == 0x72 ? 4 : 8;
            v128 r;
            if (op == 0x73 && (kind == 3 || kind == 7))
                r = byteshift(v, (unsigned) ext, kind == 7);
            else if (kind == 2)
                r = shift(v, lw, (unsigned) ext, 0);
            else if (kind == 4)
                r = shift(v, lw, (unsigned) ext, 1);
            else if (kind == 6)
                r = shift(v, lw, (unsigned) ext, 2);
            else
                return -1;
            memcpy(t, &r, 16);
            return 0;
        }
        case 0xd1:
        case 0xd2:
        case 0xd3:
        case 0xe1:
        case 0xe2:
        case 0xf1:
        case 0xf2:
        case 0xf3: {
            if (pre != 0x66) return -1;
            uint64_t n = xload(cpu, x, 16).q[0];
            unsigned c = n > 255 ? 255 : (unsigned) n;
            int lw = (op & 0xf) == 1 ? 2 : (op & 0xf) == 2 ? 4 : 8;
            int kind = (op >> 4) == 0xd ? 0 : (op >> 4) == 0xe ? 1 : 2;
            v128 r = shift(dv, lw, c, kind);
            PUT(r);
            return 0;
        }
        case 0xc2: /* cmpps cmppd cmpss cmpsd: eq lt le unord neq nlt nle ord */
        {
            int n = pre == 0xf3   ? 1
                    : pre == 0xf2 ? 1
                    : pre == 0x66 ? 2
                                  : 4,
                dbl = pre == 0x66 || pre == 0xf2;
            v128 s = xload(
                     cpu, x,
                     pre == 0xf3   ? 4
                     : pre == 0xf2 ? 8
                                   : 16
                 ),
                 r = dv;
            for (int i = 0; i < n; i++) {
                double a = dbl ? d(dv.q[i]) : f(lane(dv, i)),
                       b = dbl ? d(s.q[i]) : f(lane(s, i));
                int un = isnan(a) || isnan(b), t;
                switch (ext & 7) {
                    case 0: t = !un && a == b; break;
                    case 1: t = !un && a < b; break;
                    case 2: t = !un && a <= b; break;
                    case 3: t = un; break;
                    case 4: t = un || a != b; break;
                    case 5: t = un || !(a < b); break;
                    case 6: t = un || !(a <= b); break;
                    default: t = !un; break;
                }
                if (dbl)
                    r.q[i] = t ? ~0ull : 0;
                else
                    setlane(&r, i, t ? ~0u : 0);
            }
            PUT(r);
            return 0;
        }
        case 0xc6: /* shufps, shufpd */
        {
            v128 s = xload(cpu, x, 16), r;
            if (pre == 0x66)
                r = (v128){{dv.q[ext & 1], s.q[(ext >> 1) & 1]}};
            else {
                r = dv;
                setlane(&r, 0, lane(dv, ext & 3));
                setlane(&r, 1, lane(dv, (ext >> 2) & 3));
                setlane(&r, 2, lane(s, (ext >> 4) & 3));
                setlane(&r, 3, lane(s, (ext >> 6) & 3));
            }
            PUT(r);
            return 0;
        }
        case 0x63:
        case 0x67:
        case 0x6b: /* packsswb, packuswb, packssdw */
        {
            if (pre != 0x66) return -1;
            v128 sv = xload(cpu, x, 16), r;
            if (op == 0x6b) {
                int16_t o[8];
                for (int i = 0; i < 8; i++) {
                    int32_t v = (int32_t) lane(i < 4 ? dv : sv, i & 3);
                    o[i] = (int16_t) (v > 32767    ? 32767
                                      : v < -32768 ? -32768
                                                   : v);
                }
                memcpy(&r, o, 16);
            }
            else {
                int16_t a[8], b[8];
                uint8_t o[16];
                memcpy(a, &dv, 16);
                memcpy(b, &sv, 16);
                for (int i = 0; i < 16; i++) {
                    int v = i < 8 ? a[i] : b[i - 8];
                    if (op == 0x67)
                        o[i] = (uint8_t) (v > 255 ? 255 : v < 0 ? 0 : v);
                    else
                        o[i] = (uint8_t) (int8_t) (v > 127    ? 127
                                                   : v < -128 ? -128
                                                              : v);
                }
                memcpy(&r, o, 16);
            }
            PUT(r);
            return 0;
        }
        case 0xf4: /* pmuludq */
        {
            if (pre != 0x66) return -1;
            v128 sv = xload(cpu, x, 16);
            v128 r = {
                {(dv.q[0] & 0xffffffff) * (sv.q[0] & 0xffffffff),
                 (dv.q[1] & 0xffffffff) * (sv.q[1] & 0xffffffff)}
            };
            PUT(r);
            return 0;
        }
        case 0xc4: /* pinsrw xmm, r32/m16, imm */
        {
            if (pre != 0x66) return -1;
            uint16_t w = (uint16_t) gpr_or_mem(cpu, x, 2);
            memcpy((uint8_t*) dst + 2 * (ext & 7), &w, 2);
            return 0;
        }
        case 0xc5: /* pextrw r32, xmm, imm */
        {
            if (pre != 0x66 || (x->c & 0x80)) return -1;
            uint16_t w;
            memcpy(&w, (uint8_t*) cpu->x[x->c & 15] + 2 * (ext & 7), 2);
            cpu->r[x->a & 15] = w;
            return 0;
        }
        case 0xd7: /* pmovmskb */
        {
            if (pre != 0x66) return -1;
            uint8_t b[16];
            memcpy(b, cpu->x[x->c & 15], 16);
            uint64_t m = 0;
            for (int i = 0; i < 16; i++) m |= (uint64_t) (b[i] >> 7) << i;
            cpu->r[x->a & 15] = m;
            return 0;
        }
    }
#undef PUT
    return -1;
}
