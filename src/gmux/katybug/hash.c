#include <string.h>

#include "kb.h"

/* block functions of the hash kernels (prim.c): the rounds are macros over
 * local variables, so no word is moved between rounds, and the message
 * schedule is a window of 16 words */

#if defined(__BYTE_ORDER__) && __BYTE_ORDER__ == __ORDER_BIG_ENDIAN__
    #define BE32(x) (x)
    #define LE32(x) __builtin_bswap32(x)
#else
    #define BE32(x) __builtin_bswap32(x)
    #define LE32(x) (x)
#endif

static uint32_t ld32(const uint8_t* p) {
    uint32_t v;
    memcpy(&v, p, 4);
    return v;
}

#define ROR(x, n) ((x) >> (n) | (x) << (32 - (n)))
#define ROL(x, n) ((x) << (n) | (x) >> (32 - (n)))

// #region sha256

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

#define BSIG1(e) (ROR(e, 6) ^ ROR(e, 11) ^ ROR(e, 25))
#define BSIG0(a) (ROR(a, 2) ^ ROR(a, 13) ^ ROR(a, 22))
#define CH(e, f, g) ((g) ^ ((e) & ((f) ^ (g))))
#define MAJ(a, b, c) ((((a) ^ (b)) & ((b) ^ (c))) ^ (b))
#define SSIG0(x) (ROR(x, 7) ^ ROR(x, 18) ^ ((x) >> 3))
#define SSIG1(x) (ROR(x, 17) ^ ROR(x, 19) ^ ((x) >> 10))

/* h and d take the round; the next round reads them under the next names */
#define RND(a, b, c, d, e, f, g, h, k, w)                                      \
    do {                                                                       \
        uint32_t t = h + BSIG1(e) + CH(e, f, g) + (k) + (w);                   \
        d += t;                                                                \
        h = t + BSIG0(a) + MAJ(a, b, c);                                       \
    } while (0)

/* word j of the window as it is, or advanced to the next 16 message words */
#define W0(j) (w[j] = BE32(ld32(p + 4 * (j))))
#define W1(j)                                                                  \
    (w[j] +=                                                                   \
     SSIG1(w[((j) + 14) & 15]) + w[((j) + 9) & 15] + SSIG0(w[((j) + 1) & 15]))

#define SHA256_8(o, U, j)                                                      \
    RND(a, b, c, d, e, f, g, h, sha256_k[(o) + (j)], U(j));                    \
    RND(h, a, b, c, d, e, f, g, sha256_k[(o) + (j) + 1], U((j) + 1));          \
    RND(g, h, a, b, c, d, e, f, sha256_k[(o) + (j) + 2], U((j) + 2));          \
    RND(f, g, h, a, b, c, d, e, sha256_k[(o) + (j) + 3], U((j) + 3));          \
    RND(e, f, g, h, a, b, c, d, sha256_k[(o) + (j) + 4], U((j) + 4));          \
    RND(d, e, f, g, h, a, b, c, sha256_k[(o) + (j) + 5], U((j) + 5));          \
    RND(c, d, e, f, g, h, a, b, sha256_k[(o) + (j) + 6], U((j) + 6));          \
    RND(b, c, d, e, f, g, h, a, sha256_k[(o) + (j) + 7], U((j) + 7))

/** n blocks of 64 bytes at p into the eight state words */
void kb_sha256_blocks(uint32_t st[8], const uint8_t* p, size_t n) {
    uint32_t w[16];
    for (; n; n--, p += 64) {
        uint32_t a = st[0], b = st[1], c = st[2], d = st[3];
        uint32_t e = st[4], f = st[5], g = st[6], h = st[7];
        SHA256_8(0, W0, 0);
        SHA256_8(0, W0, 8);
        SHA256_8(16, W1, 0);
        SHA256_8(16, W1, 8);
        SHA256_8(32, W1, 0);
        SHA256_8(32, W1, 8);
        SHA256_8(48, W1, 0);
        SHA256_8(48, W1, 8);
        st[0] += a, st[1] += b, st[2] += c, st[3] += d;
        st[4] += e, st[5] += f, st[6] += g, st[7] += h;
    }
}

// #endregion

// #region md5

#define MF(b, c, d) ((d) ^ ((b) & ((c) ^ (d))))
#define MG(b, c, d) ((c) ^ ((d) & ((b) ^ (c))))
#define MH(b, c, d) ((b) ^ (c) ^ (d))
#define MI(b, c, d) ((c) ^ ((b) | ~(d)))

#define STEP(f, a, b, c, d, k, s, t)                                           \
    do {                                                                       \
        a += f(b, c, d) + LE32(ld32(p + 4 * (k))) + (t);                       \
        a = ROL(a, s);                                                         \
        a += b;                                                                \
    } while (0)

/** n blocks of 64 bytes at p into the four state words */
void kb_md5_blocks(uint32_t st[4], const uint8_t* p, size_t n) {
    uint32_t a = st[0], b = st[1], c = st[2], d = st[3];
    for (; n; n--, p += 64) {
        uint32_t sa = a, sb = b, sc = c, sd = d;
        STEP(MF, a, b, c, d, 0, 7, 0xd76aa478);
        STEP(MF, d, a, b, c, 1, 12, 0xe8c7b756);
        STEP(MF, c, d, a, b, 2, 17, 0x242070db);
        STEP(MF, b, c, d, a, 3, 22, 0xc1bdceee);
        STEP(MF, a, b, c, d, 4, 7, 0xf57c0faf);
        STEP(MF, d, a, b, c, 5, 12, 0x4787c62a);
        STEP(MF, c, d, a, b, 6, 17, 0xa8304613);
        STEP(MF, b, c, d, a, 7, 22, 0xfd469501);
        STEP(MF, a, b, c, d, 8, 7, 0x698098d8);
        STEP(MF, d, a, b, c, 9, 12, 0x8b44f7af);
        STEP(MF, c, d, a, b, 10, 17, 0xffff5bb1);
        STEP(MF, b, c, d, a, 11, 22, 0x895cd7be);
        STEP(MF, a, b, c, d, 12, 7, 0x6b901122);
        STEP(MF, d, a, b, c, 13, 12, 0xfd987193);
        STEP(MF, c, d, a, b, 14, 17, 0xa679438e);
        STEP(MF, b, c, d, a, 15, 22, 0x49b40821);
        STEP(MG, a, b, c, d, 1, 5, 0xf61e2562);
        STEP(MG, d, a, b, c, 6, 9, 0xc040b340);
        STEP(MG, c, d, a, b, 11, 14, 0x265e5a51);
        STEP(MG, b, c, d, a, 0, 20, 0xe9b6c7aa);
        STEP(MG, a, b, c, d, 5, 5, 0xd62f105d);
        STEP(MG, d, a, b, c, 10, 9, 0x02441453);
        STEP(MG, c, d, a, b, 15, 14, 0xd8a1e681);
        STEP(MG, b, c, d, a, 4, 20, 0xe7d3fbc8);
        STEP(MG, a, b, c, d, 9, 5, 0x21e1cde6);
        STEP(MG, d, a, b, c, 14, 9, 0xc33707d6);
        STEP(MG, c, d, a, b, 3, 14, 0xf4d50d87);
        STEP(MG, b, c, d, a, 8, 20, 0x455a14ed);
        STEP(MG, a, b, c, d, 13, 5, 0xa9e3e905);
        STEP(MG, d, a, b, c, 2, 9, 0xfcefa3f8);
        STEP(MG, c, d, a, b, 7, 14, 0x676f02d9);
        STEP(MG, b, c, d, a, 12, 20, 0x8d2a4c8a);
        STEP(MH, a, b, c, d, 5, 4, 0xfffa3942);
        STEP(MH, d, a, b, c, 8, 11, 0x8771f681);
        STEP(MH, c, d, a, b, 11, 16, 0x6d9d6122);
        STEP(MH, b, c, d, a, 14, 23, 0xfde5380c);
        STEP(MH, a, b, c, d, 1, 4, 0xa4beea44);
        STEP(MH, d, a, b, c, 4, 11, 0x4bdecfa9);
        STEP(MH, c, d, a, b, 7, 16, 0xf6bb4b60);
        STEP(MH, b, c, d, a, 10, 23, 0xbebfbc70);
        STEP(MH, a, b, c, d, 13, 4, 0x289b7ec6);
        STEP(MH, d, a, b, c, 0, 11, 0xeaa127fa);
        STEP(MH, c, d, a, b, 3, 16, 0xd4ef3085);
        STEP(MH, b, c, d, a, 6, 23, 0x04881d05);
        STEP(MH, a, b, c, d, 9, 4, 0xd9d4d039);
        STEP(MH, d, a, b, c, 12, 11, 0xe6db99e5);
        STEP(MH, c, d, a, b, 15, 16, 0x1fa27cf8);
        STEP(MH, b, c, d, a, 2, 23, 0xc4ac5665);
        STEP(MI, a, b, c, d, 0, 6, 0xf4292244);
        STEP(MI, d, a, b, c, 7, 10, 0x432aff97);
        STEP(MI, c, d, a, b, 14, 15, 0xab9423a7);
        STEP(MI, b, c, d, a, 5, 21, 0xfc93a039);
        STEP(MI, a, b, c, d, 12, 6, 0x655b59c3);
        STEP(MI, d, a, b, c, 3, 10, 0x8f0ccc92);
        STEP(MI, c, d, a, b, 10, 15, 0xffeff47d);
        STEP(MI, b, c, d, a, 1, 21, 0x85845dd1);
        STEP(MI, a, b, c, d, 8, 6, 0x6fa87e4f);
        STEP(MI, d, a, b, c, 15, 10, 0xfe2ce6e0);
        STEP(MI, c, d, a, b, 6, 15, 0xa3014314);
        STEP(MI, b, c, d, a, 13, 21, 0x4e0811a1);
        STEP(MI, a, b, c, d, 4, 6, 0xf7537e82);
        STEP(MI, d, a, b, c, 11, 10, 0xbd3af235);
        STEP(MI, c, d, a, b, 2, 15, 0x2ad7d2bb);
        STEP(MI, b, c, d, a, 9, 21, 0xeb86d391);
        a += sa, b += sb, c += sc, d += sd;
    }
    st[0] = a, st[1] = b, st[2] = c, st[3] = d;
}

// #endregion

// #region sha1

#define SF1(b, c, d) ((d) ^ ((b) & ((c) ^ (d))))
#define SF2(b, c, d) ((b) ^ (c) ^ (d))
#define SF3(b, c, d) (((b) & (c)) | ((d) & ((b) | (c))))

/* word i of the schedule: loaded for the first 16, then the window advanced */
#define X(i)                                                                   \
    ((i) < 16 ? w[(i) & 15]                                                    \
              : (w[(i) & 15] =                                                 \
                     ROL(w[(i) & 15] ^ w[((i) + 2) & 15] ^ w[((i) + 8) & 15] ^ \
                             w[((i) + 13) & 15],                               \
                         1)))

#define SR(a, b, c, d, e, f, k, i)                                             \
    do {                                                                       \
        e += ROL(a, 5) + f(b, c, d) + (k) + X(i);                              \
        b = ROL(b, 30);                                                        \
    } while (0)

#define SHA1_5(f, k, i)                                                        \
    SR(a, b, c, d, e, f, k, i);                                                \
    SR(e, a, b, c, d, f, k, (i) + 1);                                          \
    SR(d, e, a, b, c, f, k, (i) + 2);                                          \
    SR(c, d, e, a, b, f, k, (i) + 3);                                          \
    SR(b, c, d, e, a, f, k, (i) + 4)

/** n blocks of 64 bytes at p into the five state words */
void kb_sha1_blocks(uint32_t st[5], const uint8_t* p, size_t n) {
    uint32_t w[16];
    for (; n; n--, p += 64) {
        uint32_t a = st[0], b = st[1], c = st[2], d = st[3], e = st[4];
        for (int i = 0; i < 16; i++) w[i] = BE32(ld32(p + 4 * i));
        SHA1_5(SF1, 0x5a827999, 0);
        SHA1_5(SF1, 0x5a827999, 5);
        SHA1_5(SF1, 0x5a827999, 10);
        SHA1_5(SF1, 0x5a827999, 15);
        SHA1_5(SF2, 0x6ed9eba1, 20);
        SHA1_5(SF2, 0x6ed9eba1, 25);
        SHA1_5(SF2, 0x6ed9eba1, 30);
        SHA1_5(SF2, 0x6ed9eba1, 35);
        SHA1_5(SF3, 0x8f1bbcdc, 40);
        SHA1_5(SF3, 0x8f1bbcdc, 45);
        SHA1_5(SF3, 0x8f1bbcdc, 50);
        SHA1_5(SF3, 0x8f1bbcdc, 55);
        SHA1_5(SF2, 0xca62c1d6, 60);
        SHA1_5(SF2, 0xca62c1d6, 65);
        SHA1_5(SF2, 0xca62c1d6, 70);
        SHA1_5(SF2, 0xca62c1d6, 75);
        st[0] += a, st[1] += b, st[2] += c, st[3] += d, st[4] += e;
    }
}

// #endregion

// #region cksum

/** crc advanced over n groups of 8 bytes at p by POSIX cksum's slice-by-8
 * step; tab is the guest's crctab (8 rows of 256 little-endian words) */
uint32_t kb_cksum_blocks(
    uint32_t crc, const uint8_t* tab, const uint8_t* p, size_t n
) {
#define T(row, i) LE32(ld32(tab + 4 * ((row) * 256 + (i))))
    for (; n; n--, p += 8) {
        uint32_t second = BE32(ld32(p + 4));
        crc ^= BE32(ld32(p));
        crc = T(7, crc >> 24) ^ T(6, crc >> 16 & 255) ^ T(5, crc >> 8 & 255) ^
              T(4, crc & 255) ^ T(3, second >> 24) ^ T(2, second >> 16 & 255) ^
              T(1, second >> 8 & 255) ^ T(0, second & 255);
    }
#undef T
    return crc;
}

#define CK_POLY 0x04c11db7u

/* rows 0-15 of the polynomial's own table (row k: a byte followed by k zero
 * bytes), and the folding constants x^d and x^(d + 64) mod the polynomial for
 * d = 128, 256, 384 and 512 bits; all derived at first use */
static uint32_t ck_rows[16][256];
static uint64_t ck_k[4][2];
static int ck_ready;

static uint32_t ck_xpow(unsigned n) {
    uint32_t r = 1;
    while (n--) r = r << 1 ^ (r >> 31 ? CK_POLY : 0);
    return r;
}

#if !defined(__wasm__) && !defined(KB_NO_FOLD)
    #if defined(__x86_64__)
        #include <immintrin.h>
        #define CK_FOLD "pclmul"
        #define CK_TARGET __attribute__((target("pclmul,ssse3")))
typedef __m128i ckv;
        #define CK_XOR(a, b) _mm_xor_si128(a, b)
        #define CK_K(lo, hi) _mm_set_epi64x((long long) (hi), (long long) (lo))
        #define CK_CRC(c) _mm_set_epi32((int) (c), 0, 0, 0)
CK_TARGET static ckv ck_ld(const uint8_t* p) {
    return _mm_shuffle_epi8(
        _mm_loadu_si128((const __m128i*) p),
        _mm_set_epi8(0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15)
    );
}
CK_TARGET static void ck_st(uint8_t* p, ckv a) {
    _mm_storeu_si128(
        (__m128i*) p,
        _mm_shuffle_epi8(
            a,
            _mm_set_epi8(0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15)
        )
    );
}
/* a * x^d mod p, unreduced: k holds x^d in its low and x^(d + 64) in its high
 * quad word */
CK_TARGET static ckv ck_fx(ckv a, ckv k) {
    return _mm_xor_si128(
        _mm_clmulepi64_si128(a, k, 0x00), _mm_clmulepi64_si128(a, k, 0x11)
    );
}
static int ck_has_fold(void) {
    __builtin_cpu_init();
    return __builtin_cpu_supports("pclmul") && __builtin_cpu_supports("ssse3");
}
    #elif defined(__aarch64__) && (defined(__linux__) || defined(__APPLE__))
        #include <arm_neon.h>
        #ifdef __APPLE__
            #include <sys/sysctl.h>
        #else
            #include <sys/auxv.h>
        #endif
        #define CK_FOLD "pmull"
        #ifdef __clang__
            #define CK_TARGET __attribute__((target("aes")))
        #else
            #define CK_TARGET __attribute__((target("+crypto")))
        #endif
typedef uint8x16_t ckv;
        #define CK_XOR(a, b) veorq_u8(a, b)
        #define CK_K(lo, hi)                                                   \
            vreinterpretq_u8_u64(vcombine_u64(vcreate_u64(lo), vcreate_u64(hi)))
        #define CK_CRC(c)                                                      \
            vreinterpretq_u8_u32(vsetq_lane_u32((c), vdupq_n_u32(0), 3))
CK_TARGET static ckv ck_ld(const uint8_t* p) {
    ckv v = vrev64q_u8(vld1q_u8(p));
    return vextq_u8(v, v, 8);
}
CK_TARGET static void ck_st(uint8_t* p, ckv a) {
    ckv v = vrev64q_u8(a);
    vst1q_u8(p, vextq_u8(v, v, 8));
}
CK_TARGET static ckv ck_fx(ckv a, ckv k) {
    poly64x2_t pa = vreinterpretq_p64_u8(a), pk = vreinterpretq_p64_u8(k);
    poly128_t lo = vmull_p64(vgetq_lane_p64(pa, 0), vgetq_lane_p64(pk, 0));
    poly128_t hi = vmull_high_p64(pa, pk);
    return veorq_u8(vreinterpretq_u8_p128(lo), vreinterpretq_u8_p128(hi));
}
static int ck_has_fold(void) {
        #ifdef __APPLE__
    int v = 0;
    size_t n = sizeof v;
    return sysctlbyname("hw.optional.arm.FEAT_PMULL", &v, &n, NULL, 0) == 0 &&
           v;
        #else
            #ifndef HWCAP_PMULL
                #define HWCAP_PMULL (1ul << 4)
            #endif
    return (getauxval(AT_HWCAP) & HWCAP_PMULL) != 0;
        #endif
}
    #endif
#endif

#ifdef CK_FOLD
static int ck_fold_ok;
#endif

static void ck_init(void) {
    if (ck_ready) return;
    for (unsigned i = 0; i < 256; i++) {
        uint32_t c = i << 24;
        for (int b = 0; b < 8; b++) c = c << 1 ^ (c >> 31 ? CK_POLY : 0);
        ck_rows[0][i] = c;
    }
    for (int k = 1; k < 16; k++)
        for (int i = 0; i < 256; i++) {
            uint32_t c = ck_rows[k - 1][i];
            ck_rows[k][i] = c << 8 ^ ck_rows[0][c >> 24];
        }
    for (unsigned j = 0; j < 4; j++) {
        ck_k[j][0] = ck_xpow(128 * (j + 1));
        ck_k[j][1] = ck_xpow(128 * (j + 1) + 64);
    }
#ifdef CK_FOLD
    ck_fold_ok = ck_has_fold();
#endif
    ck_ready = 1;
}

/** 1 when tab (8 rows of 256 little-endian words) is the polynomial's own
 * table, so the fast steps over derived rows give the guest's answer */
int kb_cksum_canon(const uint8_t* tab) {
#if defined(__BYTE_ORDER__) && __BYTE_ORDER__ == __ORDER_BIG_ENDIAN__
    (void) tab;
    return 0;
#else
    ck_init();
    return memcmp(tab, ck_rows, 8 * 256 * 4) == 0;
#endif
}

#define CKR(k, i) ck_rows[k][i]

/* n groups of 8 bytes over the derived rows */
static uint32_t ck_s8(uint32_t crc, const uint8_t* p, size_t n) {
    for (; n; n--, p += 8) {
        uint32_t second = BE32(ld32(p + 4));
        crc ^= BE32(ld32(p));
        crc = CKR(7, crc >> 24) ^ CKR(6, crc >> 16 & 255) ^
              CKR(5, crc >> 8 & 255) ^ CKR(4, crc & 255) ^
              CKR(3, second >> 24) ^ CKR(2, second >> 16 & 255) ^
              CKR(1, second >> 8 & 255) ^ CKR(0, second & 255);
    }
    return crc;
}

/* n groups of 16 bytes over the derived rows */
static uint32_t ck_s16(uint32_t crc, const uint8_t* p, size_t n) {
    for (; n; n--, p += 16) {
        uint32_t a = BE32(ld32(p)) ^ crc, b = BE32(ld32(p + 4));
        uint32_t c = BE32(ld32(p + 8)), d = BE32(ld32(p + 12));
        crc = CKR(15, a >> 24) ^ CKR(14, a >> 16 & 255) ^
              CKR(13, a >> 8 & 255) ^ CKR(12, a & 255) ^ CKR(11, b >> 24) ^
              CKR(10, b >> 16 & 255) ^ CKR(9, b >> 8 & 255) ^ CKR(8, b & 255) ^
              CKR(7, c >> 24) ^ CKR(6, c >> 16 & 255) ^ CKR(5, c >> 8 & 255) ^
              CKR(4, c & 255) ^ CKR(3, d >> 24) ^ CKR(2, d >> 16 & 255) ^
              CKR(1, d >> 8 & 255) ^ CKR(0, d & 255);
    }
    return crc;
}

#ifdef CK_FOLD
    /* below this many 16-byte blocks the table steps do as well */
    #define CK_FOLD_MIN 8

/* n >= 1 blocks of 16 bytes: four accumulators a stride of 64 bytes apart,
 * joined, then the last 16 bytes of folded data go through the table */
CK_TARGET static uint32_t ck_fold(uint32_t crc, const uint8_t* p, size_t n) {
    ckv k128 = CK_K(ck_k[0][0], ck_k[0][1]),
        k256 = CK_K(ck_k[1][0], ck_k[1][1]);
    ckv k384 = CK_K(ck_k[2][0], ck_k[2][1]),
        k512 = CK_K(ck_k[3][0], ck_k[3][1]);
    ckv a = CK_XOR(ck_ld(p), CK_CRC(crc));
    p += 16, n--;
    if (n >= 3) {
        ckv b = ck_ld(p), c = ck_ld(p + 16), d = ck_ld(p + 32);
        p += 48, n -= 3;
        for (; n >= 4; n -= 4, p += 64) {
            a = CK_XOR(ck_fx(a, k512), ck_ld(p));
            b = CK_XOR(ck_fx(b, k512), ck_ld(p + 16));
            c = CK_XOR(ck_fx(c, k512), ck_ld(p + 32));
            d = CK_XOR(ck_fx(d, k512), ck_ld(p + 48));
        }
        a = CK_XOR(
            CK_XOR(ck_fx(a, k384), ck_fx(b, k256)), CK_XOR(ck_fx(c, k128), d)
        );
    }
    for (; n; n--, p += 16) a = CK_XOR(ck_fx(a, k128), ck_ld(p));
    uint8_t last[16];
    ck_st(last, a);
    return ck_s8(0, last, 2);
}
#endif

/** crc advanced over n groups of 8 bytes at p by the polynomial's own table:
 * the carry-less fold where the host has one, else slice-by-16 (only after
 * kb_cksum_canon said so) */
uint32_t kb_cksum_fast(uint32_t crc, const uint8_t* p, size_t n) {
    ck_init();
#ifdef CK_FOLD
    if (ck_fold_ok && n >= 2 * CK_FOLD_MIN) {
        size_t b = n / 2;
        crc = ck_fold(crc, p, b);
        p += b * 16, n &= 1;
    }
#endif
    crc = ck_s16(crc, p, n / 2);
    p += n / 2 * 16;
    return n & 1 ? ck_s8(crc, p, 1) : crc;
}

/** which step kb_cksum_fast runs here: "pclmul", "pmull" or "slice16" */
const char* kb_cksum_path(void) {
    ck_init();
#ifdef CK_FOLD
    if (ck_fold_ok) return CK_FOLD;
#endif
    return "slice16";
}

// #endregion

// #region sha512

#if defined(__BYTE_ORDER__) && __BYTE_ORDER__ == __ORDER_BIG_ENDIAN__
    #define BE64(x) (x)
#else
    #define BE64(x) __builtin_bswap64(x)
#endif

static uint64_t ld64(const uint8_t* p) {
    uint64_t v;
    memcpy(&v, p, 8);
    return v;
}

#define ROR64(x, n) ((x) >> (n) | (x) << (64 - (n)))
#define K64(h, l) ((uint64_t) (h) << 32 | (l))

static const uint64_t sha512_k[80] = {
    K64(0x428a2f98, 0xd728ae22), K64(0x71374491, 0x23ef65cd),
    K64(0xb5c0fbcf, 0xec4d3b2f), K64(0xe9b5dba5, 0x8189dbbc),
    K64(0x3956c25b, 0xf348b538), K64(0x59f111f1, 0xb605d019),
    K64(0x923f82a4, 0xaf194f9b), K64(0xab1c5ed5, 0xda6d8118),
    K64(0xd807aa98, 0xa3030242), K64(0x12835b01, 0x45706fbe),
    K64(0x243185be, 0x4ee4b28c), K64(0x550c7dc3, 0xd5ffb4e2),
    K64(0x72be5d74, 0xf27b896f), K64(0x80deb1fe, 0x3b1696b1),
    K64(0x9bdc06a7, 0x25c71235), K64(0xc19bf174, 0xcf692694),
    K64(0xe49b69c1, 0x9ef14ad2), K64(0xefbe4786, 0x384f25e3),
    K64(0x0fc19dc6, 0x8b8cd5b5), K64(0x240ca1cc, 0x77ac9c65),
    K64(0x2de92c6f, 0x592b0275), K64(0x4a7484aa, 0x6ea6e483),
    K64(0x5cb0a9dc, 0xbd41fbd4), K64(0x76f988da, 0x831153b5),
    K64(0x983e5152, 0xee66dfab), K64(0xa831c66d, 0x2db43210),
    K64(0xb00327c8, 0x98fb213f), K64(0xbf597fc7, 0xbeef0ee4),
    K64(0xc6e00bf3, 0x3da88fc2), K64(0xd5a79147, 0x930aa725),
    K64(0x06ca6351, 0xe003826f), K64(0x14292967, 0x0a0e6e70),
    K64(0x27b70a85, 0x46d22ffc), K64(0x2e1b2138, 0x5c26c926),
    K64(0x4d2c6dfc, 0x5ac42aed), K64(0x53380d13, 0x9d95b3df),
    K64(0x650a7354, 0x8baf63de), K64(0x766a0abb, 0x3c77b2a8),
    K64(0x81c2c92e, 0x47edaee6), K64(0x92722c85, 0x1482353b),
    K64(0xa2bfe8a1, 0x4cf10364), K64(0xa81a664b, 0xbc423001),
    K64(0xc24b8b70, 0xd0f89791), K64(0xc76c51a3, 0x0654be30),
    K64(0xd192e819, 0xd6ef5218), K64(0xd6990624, 0x5565a910),
    K64(0xf40e3585, 0x5771202a), K64(0x106aa070, 0x32bbd1b8),
    K64(0x19a4c116, 0xb8d2d0c8), K64(0x1e376c08, 0x5141ab53),
    K64(0x2748774c, 0xdf8eeb99), K64(0x34b0bcb5, 0xe19b48a8),
    K64(0x391c0cb3, 0xc5c95a63), K64(0x4ed8aa4a, 0xe3418acb),
    K64(0x5b9cca4f, 0x7763e373), K64(0x682e6ff3, 0xd6b2b8a3),
    K64(0x748f82ee, 0x5defb2fc), K64(0x78a5636f, 0x43172f60),
    K64(0x84c87814, 0xa1f0ab72), K64(0x8cc70208, 0x1a6439ec),
    K64(0x90befffa, 0x23631e28), K64(0xa4506ceb, 0xde82bde9),
    K64(0xbef9a3f7, 0xb2c67915), K64(0xc67178f2, 0xe372532b),
    K64(0xca273ece, 0xea26619c), K64(0xd186b8c7, 0x21c0c207),
    K64(0xeada7dd6, 0xcde0eb1e), K64(0xf57d4f7f, 0xee6ed178),
    K64(0x06f067aa, 0x72176fba), K64(0x0a637dc5, 0xa2c898a6),
    K64(0x113f9804, 0xbef90dae), K64(0x1b710b35, 0x131c471b),
    K64(0x28db77f5, 0x23047d84), K64(0x32caab7b, 0x40c72493),
    K64(0x3c9ebe0a, 0x15c9bebc), K64(0x431d67c4, 0x9c100d4c),
    K64(0x4cc5d4be, 0xcb3e42b6), K64(0x597f299c, 0xfc657e2a),
    K64(0x5fcb6fab, 0x3ad6faec), K64(0x6c44198c, 0x4a475817)
};

#define BSIG1_64(e) (ROR64(e, 14) ^ ROR64(e, 18) ^ ROR64(e, 41))
#define BSIG0_64(a) (ROR64(a, 28) ^ ROR64(a, 34) ^ ROR64(a, 39))
#define SSIG0_64(x) (ROR64(x, 1) ^ ROR64(x, 8) ^ ((x) >> 7))
#define SSIG1_64(x) (ROR64(x, 19) ^ ROR64(x, 61) ^ ((x) >> 6))

#define RND64(a, b, c, d, e, f, g, h, k, w)                                    \
    do {                                                                       \
        uint64_t t = h + BSIG1_64(e) + CH(e, f, g) + (k) + (w);                \
        d += t;                                                                \
        h = t + BSIG0_64(a) + MAJ(a, b, c);                                    \
    } while (0)

#define V0(j) (w[j] = BE64(ld64(p + 8 * (j))))
#define V1(j)                                                                  \
    (w[j] += SSIG1_64(w[((j) + 14) & 15]) + w[((j) + 9) & 15] +                \
             SSIG0_64(w[((j) + 1) & 15]))

#define SHA512_8(o, U, j)                                                      \
    RND64(a, b, c, d, e, f, g, h, sha512_k[(o) + (j)], U(j));                  \
    RND64(h, a, b, c, d, e, f, g, sha512_k[(o) + (j) + 1], U((j) + 1));        \
    RND64(g, h, a, b, c, d, e, f, sha512_k[(o) + (j) + 2], U((j) + 2));        \
    RND64(f, g, h, a, b, c, d, e, sha512_k[(o) + (j) + 3], U((j) + 3));        \
    RND64(e, f, g, h, a, b, c, d, sha512_k[(o) + (j) + 4], U((j) + 4));        \
    RND64(d, e, f, g, h, a, b, c, sha512_k[(o) + (j) + 5], U((j) + 5));        \
    RND64(c, d, e, f, g, h, a, b, sha512_k[(o) + (j) + 6], U((j) + 6));        \
    RND64(b, c, d, e, f, g, h, a, sha512_k[(o) + (j) + 7], U((j) + 7))

/** n blocks of 128 bytes at p into the eight state words */
void kb_sha512_blocks(uint64_t st[8], const uint8_t* p, size_t n) {
    uint64_t w[16];
    for (; n; n--, p += 128) {
        uint64_t a = st[0], b = st[1], c = st[2], d = st[3];
        uint64_t e = st[4], f = st[5], g = st[6], h = st[7];
        SHA512_8(0, V0, 0);
        SHA512_8(0, V0, 8);
        SHA512_8(16, V1, 0);
        SHA512_8(16, V1, 8);
        SHA512_8(32, V1, 0);
        SHA512_8(32, V1, 8);
        SHA512_8(48, V1, 0);
        SHA512_8(48, V1, 8);
        SHA512_8(64, V1, 0);
        SHA512_8(64, V1, 8);
        st[0] += a, st[1] += b, st[2] += c, st[3] += d;
        st[4] += e, st[5] += f, st[6] += g, st[7] += h;
    }
}

// #endregion
