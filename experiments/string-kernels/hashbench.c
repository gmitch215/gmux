#include <stddef.h>
#include <stdint.h>
#include <string.h>

/* the hash blocks and the cksum step of the katybug kernels
 * (src/gmux/katybug/hash.c) over a 32 KiB buffer, the way a tool's read loop
 * hands them out; sha256 also with the block the kernel shipped before (its
 * eight words moved by a memmove every round) and with the words renamed in
 * registers only. native: hashbench [MiB hashed per run] [runs]; wasm32:
 * run(variant, reps) and buffer are exports, the caller times. hashbench check
 * <md5|sha1|sha256|sha512|cksum> < file prints the digest (cksum: the crc and
 * the length), for comparison with md5sum, sha1sum, sha256sum, sha512sum and
 * cksum */

void kb_sha256_blocks(uint32_t st[8], const uint8_t* p, size_t n);
void kb_sha1_blocks(uint32_t st[5], const uint8_t* p, size_t n);
void kb_md5_blocks(uint32_t st[4], const uint8_t* p, size_t n);
void kb_sha512_blocks(uint64_t st[8], const uint8_t* p, size_t n);
uint32_t kb_cksum_blocks(
    uint32_t crc, const uint8_t* tab, const uint8_t* p, size_t n
);

#define CHUNK 32768

static uint8_t buf[CHUNK];
static uint8_t crctab[8 * 256 * 4];

static const uint32_t K[64] = {
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

static uint32_t ror(uint32_t x, int n) {
    return x >> n | x << (32 - n);
}

static void schedule(uint32_t w[64], const uint8_t* p) {
    for (int i = 0; i < 16; i++)
        w[i] = (uint32_t) p[4 * i] << 24 | (uint32_t) p[4 * i + 1] << 16 |
               (uint32_t) p[4 * i + 2] << 8 | p[4 * i + 3];
    for (int i = 16; i < 64; i++) {
        uint32_t a = w[i - 15], b = w[i - 2];
        w[i] = w[i - 16] + w[i - 7] + (ror(a, 7) ^ ror(a, 18) ^ a >> 3) +
               (ror(b, 17) ^ ror(b, 19) ^ b >> 10);
    }
}

/* the block the kernel shipped with */
static void shipped(void* state, const uint8_t* p, size_t n) {
    uint32_t* st = state;
    for (; n; n--, p += 64) {
        uint32_t w[64], v[8];
        schedule(w, p);
        memcpy(v, st, sizeof v);
        for (int i = 0; i < 64; i++) {
            uint32_t t1 = v[7] +
                          (ror(v[4], 6) ^ ror(v[4], 11) ^ ror(v[4], 25)) +
                          (v[6] ^ (v[4] & (v[5] ^ v[6]))) + K[i] + w[i];
            uint32_t t2 = (ror(v[0], 2) ^ ror(v[0], 13) ^ ror(v[0], 22)) +
                          ((v[0] & v[1]) | (v[2] & (v[0] | v[1])));
            memmove(v + 1, v, 7 * sizeof *v);
            v[4] += t1;
            v[0] = t1 + t2;
        }
        for (int i = 0; i < 8; i++) st[i] += v[i];
    }
}

/* the same rounds with the eight words renamed in registers */
static void renamed(void* state, const uint8_t* p, size_t n) {
    uint32_t* st = state;
    for (; n; n--, p += 64) {
        uint32_t w[64];
        schedule(w, p);
        uint32_t a = st[0], b = st[1], c = st[2], d = st[3], e = st[4],
                 f = st[5], g = st[6], h = st[7];
        for (int i = 0; i < 64; i++) {
            uint32_t t1 = h + (ror(e, 6) ^ ror(e, 11) ^ ror(e, 25)) +
                          (g ^ (e & (f ^ g))) + K[i] + w[i];
            uint32_t t2 = (ror(a, 2) ^ ror(a, 13) ^ ror(a, 22)) +
                          ((a & b) | (c & (a | b)));
            h = g, g = f, f = e, e = d + t1, d = c, c = b, b = a, a = t1 + t2;
        }
        st[0] += a, st[1] += b, st[2] += c, st[3] += d, st[4] += e, st[5] += f,
            st[6] += g, st[7] += h;
    }
}

/* the final block, one block a call */
static void final1(void* st, const uint8_t* p, size_t n) {
    for (; n; n--, p += 64) kb_sha256_blocks(st, p, 1);
}

static void sha256_final(void* st, const uint8_t* p, size_t n) {
    kb_sha256_blocks(st, p, n);
}
static void sha1_final(void* st, const uint8_t* p, size_t n) {
    kb_sha1_blocks(st, p, n);
}
static void md5_final(void* st, const uint8_t* p, size_t n) {
    kb_md5_blocks(st, p, n);
}
static void sha512_final(void* st, const uint8_t* p, size_t n) {
    kb_sha512_blocks(st, p, n);
}
/* n groups of 8 bytes into the crc in the first state word */
static void cksum_final(void* st, const uint8_t* p, size_t n) {
    uint32_t* crc = st;
    *crc = kb_cksum_blocks(*crc, crctab, p, n);
}

typedef void (*block_fn)(void*, const uint8_t*, size_t);

union state {
    uint32_t w32[16];
    uint64_t w64[8];
};

/* block is the bytes one unit of fn takes, wsz the size of a state word */
static const struct variant {
    const char* name;
    block_fn fn;
    int words, wsz, block;
    union state init;
} variants[] = {
    {"sha256 shipped",
     shipped,
     8,
     4,
     64,
     {{0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c,
       0x1f83d9ab, 0x5be0cd19}}},
    {"sha256 renamed",
     renamed,
     8,
     4,
     64,
     {{0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c,
       0x1f83d9ab, 0x5be0cd19}}},
    {"sha256 final 1 block a call",
     final1,
     8,
     4,
     64,
     {{0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c,
       0x1f83d9ab, 0x5be0cd19}}},
    {"sha256 final",
     sha256_final,
     8,
     4,
     64,
     {{0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c,
       0x1f83d9ab, 0x5be0cd19}}},
    {"sha1 final",
     sha1_final,
     5,
     4,
     64,
     {{0x67452301, 0xefcdab89, 0x98badcfe, 0x10325476, 0xc3d2e1f0}}},
    {"md5 final",
     md5_final,
     4,
     4,
     64,
     {{0x67452301, 0xefcdab89, 0x98badcfe, 0x10325476}}},
    {"sha512 final", sha512_final, 8, 8, 128,
     .init.w64 =
         {0x6a09e667f3bcc908ull, 0xbb67ae8584caa73bull, 0x3c6ef372fe94f82bull,
          0xa54ff53a5f1d36f1ull, 0x510e527fade682d1ull, 0x9b05688c2b3e6c1full,
          0x1f83d9abfb41bd6bull, 0x5be0cd19137e2179ull}},
    {"cksum final", cksum_final, 1, 4, 8, {{0}}},
};
#define NVARIANTS (sizeof variants / sizeof *variants)
#define V_SHA256 3
#define V_SHA1 4
#define V_MD5 5
#define V_SHA512 6
#define V_CKSUM 7

/* cksum.c's table (compiled with -DCRCTAB): row 0 the remainders of one byte,
 * row k the crc of a byte followed by k zero bytes */
static void fill_crctab(void) {
    uint32_t gen[8], t[8][256];
    gen[0] = (1u << 26) | (1u << 23) | (1u << 22) | (1u << 16) | (1u << 12) |
             (1u << 11) | (1u << 10) | (1u << 8) | (1u << 7) | (1u << 5) |
             (1u << 4) | (1u << 2) | (1u << 1) | 1u;
    for (int i = 1; i < 8; i++)
        gen[i] = (gen[i - 1] << 1) ^ ((gen[i - 1] & 0x80000000u) ? gen[0] : 0);
    for (int m = 0; m < 256; m++) {
        uint32_t rem = 0;
        for (int i = 0; i < 8; i++)
            if (m >> i & 1) rem ^= gen[i];
        t[0][m] = rem;
    }
    for (int i = 0; i < 256; i++) {
        uint32_t crc = t[0][i];
        for (int k = 1; k < 8; k++) {
            crc = (crc << 8) ^ t[0][crc >> 24];
            t[k][i] = crc;
        }
    }
    for (int k = 0; k < 8; k++)
        for (int i = 0; i < 256; i++)
            for (int b = 0; b < 4; b++)
                crctab[4 * (k * 256 + i) + b] = (uint8_t) (t[k][i] >> 8 * b);
}

static void fill(void) {
    uint32_t x = 12345;
    for (int i = 0; i < CHUNK; i++)
        buf[i] = (uint8_t) ((x = x * 1664525u + 1013904223u) >> 24);
    fill_crctab();
}

/* reps passes over the buffer from the initial state, the state words folded
 * into one number */
static uint32_t run(int v, uint32_t reps) {
    const struct variant* s = &variants[v];
    union state st = s->init;
    uint32_t fold = 0;
    for (uint32_t r = 0; r < reps; r++)
        s->fn(&st, buf, CHUNK / (size_t) s->block);
    for (int i = 0; i < s->words; i++)
        fold =
            fold * 0x9e3779b1u ^
            (s->wsz == 8 ? (uint32_t) (st.w64[i] >> 32) ^ (uint32_t) st.w64[i]
                         : st.w32[i]);
    return fold;
}

#ifdef __wasm__
__attribute__((export_name("variants"))) int count(void) {
    return (int) NVARIANTS;
}
__attribute__((export_name("run"))) uint32_t run_export(int v, uint32_t reps) {
    if (v == 0) fill();
    return run(v, reps);
}
#else
    #include <stdio.h>
    #include <stdlib.h>
    #include <time.h>

static double now(void) {
    struct timespec t;
    clock_gettime(CLOCK_MONOTONIC, &t);
    return t.tv_sec + t.tv_nsec / 1e9;
}

static int cmp(const void* a, const void* b) {
    return (*(const double*) a > *(const double*) b) -
           (*(const double*) a < *(const double*) b);
}

/* cksum of stdin: the crc of the whole 8-byte groups by the kernel's step,
 * the rest bytewise, then the length's bytes, as cksum.c's crc_sum_stream */
static int check_cksum(void) {
    static uint8_t in[CHUNK];
    uint32_t crc = 0;
    uint64_t total = 0;
    size_t got;
    fill_crctab();
    #define T0(i)                                                              \
        ((uint32_t) crctab[4 * (i)] | (uint32_t) crctab[4 * (i) + 1] << 8 |    \
         (uint32_t) crctab[4 * (i) + 2] << 16 |                                \
         (uint32_t) crctab[4 * (i) + 3] << 24)
    while ((got = fread(in, 1, sizeof in, stdin)) > 0) {
        total += got;
        size_t n = got / 8;
        crc = kb_cksum_blocks(crc, crctab, in, n);
        for (size_t i = n * 8; i < got; i++)
            crc = (crc << 8) ^ T0((crc >> 24) ^ in[i]);
    }
    for (uint64_t n = total; n; n >>= 8)
        crc = (crc << 8) ^ T0((crc >> 24) ^ (uint32_t) (n & 255));
    printf("%u %llu\n", (unsigned) ~crc, (unsigned long long) total);
    return 0;
}

/* the digest of stdin, padded the way the hashes pad */
static int check(const char* alg) {
    int v = !strcmp(alg, "sha256")   ? V_SHA256
            : !strcmp(alg, "sha1")   ? V_SHA1
            : !strcmp(alg, "md5")    ? V_MD5
            : !strcmp(alg, "sha512") ? V_SHA512
                                     : -1;
    if (!strcmp(alg, "cksum")) return check_cksum();
    if (v < 0) return 2;
    const struct variant* s = &variants[v];
    union state st = s->init;
    size_t block = (size_t) s->block, lenb = v == V_SHA512 ? 16 : 8;
    uint8_t blk[256];
    size_t fill_n = 0;
    uint64_t total = 0;
    size_t got;
    static uint8_t in[CHUNK];
    while ((got = fread(in, 1, sizeof in, stdin)) > 0) {
        total += got;
        const uint8_t* p = in;
        if (fill_n) {
            size_t add = block - fill_n < got ? block - fill_n : got;
            memcpy(blk + fill_n, p, add);
            fill_n += add, p += add, got -= add;
            if (fill_n == block) s->fn(&st, blk, 1), fill_n = 0;
        }
        if (got >= block)
            s->fn(&st, p, got / block), p += got & ~(block - 1),
                got &= block - 1;
        memcpy(blk, p, got), fill_n = got;
    }
    int le = v == V_MD5;
    size_t pad = fill_n < block - lenb ? block : 2 * block;
    memset(blk + fill_n, 0, pad - fill_n);
    blk[fill_n] = 0x80;
    for (int i = 0; i < 8; i++) {
        uint64_t bits = total * 8;
        blk[pad - 8 + i] = (uint8_t) (bits >> (le ? 8 * i : 8 * (7 - i)));
        if (lenb == 16)
            blk[pad - 16 + i] = (uint8_t) ((total >> 61) >> (8 * (7 - i)));
    }
    s->fn(&st, blk, pad / block);
    for (int i = 0; i < s->words; i++)
        for (int b = 0; b < s->wsz; b++) {
            uint64_t w = s->wsz == 8 ? st.w64[i] : st.w32[i];
            printf(
                "%02x",
                (unsigned) (w >> (le ? 8 * b : 8 * (s->wsz - 1 - b)) & 255)
            );
        }
    printf("\n");
    return 0;
}

int main(int argc, char** argv) {
    if (argc == 3 && !strcmp(argv[1], "check")) return check(argv[2]);
    uint32_t mib = argc > 1 ? (uint32_t) atoi(argv[1]) : 256,
             runs = argc > 2 ? (uint32_t) atoi(argv[2]) : 5;
    uint32_t reps = mib * 1048576 / CHUNK;
    double rate[NVARIANTS][64];
    uint32_t digest[NVARIANTS];
    fill();
    if (runs > 64) runs = 64;
    for (uint32_t r = 0; r <= runs; r++)
        for (int v = 0; v < (int) NVARIANTS; v++) {
            double t = now();
            uint32_t d = run(v, reps);
            t = now() - t;
            if (r) rate[v][r - 1] = mib * 1.048576 / t;
            digest[v] = d;
        }
    for (int v = 0; v < (int) NVARIANTS; v++) {
        qsort(rate[v], runs, sizeof **rate, cmp);
        printf(
            "%s\t%.1f\t%.1f-%.1f\t%08x\n", variants[v].name, rate[v][runs / 2],
            rate[v][0], rate[v][runs - 1], digest[v]
        );
    }
    return 0;
}
#endif
