#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

#include "kb.h"

/*
 * A whole digest on the host's crypto. The static x86-64 coreutils 9.5 build
 * that digest-sigs.h describes hashes a stream in one function whose context
 * is a local: it initializes the context, passes it to the block function for
 * every 32 KiB it reads, to process_bytes for the tail, and to a finish
 * function. A host digest cannot export its state, so it is taken only when
 * nothing but those functions can see the context: the block function's caller
 * is that stream function (its bytes hash to the row's), the context is the
 * local it passes, the process has one thread and no signal handler (so no
 * guest code runs between the calls but the stream's own and libc's), and the
 * context still holds the initial state. The host digest then takes the bytes
 * of every block call, the guest's own process_bytes leaves the tail in the
 * context's buffer, and the finish function (found by its bytes, the stub and
 * what it calls) takes that tail and writes the digest. A mark in the context's
 * high count word (the next init clears it) tells a continuing stream from one
 * that began again at the same address. Anything not proven private keeps
 * prim.c's block kernel. A state the host digest cannot give back (a context
 * that lost its digest) ends the process rather than hand out a wrong digest.
 * A fork by exec copies each open digest under a ticket that the child claims
 * (the machine lets only a child of the task that took the copy). Natively the
 * host is a test double over hash.c, on with KATYBUG_HOSTDIGEST
 */

static uint64_t ldw(const uint8_t* p, int n) {
    uint64_t v = 0;
    for (int i = n - 1; i >= 0; i--) v = v << 8 | p[i];
    return v;
}

// #region host
#if defined(__wasm__)
/* the machine's __gmux_digest (op 0 new alg, 1 update id ptr len, 2 finish id
 * out, 3 drop id): a negative result is an error */
__attribute__((import_module("env"), import_name("__gmux_digest"))) extern int
gmux_digest(int op, int a, int b, int c);

static int hd_new(int alg) {
    return gmux_digest(0, alg, 0, 0);
}
static int hd_update(int id, const void* p, size_t n) {
    return gmux_digest(1, id, (int) (uintptr_t) p, (int) n);
}
static int hd_finish(int id, void* out) {
    return gmux_digest(2, id, (int) (uintptr_t) out, 0);
}
static void hd_drop(int id) {
    gmux_digest(3, id, 0, 0);
}
static int hd_fork(int id, uint8_t* blob, int* len) {
    (void) blob;
    *len = 0;
    return gmux_digest(4, id, 0, 0);
}
static int hd_claim(int ticket, const uint8_t* blob, int len) {
    (void) blob, (void) len;
    return gmux_digest(5, ticket, 0, 0);
}
int kb_digest_ready(void) {
    return 1;
}
#else
struct td {
    int alg;
    uint64_t total, done; /* done: the bytes blake2b has compressed */
    uint32_t n;
    uint8_t buf[128];
    union {
        uint32_t w32[8];
        uint64_t w64[8];
    } st;
};
static struct td* tds[16];

int kb_digest_ready(void) {
    static int on = -1;
    if (on < 0) on = getenv("KATYBUG_HOSTDIGEST") != NULL;
    return on;
}

/* the double's algorithm numbers are the machine's: 4 sha512, 6 sha384 and 7
 * blake2b are the 128-byte block ones */
static int wide(int alg) {
    return alg == 4 || alg == 6 || alg == 7;
}

/* blake2b (RFC 7693): the last block, full or not, waits for the finish */
static const uint8_t b2sigma[12][16] = {
    {0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15},
    {14, 10, 4, 8, 9, 15, 13, 6, 1, 12, 0, 2, 11, 7, 5, 3},
    {11, 8, 12, 0, 5, 2, 15, 13, 10, 14, 3, 6, 7, 1, 9, 4},
    {7, 9, 3, 1, 13, 12, 11, 14, 2, 6, 5, 10, 4, 0, 15, 8},
    {9, 0, 5, 7, 2, 4, 10, 15, 14, 1, 11, 12, 6, 8, 3, 13},
    {2, 12, 6, 10, 0, 11, 8, 3, 4, 13, 7, 5, 15, 14, 1, 9},
    {12, 5, 1, 15, 14, 13, 4, 10, 0, 7, 6, 3, 9, 2, 8, 11},
    {13, 11, 7, 14, 12, 1, 3, 9, 5, 0, 15, 4, 8, 6, 2, 10},
    {6, 15, 14, 9, 11, 3, 0, 8, 12, 2, 13, 7, 1, 4, 10, 5},
    {10, 2, 8, 4, 7, 6, 1, 5, 15, 11, 9, 14, 3, 12, 13, 0},
    {0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15},
    {14, 10, 4, 8, 9, 15, 13, 6, 1, 12, 0, 2, 11, 7, 5, 3}
};
static const uint64_t b2iv[8] = {0x6a09e667f3bcc908ull, 0xbb67ae8584caa73bull,
                                 0x3c6ef372fe94f82bull, 0xa54ff53a5f1d36f1ull,
                                 0x510e527fade682d1ull, 0x9b05688c2b3e6c1full,
                                 0x1f83d9abfb41bd6bull, 0x5be0cd19137e2179ull};

static uint64_t ror(uint64_t x, int n) {
    return x >> n | x << (64 - n);
}

    #define B2G(a, b, c, d, x, y)                                              \
        v[a] += v[b] + (x), v[d] = ror(v[d] ^ v[a], 32), v[c] += v[d],         \
                            v[b] = ror(v[b] ^ v[c], 24), v[a] += v[b] + (y),   \
                            v[d] = ror(v[d] ^ v[a], 16), v[c] += v[d],         \
                            v[b] = ror(v[b] ^ v[c], 63)

/* one block into the state; t->done already counts it */
static void b2_compress(struct td* t, const uint8_t* blk, int last) {
    uint64_t m[16], v[16];
    for (int i = 0; i < 16; i++) m[i] = ldw(blk + i * 8, 8);
    for (int i = 0; i < 8; i++) v[i] = t->st.w64[i], v[i + 8] = b2iv[i];
    v[12] ^= t->done;
    if (last) v[14] = ~v[14];
    for (int r = 0; r < 12; r++) {
        const uint8_t* s = b2sigma[r];
        B2G(0, 4, 8, 12, m[s[0]], m[s[1]]);
        B2G(1, 5, 9, 13, m[s[2]], m[s[3]]);
        B2G(2, 6, 10, 14, m[s[4]], m[s[5]]);
        B2G(3, 7, 11, 15, m[s[6]], m[s[7]]);
        B2G(0, 5, 10, 15, m[s[8]], m[s[9]]);
        B2G(1, 6, 11, 12, m[s[10]], m[s[11]]);
        B2G(2, 7, 8, 13, m[s[12]], m[s[13]]);
        B2G(3, 4, 9, 14, m[s[14]], m[s[15]]);
    }
    for (int i = 0; i < 8; i++) t->st.w64[i] ^= v[i] ^ v[i + 8];
}

static void b2_update(struct td* t, const uint8_t* p, size_t n) {
    while (n) {
        if (t->n == 128) {
            t->done += 128;
            b2_compress(t, t->buf, 0);
            t->n = 0;
        }
        size_t k = 128 - t->n < n ? 128 - t->n : n;
        memcpy(t->buf + t->n, p, k);
        t->n += (uint32_t) k, p += k, n -= k;
    }
}

static void td_blocks(struct td* t, const uint8_t* p, size_t n) {
    switch (t->alg) {
        case 1: kb_md5_blocks(t->st.w32, p, n); break;
        case 2: kb_sha1_blocks(t->st.w32, p, n); break;
        case 3:
        case 5: kb_sha256_blocks(t->st.w32, p, n); break;
        default: kb_sha512_blocks(t->st.w64, p, n);
    }
}

static int hd_new(int alg) {
    static const uint32_t i32[4][8] = {
        {0x67452301, 0xefcdab89, 0x98badcfe, 0x10325476},
        {0x67452301, 0xefcdab89, 0x98badcfe, 0x10325476, 0xc3d2e1f0},
        {0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c,
         0x1f83d9ab, 0x5be0cd19},
        {0xc1059ed8, 0x367cd507, 0x3070dd17, 0xf70e5939, 0xffc00b31, 0x68581511,
         0x64f98fa7, 0xbefa4fa4}
    };
    static const uint64_t i64[3][8] = {
        {0x6a09e667f3bcc908ull, 0xbb67ae8584caa73bull, 0x3c6ef372fe94f82bull,
         0xa54ff53a5f1d36f1ull, 0x510e527fade682d1ull, 0x9b05688c2b3e6c1full,
         0x1f83d9abfb41bd6bull, 0x5be0cd19137e2179ull},
        {0xcbbb9d5dc1059ed8ull, 0x629a292a367cd507ull, 0x9159015a3070dd17ull,
         0x152fecd8f70e5939ull, 0x67332667ffc00b31ull, 0x8eb44a8768581511ull,
         0xdb0c2e0d64f98fa7ull, 0x47b5481dbefa4fa4ull},
        {0x6a09e667f2bdc948ull, 0xbb67ae8584caa73bull, 0x3c6ef372fe94f82bull,
         0xa54ff53a5f1d36f1ull, 0x510e527fade682d1ull, 0x9b05688c2b3e6c1full,
         0x1f83d9abfb41bd6bull, 0x5be0cd19137e2179ull}
    };
    if (!kb_digest_ready() || alg < 1 || alg > 7) return -1;
    for (int i = 0; i < 16; i++) {
        if (tds[i]) continue;
        struct td* t = calloc(1, sizeof *t);
        if (!t) return -1;
        t->alg = alg;
        if (wide(alg))
            memcpy(t->st.w64, i64[alg == 7 ? 2 : alg == 6], sizeof i64[0]);
        else
            memcpy(t->st.w32, i32[alg == 5 ? 3 : alg - 1], sizeof i32[0]);
        tds[i] = t;
        return i + 1;
    }
    return -1;
}

static int hd_update(int id, const void* p, size_t n) {
    struct td* t = id > 0 && id <= 16 ? tds[id - 1] : NULL;
    size_t block = t && wide(t->alg) ? 128 : 64;
    const uint8_t* b = p;
    if (!t) return -1;
    t->total += n;
    if (t->alg == 7) return b2_update(t, b, n), 0;
    if (t->n) {
        size_t k = block - t->n < n ? block - t->n : n;
        memcpy(t->buf + t->n, b, k);
        t->n += (uint32_t) k, b += k, n -= k;
        if (t->n < block) return 0;
        td_blocks(t, t->buf, 1);
        t->n = 0;
    }
    td_blocks(t, b, n / block);
    memcpy(t->buf, b + n / block * block, n % block);
    t->n = (uint32_t) (n % block);
    return 0;
}

static int hd_finish(int id, void* out) {
    struct td* t = id > 0 && id <= 16 ? tds[id - 1] : NULL;
    if (!t) return -1;
    if (t->alg == 7) {
        uint8_t* b = out;
        t->done += t->n;
        memset(t->buf + t->n, 0, 128 - t->n);
        b2_compress(t, t->buf, 1);
        for (int i = 0; i < 64; i++)
            b[i] = (uint8_t) (t->st.w64[i / 8] >> 8 * (i % 8));
        free(t);
        tds[id - 1] = NULL;
        return 64;
    }
    size_t block = wide(t->alg) ? 128 : 64, lenb = wide(t->alg) ? 16 : 8;
    uint64_t bits = t->total << 3, hi = t->total >> 61;
    uint8_t* b = out;
    t->buf[t->n++] = 0x80;
    if (t->n > block - lenb) {
        memset(t->buf + t->n, 0, block - t->n);
        td_blocks(t, t->buf, 1);
        t->n = 0;
    }
    memset(t->buf + t->n, 0, block - lenb - t->n);
    for (int i = 0; i < 8; i++) {
        uint8_t lo = (uint8_t) (bits >> 8 * i), up = (uint8_t) (hi >> 8 * i);
        if (t->alg == 1)
            t->buf[block - lenb + i] = lo;
        else {
            t->buf[block - 1 - i] = lo;
            if (lenb == 16) t->buf[block - 9 - i] = up;
        }
    }
    td_blocks(t, t->buf, 1);
    /* the words of the result: sha224 keeps 7 of 8, sha384 6 of 8 */
    int wsz = wide(t->alg) ? 8 : 4;
    int nw = t->alg == 1   ? 4
             : t->alg == 2 ? 5
             : t->alg == 5 ? 7
             : t->alg == 6 ? 6
                           : 8;
    for (int i = 0; i < nw; i++) {
        uint64_t w = wsz == 8 ? t->st.w64[i] : t->st.w32[i];
        for (int k = 0; k < wsz; k++)
            b[i * wsz + k] =
                (uint8_t) (w >> 8 * (t->alg == 1 ? k : wsz - 1 - k));
    }
    free(t);
    tds[id - 1] = NULL;
    return nw * wsz;
}

static void hd_drop(int id) {
    if (id > 0 && id <= 16) free(tds[id - 1]), tds[id - 1] = NULL;
}

_Static_assert(sizeof(struct td) <= 256, "a double's state fits a row's blob");

/* a fork child is another process, so the double sends its state in the blob */
static int hd_fork(int id, uint8_t* blob, int* len) {
    struct td* t = id > 0 && id <= 16 ? tds[id - 1] : NULL;
    if (!t) return -1;
    memcpy(blob, t, sizeof *t);
    *len = (int) sizeof *t;
    return 1;
}

static int hd_claim(int ticket, const uint8_t* blob, int len) {
    if (ticket <= 0 || len != (int) sizeof(struct td)) return -1;
    for (int i = 0; i < 16; i++) {
        if (tds[i]) continue;
        struct td* t = calloc(1, sizeof *t);
        if (!t) return -1;
        memcpy(t, blob, sizeof *t);
        tds[i] = t;
        return i + 1;
    }
    return -1;
}
#endif
// #endregion

// #region identity
/* digest-sigs.h's rows, in the order of kb.h's KB_HD_ constants */
static const struct dsig {
    uint32_t len;
    uint64_t head, hash;
    uint32_t
        ret; /* the stream function's call to the block function returns here */
    uint32_t ctx; /* the context's distance above the stack pointer there */
    uint32_t fin; /* where the call to the finish function returns, 0 for r13 */
    uint64_t fhead, fhash;
    int nreg;
    struct {
        int32_t off;
        uint32_t len;
    } reg[3];
    /* the update function a stream with no block function calls, 0 if none */
    uint32_t ulen;
    uint64_t uhead, uhash;
} dsigs[KB_HD_N] = {
#include "digest-sigs.h"
};

/* the context's layout: state, count (two words), length of the buffered tail,
 * then the tail; the host's algorithm number */
static const struct dalg {
    int hid, nw, wsz, block, out, tot, buflen, lensz, buf;
    uint64_t iv[8];
} algs[KB_HD_N] = {
    {1,
     4,
     4,
     64,
     16,
     16,
     24,
     4,
     28,
     {0x67452301, 0xefcdab89, 0x98badcfe, 0x10325476}},
    {2,
     5,
     4,
     64,
     20,
     20,
     28,
     4,
     32,
     {0x67452301, 0xefcdab89, 0x98badcfe, 0x10325476, 0xc3d2e1f0}},
    {3,
     8,
     4,
     64,
     32,
     32,
     40,
     8,
     48,
     {0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c,
      0x1f83d9ab, 0x5be0cd19}},
    {4,
     8,
     8,
     128,
     64,
     64,
     80,
     8,
     88,
     {0x6a09e667f3bcc908ull, 0xbb67ae8584caa73bull, 0x3c6ef372fe94f82bull,
      0xa54ff53a5f1d36f1ull, 0x510e527fade682d1ull, 0x9b05688c2b3e6c1full,
      0x1f83d9abfb41bd6bull, 0x5be0cd19137e2179ull}},
    /* sha224 and sha384 keep the context's layout of sha256 and sha512 and
     * write fewer bytes of the state */
    {5,
     8,
     4,
     64,
     28,
     32,
     40,
     8,
     48,
     {0xc1059ed8, 0x367cd507, 0x3070dd17, 0xf70e5939, 0xffc00b31, 0x68581511,
      0x64f98fa7, 0xbefa4fa4}},
    {6,
     8,
     8,
     128,
     48,
     64,
     80,
     8,
     88,
     {0xcbbb9d5dc1059ed8ull, 0x629a292a367cd507ull, 0x9159015a3070dd17ull,
      0x152fecd8f70e5939ull, 0x67332667ffc00b31ull, 0x8eb44a8768581511ull,
      0xdb0c2e0d64f98fa7ull, 0x47b5481dbefa4fa4ull}},
    /* blake2b's state: h[8], t[2], f[2], the 128-byte buffer, its length; the
     * first word is the IV's xor the parameter block of a 64-byte digest. Its
     * bytes all go to the host, so it has no block size */
    {7,
     8,
     8,
     1,
     64,
     64,
     224,
     8,
     96,
     {0x6a09e667f2bdc948ull, 0xbb67ae8584caa73bull, 0x3c6ef372fe94f82bull,
      0xa54ff53a5f1d36f1ull, 0x510e527fade682d1ull, 0x9b05688c2b3e6c1full,
      0x1f83d9abfb41bd6bull, 0x5be0cd19137e2179ull}},
};

/* the block function an algorithm's stream shares */
static int blockfn(int a) {
    return a == KB_HD_SHA224   ? KB_HD_SHA256
           : a == KB_HD_SHA384 ? KB_HD_SHA512
                               : a;
}

#define FNV0 0xcbf29ce484222325ull
static uint64_t fnv(uint64_t h, const uint8_t* p, size_t n) {
    for (size_t i = 0; i < n; i++) h = (h ^ p[i]) * 0x100000001b3ull;
    return h;
}

/** the hash whose finish function starts at pc (its stub and the code the stub
 * reaches match digest-sigs.h), or -1 */
int kb_digest_at(struct kb_cpu* cpu, uint64_t pc) {
    uint64_t head;
    uint8_t buf[1024];
    if (!kb_read(cpu, pc, &head, 8)) return -1;
    for (int a = 0; a < KB_HD_N; a++) {
        const struct dsig* s = &dsigs[a];
        uint64_t h = FNV0;
        int ok = head == s->fhead;
        for (int r = 0; ok && r < s->nreg; r++)
            ok = s->reg[r].len <= sizeof buf &&
                 kb_read(
                     cpu, pc + (uint64_t) (int64_t) s->reg[r].off, buf,
                     s->reg[r].len
                 ) &&
                 (h = fnv(h, buf, s->reg[r].len), 1);
        if (ok && h == s->fhash) return a;
    }
    return -1;
}

/** the hash whose update function starts at pc, or -1 */
int kb_digest_update_at(struct kb_cpu* cpu, uint64_t pc) {
    uint64_t head;
    uint8_t buf[64];
    if (!kb_read(cpu, pc, &head, 8)) return -1;
    for (int a = 0; a < KB_HD_N; a++) {
        const struct dsig* s = &dsigs[a];
        if (s->ulen && s->ulen <= sizeof buf && head == s->uhead &&
            kb_read(cpu, pc, buf, s->ulen) &&
            fnv(FNV0, buf, s->ulen) == s->uhash)
            return a;
    }
    return -1;
}
// #endregion

// #region owned
enum
{
    OWNED = KB_HD_ROWS
};
static struct owned {
    uint64_t ctx, mark;
    int alg, id, lost;
} owned[OWNED];
static int nowned, unavailable;
static uint64_t serial;

static struct owned* find(uint64_t ctx) {
    for (int i = 0; i < nowned; i++)
        if (owned[i].ctx == ctx) return &owned[i];
    return NULL;
}

static void forget(struct owned* e, int host) {
    if (host) hd_drop(e->id);
    *e = owned[--nowned];
}

static void die(void) {
    fprintf(kb_log, "katybug: a host digest lost its stream\n");
    fflush(kb_log);
    _exit(134);
}

/* the first block call of a stream: ctx is the local of the stream function
 * that made the call, still at its initial state, and nothing else can run
 * before the stream finishes */
static struct owned* start(struct kb_cpu* cpu, int blk, uint64_t ctx) {
    const struct dsig* s = &dsigs[blk];
    uint64_t sp = cpu->r[4], ret, mark = 0;
    uint8_t c[240], body[320];
    if (nowned == OWNED || kb_nthreads != 1) return NULL;
    for (int i = 1; i < 65; i++)
        if (cpu->sig[i].handler > 1) return NULL;
    if (ctx != sp + 8 + s->ctx || !kb_read(cpu, sp, &ret, 8) ||
        s->len > sizeof body || !kb_read(cpu, ret - s->ret, body, s->len) ||
        fnv(FNV0, body, s->len) != s->hash)
        return NULL;
    /* the finish it will call is one found by its bytes: the generic stream
     * function gets it in r13, the others call it directly. It names the
     * algorithm: sha224 and sha256 share a stream and block function */
    uint64_t fin = cpu->r[13];
    if (s->fin) {
        int32_t rel = (int32_t) (body[s->fin - 4] | body[s->fin - 3] << 8 |
                                 body[s->fin - 2] << 16 |
                                 (uint32_t) body[s->fin - 1] << 24);
        fin = ret - s->ret + s->fin + (uint64_t) (int64_t) rel;
    }
    int a = kb_digest_at(cpu, fin);
    if (a < 0 || blockfn(a) != blk) return NULL;
    const struct dalg* g = &algs[a];
    if (!kb_read(cpu, ctx, c, (uint64_t) g->buflen + g->lensz)) return NULL;
    for (int i = 0; i < g->nw; i++)
        if (ldw(c + i * g->wsz, g->wsz) != g->iv[i]) return NULL;
    for (int i = g->tot; i < g->buflen + g->lensz; i++)
        if (c[i]) return NULL;
    int id = hd_new(g->hid);
    if (id <= 0) return unavailable = id < 0, NULL;
    mark = 0x5c5c0000u + (++serial & 0xffff);
    if (!kb_write(
            cpu, ctx + (uint64_t) (g->tot + g->wsz), &mark, (uint64_t) g->wsz
        ))
        return hd_drop(id), NULL;
    owned[nowned] = (struct owned){ctx, mark, a, id, 0};
    return &owned[nowned++];
}

/* the mark is still there: the stream continues */
static int marked(struct kb_cpu* cpu, const struct owned* e) {
    const struct dalg* g = &algs[e->alg];
    uint64_t m = 0;
    return kb_read(
               cpu, e->ctx + (uint64_t) (g->tot + g->wsz), &m, (uint64_t) g->wsz
           ) &&
           m == e->mark;
}

/* a context carrying a mark that no table entry answers for (a fork child that
 * began by exec and did not get the digest): the guest cannot go on with state
 * that is not there */
static void stale(struct kb_cpu* cpu, int a, uint64_t ctx) {
    const struct dalg* g = &algs[a];
    uint64_t m = 0;
    if (kb_read(
            cpu, ctx + (uint64_t) (g->tot + g->wsz), &m, (uint64_t) g->wsz
        ) &&
        m >> 16 == 0x5c5c)
        die();
}

/** 1: the bytes went to a host digest, 0: not for it, -1: a context that has
 * one and could not take them (the guest's own code runs and faults where it
 * always did; the context is lost) */
int kb_digest_block(
    struct kb_cpu* cpu, int a, uint64_t buf, uint64_t len, uint64_t ctx
) {
    struct owned* e = find(ctx);
    if (e && !e->lost && !marked(cpu, e)) forget(e, 1), e = NULL;
    if (!e) {
        if (!len) return 0;
        stale(cpu, a, ctx);
        if (unavailable || !(e = start(cpu, a, ctx))) return 0;
    }
    if (e->lost) die();
    if (len & ((uint64_t) algs[a].block - 1) || !kb_can(cpu, buf, len, KB_R))
        return e->lost = 1, -1;
    for (uint64_t off = 0, k; off < len; off += k) {
        const uint8_t* p = kb_span_r(cpu, buf + off, &k);
        if (k > len - off) k = len - off;
        if (k > 1u << 30) k = 1u << 30;
        if (hd_update(e->id, p, (size_t) k) < 0) return e->lost = 1, -1;
    }
    return 1;
}

/** 1: the digest is in res and the finish function is done, 0: the guest's own
 * finish runs (the context has no host digest) */
int kb_digest_finish(struct kb_cpu* cpu, int a, uint64_t ctx, uint64_t res) {
    const struct dalg* g = &algs[a];
    struct owned* e = find(ctx);
    uint8_t tail[256], d[64], keep[64];
    if (!e) return stale(cpu, a, ctx), 0;
    if (e->lost) die();
    if (e->alg != a || !marked(cpu, e)) return forget(e, 1), 0;
    uint64_t left = 0;
    /* blake2b's host digest has every byte already; the others' tail is in the
     * context */
    if (a != KB_HD_B2 &&
        (!kb_read(
             cpu, ctx + (uint64_t) g->buflen, &left, (uint64_t) g->lensz
         ) ||
         left >= 2 * (uint64_t) g->block ||
         !kb_read(cpu, ctx + (uint64_t) g->buf, tail, left))) {
        e->lost = 1;
        die();
    }
    /* an unwritable result is the guest's own fault, which kills it as it did
     */
    if (!kb_read(cpu, res, keep, (uint64_t) g->out) ||
        !kb_write(cpu, res, keep, (uint64_t) g->out))
        return e->lost = 1, 0;
    if ((left && hd_update(e->id, tail, (size_t) left) < 0) ||
        hd_finish(e->id, d) != g->out ||
        !kb_write(cpu, res, d, (uint64_t) g->out))
        die();
    forget(e, 0);
    /* the sha finishes return the result's address, blake2b's returns 0 */
    cpu->r[0] = a == KB_HD_B2 ? 0 : res;
    return 1;
}

/** an update call of a stream with no block function: 1 if the bytes went to
 * the host digest (the function returns 0), else 0 and the guest's own code
 * runs (also when the context could not take them, as kb_digest_block) */
int kb_digest_update(
    struct kb_cpu* cpu, int alg, uint64_t ctx, uint64_t buf, uint64_t len
) {
    if (kb_digest_block(cpu, alg, buf, len, ctx) <= 0) return 0;
    cpu->r[0] = 0;
    return 1;
}

/** a fork by exec: each open digest's row, with a copy for the child under a
 * ticket; the count */
int kb_digest_fork(struct kb_digest_row rows[KB_HD_ROWS]) {
    for (int i = 0; i < nowned; i++) {
        struct kb_digest_row* r = &rows[i];
        memset(r, 0, sizeof *r);
        r->ctx = owned[i].ctx, r->mark = owned[i].mark;
        r->alg = owned[i].alg, r->lost = owned[i].lost;
        if (!r->lost &&
            (r->ticket = hd_fork(owned[i].id, r->blob, &r->len)) <= 0)
            r->lost = 1;
    }
    return nowned;
}

/** the child's half: the row's digest is the child's if the machine lets it
 * claim the ticket, else the stream is lost and ends the child where it goes on
 */
void kb_digest_adopt(const struct kb_digest_row* r) {
    int id = 0;
    if (nowned == OWNED || r->alg < 0 || r->alg >= KB_HD_N) return;
    if (!r->lost) id = hd_claim(r->ticket, r->blob, r->len);
    owned[nowned++] =
        (struct owned){r->ctx, r->mark, r->alg, id, r->lost || id <= 0};
}
// #endregion
