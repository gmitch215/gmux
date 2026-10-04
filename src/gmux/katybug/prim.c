#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "kb.h"
#include "libm.h"
#ifdef KB_ZLIB
    #include <zlib.h>
#endif

/*
 * String functions run as host kernels. A block that starts at the entry of
 * musl's strlen, memcmp, strcmp or memchr (the whole function's bytes match a
 * build below) begins with a KB_PRIM op: it computes the result over guest
 * memory and returns to the caller. The functions only read, so a kernel that
 * reaches a page it cannot read gives up before it has changed anything, and
 * the interpreter runs the function's own code, faulting where it always did.
 * A glibc guest's variant of the four is found by the slot that holds it
 * (thunk.c); memcmp and strcmp give values beyond the sign that depend on the
 * variant, so those two run only for a variant listed in vsigs, with its rule
 */

enum
{
    P_STRLEN = 1,
    P_MEMCMP,
    P_STRCMP,
    P_MEMCHR,
    P_MEMCPY = KB_THUNK_MEMCPY, /* the six below are found by name (thunk.c) */
    P_MEMMOVE = KB_THUNK_MEMMOVE,
    P_MEMSET = KB_THUNK_MEMSET,
    P_EXP = KB_THUNK_EXP, /* and by code identity in static musl guests */
    P_LOG = KB_THUNK_LOG,
    P_POW = KB_THUNK_POW,
#ifdef KB_ZLIB
    P_CRC32 = KB_THUNK_CRC32, /* -DKB_ZLIB: over the host's zlib, by name */
    P_ADLER32 = KB_THUNK_ADLER32,
    P_COMPRESS2 = KB_THUNK_COMPRESS2,
    P_UNCOMPRESS = KB_THUNK_UNCOMPRESS,
#endif
    P_SHA256, /* by code identity, one x86-64 coreutils build */
    P_COUNT
};

/* the bits of a function's code the linker fills in, left out of its hash */
struct libm_mask {
    uint16_t off;
    uint32_t mask;
};
#include "libm-sigs.h"

/* Alpine 3.20's musl 1.2.5-r3 (tests/c/katybug/prim-sigs.ts): the same bytes
 * in libc.a, ld-musl and the static builds of the transcript programs */
static const struct sig {
    int arch, id;
    uint32_t len;
    uint64_t head, hash;
} sigs[] = {
    {KB_X86, 1, 77, 0xc0834804ebf88948ull, 0xcc78df56a97eacf4ull},  /* strlen */
    {KB_X86, 2, 38, 0x834801ea83480cebull, 0x111d922aa3ec603dull},  /* memcmp */
    {KB_X86, 3, 32, 0xb60f070cb60fc031ull, 0x1f83d57caab022f1ull},  /* strcmp */
    {KB_X86, 4, 206, 0xebf6b60f40f98948ull, 0xebaecfd80fefc59eull}, /* memchr */
    {KB_A64, 1, 88, 0x14000002aa0003e1ull, 0xf80ae6d3261022f0ull},  /* strlen */
    {KB_A64, 2, 48, 0x39400003b4000142ull, 0x8926cb8f6ac1507aull},  /* memcmp */
    {KB_A64, 3, 40, 0x38626804d2800002ull, 0xc2cccae4e015455dull},  /* strcmp */
    {KB_A64, 4, 184, 0x12001c21aa0003e3ull, 0x9ec8006440306e0cull}, /* memchr */
    /* sha256_process_block of the static x86-64 coreutils 9.5 built by
     * tests/c/katybug/userland-build.sh (Alpine 3.20, gcc -O2), up to its
     * return: nothing in it depends on where the linker put the program */
    {KB_X86, P_SHA256, 11154, 0xd68948f089485741ull, 0x591450e47a612a2eull},
};

/* how a variant's memcmp or strcmp builds its result when the sign is not all,
 * and V_GUARD for a function found by name (its loads run ahead, see ahead) */
enum
{
    V_BYTES, /* the difference of the first differing bytes */
    V_X86_MEMCMP,
    V_A64_MEMCMP,
    V_A64_STRCMP,
    V_GUARD = 16
};

/* Debian 12's glibc 2.36, whole functions (tests/c/katybug/glibc-sigs.ts):
 * x86-64's sse2 memcmp (the variant katybug's cpuid selects), AArch64's memcmp
 * and strcmp (no ifunc) */
static const struct vsig {
    int arch, id, mode;
    uint32_t len;
    uint64_t head, hash;
} vsigs[] = {
    {KB_X86, 2, V_X86_MEMCMP, 720, 0x0096870f10fa8348ull,
     0x35a7a01c1ba3777aull},
    {KB_A64, 2, V_A64_MEMCMP, 456, 0xf100405fd503201full,
     0xdba90ade40e301cfull},
    {KB_A64, 3, V_A64_STRCMP, 308, 0xcb00002ad503201full,
     0xf4ed328805ddcb3cull},
};

static const char* const names[P_COUNT] = {
    "",        "strlen",  "memcmp",    "strcmp",     "memchr", "memcpy",
    "memmove", "memset",  "exp",       "log",        "pow",
#ifdef KB_ZLIB
    "crc32",   "adler32", "compress2", "uncompress",
#endif
    "sha256"
};

static uint64_t calls[P_COUNT], gave_up[P_COUNT];

/* bit i: function i runs as a kernel; KATYBUG_PRIM is 0 (none) or a
 * comma-separated list of names, and every function when unset. The libm
 * kernels stay off in a build whose compiler fused a multiply and an add */
int kb_prim_enabled(void) {
    static int mask = -1;
    if (mask < 0) {
        const char* e = getenv("KATYBUG_PRIM");
        mask = 0;
        for (int i = 1; i < P_COUNT; i++)
            if (!e || strstr(e, names[i])) mask |= 1 << i;
        if (!kb_libm_ok()) mask &= ~(1 << P_EXP | 1 << P_LOG | 1 << P_POW);
    }
    return mask;
}

/* the code at pc is s's function, bytes that depend on the program's layout
 * aside */
static int libm_at(struct kb_cpu* cpu, uint64_t pc, const struct libm_sig* s) {
    uint8_t head[8], buf[2048];
    uint64_t h;
    if (!kb_read(cpu, pc, head, 8)) return 0;
    for (int k = 0; k < s->nmask; k++)
        if (s->mask[k].off < 8) {
            uint32_t m = s->mask[k].mask;
            for (int b = 0; b < 4 && s->mask[k].off + b < 8; b++)
                head[s->mask[k].off + b] &= (uint8_t) ~(m >> 8 * b);
        }
    memcpy(&h, head, 8);
    if (h != s->head || s->len > sizeof buf || !kb_read(cpu, pc, buf, s->len))
        return 0;
    for (int k = 0; k < s->nmask; k++)
        for (int b = 0; b < 4; b++)
            buf[s->mask[k].off + b] &= (uint8_t) ~(s->mask[k].mask >> 8 * b);
    uint64_t f = 0xcbf29ce484222325ull;
    for (uint32_t k = 0; k < s->len; k++) f = (f ^ buf[k]) * 0x100000001b3ull;
    return f == s->hash;
}

/* the rule of the memcmp or strcmp whose code is at pc, or -1 when it is not
 * a variant listed in vsigs (a different glibc build has other bytes) */
static int variant(struct kb_cpu* cpu, uint64_t pc, int id) {
    for (size_t i = 0; i < sizeof vsigs / sizeof *vsigs; i++) {
        const struct vsig* s = &vsigs[i];
        if (s->arch != cpu->arch || s->id != id) continue;
        const uint8_t* p = kb_host(cpu, pc, s->len);
        uint64_t head, h = 0xcbf29ce484222325ull;
        if (!p) continue;
        memcpy(&head, p, 8);
        for (uint32_t k = 0; k < s->len && head == s->head; k++)
            h = (h ^ p[k]) * 0x100000001b3ull;
        if (h == s->hash) return s->mode;
    }
    /* x86-64 strcmp variants all return the byte difference */
    return id == P_STRCMP && cpu->arch == KB_X86 ? V_BYTES : -1;
}

/** the function whose entry is pc (1 strlen, 2 memcmp, 3 strcmp, 4 memchr,
 * 8 exp, 9 log, 10 pow in a static musl guest, and the ones thunk.c finds by
 * name) with its result rule in the bits above 8, or 0 */
int kb_prim_at(struct kb_cpu* cpu, uint64_t pc) {
    int on = kb_prim_enabled();
    uint8_t big[12288];
    for (size_t i = 0; on && i < sizeof sigs / sizeof *sigs; i++) {
        const struct sig* s = &sigs[i];
        if (s->arch != cpu->arch || !(on >> s->id & 1)) continue;
        const uint8_t* p = kb_host(cpu, pc, s->len);
        uint64_t head, h = 0xcbf29ce484222325ull;
        if (p)
            memcpy(&head, p, 8);
        else {
            /* a function across two blocks of host memory: its head first */
            if (!kb_read(cpu, pc, &head, 8) || head != s->head ||
                s->len > sizeof big || !kb_read(cpu, pc, big, s->len))
                continue;
            p = big;
        }
        if (head != s->head) continue;
        for (uint32_t k = 0; k < s->len; k++) h = (h ^ p[k]) * 0x100000001b3ull;
        if (h == s->hash) return s->id;
    }
    for (size_t i = 0; on >> P_EXP && i < sizeof libm_sigs / sizeof *libm_sigs;
         i++) {
        const struct libm_sig* s = &libm_sigs[i];
        if (s->arch == cpu->arch && (on >> s->id & 1) && libm_at(cpu, pc, s))
            return s->id;
    }
    int t = on ? kb_thunk_at(cpu, pc) : 0;
    /* a name alone does not say how the guest's libm was compiled, and
     * AArch64 compilers fuse multiplies and adds (glibc's does) */
    if (t >= P_EXP && t <= P_POW && cpu->arch == KB_A64) t = 0;
    if (!t || !(on >> t & 1)) return 0;
    if (t == P_MEMCMP || t == P_STRCMP) {
        int m = variant(cpu, pc, t);
        return m < 0 ? 0 : t | (m | V_GUARD) << 8;
    }
    return t | V_GUARD << 8;
}

static uint64_t min3(uint64_t a, uint64_t b, uint64_t c) {
    uint64_t m = a < b ? a : b;
    return m < c ? m : c;
}

/* every byte of [a, a + n) can be reached; the copy kernels check both ranges
 * first so that a bad pointer leaves memory as it was and the guest's own code
 * faults at its own instruction */
static int reach(struct kb_cpu* cpu, uint64_t a, uint64_t n) {
    if (a + n < a) return 0;
    for (uint64_t off = 0, k; off < n; off += k)
        if (!kb_span(cpu, a + off, &k)) return 0;
    return 1;
}

/* A glibc variant loads whole vectors, so a call whose answer lies within
 * GUARD bytes of unreadable memory may fault in the guest where the kernel
 * would not: such a call is left to the guest. used bytes of p were examined,
 * lim is the most the call may read */
#define GUARD 64
static int ahead(
    struct kb_cpu* cpu, uint64_t p, uint64_t used, uint64_t lim, int guard
) {
    return !guard ||
           reach(cpu, p + used, lim - used < GUARD ? lim - used : GUARD);
}

/* each kernel returns 0 when guest memory ends before the answer is known */
static int k_strlen(struct kb_cpu* cpu, uint64_t s, uint64_t* out) {
    for (uint64_t off = 0;;) {
        uint64_t k;
        const uint8_t* p = kb_span(cpu, s + off, &k);
        if (!p || s + off + k < s + off) return 0;
        const uint8_t* z = memchr(p, 0, k);
        if (z) return *out = off + (uint64_t) (z - p), 1;
        off += k;
    }
}

static int k_memchr(
    struct kb_cpu* cpu, uint64_t s, uint64_t c, uint64_t n, int guard,
    uint64_t* out
) {
    for (uint64_t off = 0; off < n;) {
        uint64_t k;
        const uint8_t* p = kb_span(cpu, s + off, &k);
        if (!p) return 0;
        if (k > n - off) k = n - off;
        const uint8_t* z = memchr(p, (int) (uint8_t) c, k);
        if (z) {
            uint64_t at = off + (uint64_t) (z - p);
            if (!ahead(cpu, s, at + 1, n, guard)) return 0;
            return *out = s + at, 1;
        }
        off += k;
    }
    return *out = 0, 1;
}

/* up to 16 bytes of a memcmp as the variant does it (every byte is read,
 * which is why all must be there) */
static int k_memcmp_small(
    struct kb_cpu* cpu, uint64_t a, uint64_t b, uint64_t n, int mode,
    uint64_t* out
) {
    uint8_t x[16], y[16];
    if (!kb_read(cpu, a, x, n) || !kb_read(cpu, b, y, n)) return 0;
    uint64_t i = 0;
    while (i < n && x[i] == y[i]) i++;
    if (i == n) return *out = 0, 1;
    int d = (int) x[i] - (int) y[i], sign = d < 0 ? -1 : 1;
    if (mode == V_X86_MEMCMP) {
        if (n == 1) return *out = (uint64_t) d, 1;
        if (n < 4) {
            /* bytes 0 and 1 and the last, as one 31 bit number each */
            uint32_t u = x[0] << 23 | x[1] << 15 | x[n - 1];
            uint32_t v = y[0] << 23 | y[1] << 15 | y[n - 1];
            return *out = u - v, 1;
        }
        return *out = (uint64_t) sign, 1;
    }
    /* AArch64: a single byte (n 1, and n 3 when the first two are equal) gives
     * the difference, a word compare gives 1 or -1 */
    if (n == 1 || (n == 3 && i == 2)) return *out = (uint64_t) d, 1;
    return *out = (uint64_t) sign, 1;
}

static int k_memcmp(
    struct kb_cpu* cpu, uint64_t a, uint64_t b, uint64_t n, int mode, int guard,
    uint64_t* out
) {
    if (mode != V_BYTES && n > 0 && n <= 16)
        return k_memcmp_small(cpu, a, b, n, mode, out);
    for (uint64_t off = 0; off < n;) {
        uint64_t ka, kb;
        const uint8_t *pa = kb_span(cpu, a + off, &ka),
                      *pb = kb_span(cpu, b + off, &kb);
        if (!pa || !pb) return 0;
        uint64_t k = min3(ka, kb, n - off);
        if (memcmp(pa, pb, k))
            for (uint64_t i = 0;; i++)
                if (pa[i] != pb[i]) {
                    int d = (int) pa[i] - (int) pb[i];
                    if (!ahead(cpu, a, off + i + 1, n, guard) ||
                        !ahead(cpu, b, off + i + 1, n, guard))
                        return 0;
                    return *out =
                               (uint64_t) (mode == V_A64_MEMCMP ? d < 0 ? -1 : 1
                                                                : d),
                           1;
                }
        off += k;
    }
    return *out = 0, 1;
}

/* AArch64 glibc's strcmp, word by word as its code does it: the result is
 * not the byte difference but the eight bits of each string that start at the
 * first differing bit (or at the terminator), so they can include bits of the
 * next byte. Every load is one the function makes */
static int k_strcmp_a64(
    struct kb_cpu* cpu, uint64_t src1, uint64_t src2, uint64_t* out
) {
    const uint64_t ones = 0x0101010101010101ull, low7 = 0x7f7f7f7f7f7f7f7full;
    uint64_t off2 = src2 - src1, d1, d2, d3 = 0, nul = 0, shift = 0, off1;
    uint8_t c1, c2;
#define LD(v, at)                                                              \
    if (!kb_read(cpu, (at), &(v), 8)) return 0
#define NUL(x) (((x) - ones) & ~((x) | low7))
    if (off2 & 7) {
        if (src1 & 7) {
            do {
                if (!kb_read(cpu, src1, &c1, 1) || !kb_read(cpu, src2, &c2, 1))
                    return 0;
                src1++, src2++;
                if (c1 == 0 || c1 != c2)
                    return *out = (uint64_t) ((int) c1 - (int) c2), 1;
            } while (src1 & 7);
        }
        shift = -(src2 << 3);
        src2 &= ~7ull;
        LD(d3, src2);
        src2 += 8;
        d3 |= ones >> (shift & 63);
        nul = NUL(d3);
        if (!nul) {
            off1 = src2 - src1;
            for (;;) {
                LD(d3, src1 + off1);
                LD(d2, src1 + off2);
                nul = NUL(d3);
                LD(d1, src1);
                src1 += 8;
                if (nul || d1 != d2) break;
            }
            uint64_t t = nul << (shift & 63);
            if ((d1 ^ d2) | t) {
                nul = t;
                goto end;
            }
        }
        LD(d1, src1);
        shift = -shift;
        d2 = d3 >> (shift & 63);
        nul >>= shift & 63;
        goto end;
    }
    if (src1 & 7) {
        uint64_t m;
        src1 &= ~7ull;
        LD(d2, src1 + off2);
        LD(d1, src1);
        src1 += 8;
        m = ~0ull >> (-(src2 << 3) & 63);
        d1 |= m, d2 |= m;
    }
    else {
        LD(d2, src1 + off2);
        LD(d1, src1);
        src1 += 8;
    }
    for (;;) {
        nul = NUL(d1);
        if (nul || d1 != d2) break;
        LD(d2, src1 + off2);
        LD(d1, src1);
        src1 += 8;
    }
end:;
    uint64_t syn = __builtin_bswap64((d1 ^ d2) | nul);
    d1 = __builtin_bswap64(d1), d2 = __builtin_bswap64(d2);
    shift = syn ? (uint64_t) __builtin_clzll(syn) : 64;
    d1 <<= shift & 63, d2 <<= shift & 63;
    *out = (d1 >> 56) - (d2 >> 56);
    return 1;
#undef LD
#undef NUL
}

static int k_strcmp(
    struct kb_cpu* cpu, uint64_t a, uint64_t b, int guard, uint64_t* out
) {
    for (uint64_t off = 0;;) {
        uint64_t ka, kb;
        const uint8_t *pa = kb_span(cpu, a + off, &ka),
                      *pb = kb_span(cpu, b + off, &kb);
        if (!pa || !pb) return 0;
        uint64_t k = ka < kb ? ka : kb;
        const uint8_t* z = memchr(pa, 0, k);
        uint64_t lim = z ? (uint64_t) (z - pa) + 1 : k;
        if (memcmp(pa, pb, lim))
            for (uint64_t i = 0;; i++)
                if (pa[i] != pb[i]) {
                    if (!ahead(cpu, a, off + i + 1, ~0ull, guard) ||
                        !ahead(cpu, b, off + i + 1, ~0ull, guard))
                        return 0;
                    return *out = (uint64_t) ((int) pa[i] - (int) pb[i]), 1;
                }
        if (z) return *out = 0, 1;
        off += k;
    }
}

/* move: overlapping ranges copy as memmove does; memcpy's overlap is left to
 * the guest (musl's forward copy and glibc's differ there) */
static int k_copy(
    struct kb_cpu* cpu, uint64_t d, uint64_t s, uint64_t n, int move
) {
    if (!reach(cpu, s, n) || !reach(cpu, d, n)) return 0;
    if (d != s && d < s + n && s < d + n) {
        if (!move || n > KB_BUF_MAX) return 0;
        uint8_t* t = malloc((size_t) n);
        if (!t) return 0;
        int ok = kb_read(cpu, s, t, n) && kb_write(cpu, d, t, n);
        free(t);
        return ok;
    }
    for (uint64_t off = 0, k; off < n; off += k) {
        uint64_t ks, kd;
        const uint8_t* ps = kb_span(cpu, s + off, &ks);
        uint8_t* pd = kb_span(cpu, d + off, &kd);
        k = min3(ks, kd, n - off);
        memmove(pd, ps, (size_t) k);
    }
    return 1;
}

static int k_memset(struct kb_cpu* cpu, uint64_t d, uint64_t c, uint64_t n) {
    if (!reach(cpu, d, n)) return 0;
    for (uint64_t off = 0, k; off < n; off += k) {
        uint8_t* p = kb_span(cpu, d + off, &k);
        if (k > n - off) k = n - off;
        memset(p, (int) (uint8_t) c, (size_t) k);
    }
    return 1;
}

static const uint32_t sha256_k[64] = {
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1,
    0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3,
    0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786,
    0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147,
    0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
    0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b,
    0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a,
    0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
    0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2
};

static uint32_t ror32(uint32_t x, int n) {
    return x >> n | x << (32 - n);
}

/* one 64 byte block into st */
static void sha256_block(uint32_t st[8], const uint8_t* p) {
    uint32_t w[64], v[8];
    for (int i = 0; i < 16; i++)
        w[i] = (uint32_t) p[4 * i] << 24 | (uint32_t) p[4 * i + 1] << 16 |
               (uint32_t) p[4 * i + 2] << 8 | p[4 * i + 3];
    for (int i = 16; i < 64; i++) {
        uint32_t a = w[i - 15], b = w[i - 2];
        w[i] = w[i - 16] + w[i - 7] + (ror32(a, 7) ^ ror32(a, 18) ^ a >> 3) +
               (ror32(b, 17) ^ ror32(b, 19) ^ b >> 10);
    }
    memcpy(v, st, sizeof v);
    for (int i = 0; i < 64; i++) {
        uint32_t t1 = v[7] +
                      (ror32(v[4], 6) ^ ror32(v[4], 11) ^ ror32(v[4], 25)) +
                      (v[6] ^ (v[4] & (v[5] ^ v[6]))) + sha256_k[i] + w[i];
        uint32_t t2 = (ror32(v[0], 2) ^ ror32(v[0], 13) ^ ror32(v[0], 22)) +
                      ((v[0] & v[1]) | (v[2] & (v[0] | v[1])));
        memmove(v + 1, v, 7 * sizeof *v);
        v[4] += t1;
        v[0] = t1 + t2;
    }
    for (int i = 0; i < 8; i++) st[i] += v[i];
}

/* sha256_process_block (buf, len, ctx) of the coreutils build in sigs: the
 * state words and the 64 bit byte count (ctx + 0 to 40) are all it writes.
 * The count goes first and the buffer is read after, so a buffer that is not
 * all there, or one that overlaps those fields, is left to the guest */
static int k_sha256(
    struct kb_cpu* cpu, uint64_t buf, uint64_t len, uint64_t ctx
) {
    uint8_t c[40], blk[64];
    uint32_t st[8], total[2];
    if (len & 63 || !kb_read(cpu, ctx, c, 40) || !reach(cpu, buf, len) ||
        (len && buf < ctx + 40 && ctx < buf + len))
        return 0;
    memcpy(st, c, 32);
    memcpy(total, c + 32, 8);
    for (uint64_t off = 0; off < len; off += 64) {
        const uint8_t* p = kb_host(cpu, buf + off, 64);
        if (!p) p = kb_read(cpu, buf + off, blk, 64) ? blk : NULL;
        if (!p) return 0;
        sha256_block(st, p);
    }
    uint32_t lo = (uint32_t) len;
    total[0] += lo;
    total[1] += (uint32_t) (len >> 32) + (total[0] < lo);
    memcpy(c, st, 32);
    memcpy(c + 32, total, 8);
    return kb_write(cpu, ctx, c, 40);
}

#ifdef KB_ZLIB
/* the most bytes a buffer handed to the host's zlib holds */
    #define ZMAX (64u << 20)

/* crc32 or adler32 of guest [buf, buf + n) from init */
static int k_sum(
    struct kb_cpu* cpu, int adler, uint64_t init, uint64_t buf, uint32_t n,
    uint64_t* out
) {
    if (!buf || !n || !reach(cpu, buf, n)) return 0;
    uLong v = (uLong) init;
    for (uint64_t off = 0, k; off < n; off += k) {
        const uint8_t* p = kb_span(cpu, buf + off, &k);
        if (k > n - off) k = n - off;
        v = adler ? adler32(v, p, (uInt) k) : crc32(v, p, (uInt) k);
    }
    return *out = (uint64_t) v, 1;
}

/* compress2 (inflate 0) or uncompress (1): only a call that succeeds is taken
 * over; a bad level, a buffer too small, damaged input and anything else runs
 * the guest's own code, which writes what it writes */
static int k_zlib(
    struct kb_cpu* cpu, int inflate, uint64_t dest, uint64_t lenp, uint64_t src,
    uint64_t srclen, int level
) {
    uint64_t want;
    if (!kb_read(cpu, lenp, &want, 8) || !want || want > ZMAX || !srclen ||
        srclen > ZMAX || !reach(cpu, dest, want) || !reach(cpu, src, srclen))
        return 0;
    uint8_t* in = malloc((size_t) srclen);
    uint8_t* out = malloc((size_t) want);
    int ok = 0;
    if (in && out && kb_read(cpu, src, in, srclen)) {
        uLongf n = (uLongf) want;
        int rc = inflate ? uncompress(out, &n, in, (uLong) srclen)
                         : compress2(out, &n, in, (uLong) srclen, level);
        uint64_t len = n;
        ok = rc == Z_OK && kb_write(cpu, dest, out, len) &&
             kb_write(cpu, lenp, &len, 8);
    }
    free(in);
    free(out);
    return ok;
}
#endif

/* exp, log or pow of the doubles in xmm0 and xmm1 (v0 and v1): the result in
 * xmm0, or 0 for what the kernels leave to the guest. A rounding mode, flush
 * to zero or denormals-are-zero setting is left to the guest too. Katybug's
 * SSE raises no exception flag, so an x86-64 guest sees none here either;
 * AArch64's inexact flag is set, as every call that gets this far raises it */
static int k_libm(struct kb_cpu* cpu, int id) {
    int a64 = cpu->arch == KB_A64;
    if (a64 ? cpu->fpcr & 0x03c00000 : cpu->mxcsr & 0xe040) return 0;
    double x, y, r;
    memcpy(&x, &cpu->x[0][0], 8);
    memcpy(&y, &cpu->x[1][0], 8);
    int ok = id == P_EXP   ? kb_libm_exp(x, a64, &r)
             : id == P_LOG ? kb_libm_log(x, a64, &r)
                           : kb_libm_pow(x, y, a64, &r);
    if (!ok) return 0;
    memcpy(&cpu->x[0][0], &r, 8);
    if (a64) cpu->x[0][1] = 0, cpu->fpsr |= 16;
    return 1;
}

/** runs function id for the call being made at its entry, and returns to the
 * caller: 1 with *next the caller's pc, or 0 (nothing changed) when a page the
 * function reads is not there and the function's own code should run */
int kb_prim(struct kb_cpu* cpu, int id, uint64_t* next) {
    int mode = id >> 8 & ~V_GUARD, guard = id >> 8 & V_GUARD;
    id &= 0xff;
    uint64_t* r = cpu->r;
    int x86 = cpu->arch == KB_X86;
    uint64_t a = x86 ? r[7] : r[0], b = x86 ? r[6] : r[1], n = r[2], ret, v = 0;
    if (x86) {
        const uint8_t* sp = kb_host(cpu, r[4], 8);
        if (!sp) return 0;
        memcpy(&ret, sp, 8);
    }
    else
        ret = r[30];
    int ok = 0;
    switch (id) {
        case P_MEMCPY: ok = k_copy(cpu, a, b, n, 0), v = a; break;
        case P_MEMMOVE: ok = k_copy(cpu, a, b, n, 1), v = a; break;
        case P_MEMSET: ok = k_memset(cpu, a, b, n), v = a; break;
        case P_STRLEN: ok = k_strlen(cpu, a, &v); break;
        case P_MEMCMP: ok = k_memcmp(cpu, a, b, n, mode, guard, &v); break;
        case P_STRCMP:
            ok = mode == V_A64_STRCMP ? k_strcmp_a64(cpu, a, b, &v)
                                      : k_strcmp(cpu, a, b, guard, &v);
            break;
        case P_MEMCHR: ok = k_memchr(cpu, a, b, n, guard, &v); break;
        case P_EXP:
        case P_LOG:
        case P_POW: ok = k_libm(cpu, id); break;
        case P_SHA256: ok = k_sha256(cpu, a, b, n); break;
#ifdef KB_ZLIB
        case P_CRC32:
        case P_ADLER32:
            ok = k_sum(cpu, id == P_ADLER32, a, b, (uint32_t) n, &v);
            break;
        case P_COMPRESS2:
        case P_UNCOMPRESS:
            ok = k_zlib(
                cpu, id == P_UNCOMPRESS, a, b, n, x86 ? r[1] : r[3],
                (int) (x86 ? r[8] : r[4])
            );
            break;
#endif
    }
    if (!ok) return gave_up[id]++, 0;
    calls[id]++;
    /* int results are written as 32 bits, as the compiled code does; AArch64
     * glibc's strcmp subtracts 64 bit registers */
    if (id < P_EXP)
        r[0] = id == P_STRLEN || id == P_MEMCHR || id >= P_MEMCPY ||
                       mode == V_A64_STRCMP
                   ? v
                   : (uint32_t) v;
#ifdef KB_ZLIB
    else if (id >= P_CRC32 && id != P_SHA256)
        r[0] = v; /* the sum, or 0 for Z_OK */
#endif
    if (x86) r[4] += 8;
    *next = ret;
    return 1;
}

/** one line: calls run as kernels and those that gave up; appended to
 * KATYBUG_PRIM_LOG when set (coreutils closes stderr), else on the log */
void kb_prim_report(void) {
    int any = 0;
    for (int i = 1; i < P_COUNT; i++) any |= calls[i] || gave_up[i];
    if (!any) return;
    const char* path = getenv("KATYBUG_PRIM_LOG");
    FILE* f = path ? fopen(path, "a") : kb_log;
    if (!f) return;
    fprintf(f, "katybug: prim");
    for (int i = 1; i < P_COUNT; i++)
        fprintf(
            f, " %s %llu (%llu gave up)", names[i],
            (unsigned long long) calls[i], (unsigned long long) gave_up[i]
        );
    fprintf(f, "\n");
    if (path) fclose(f);
}
