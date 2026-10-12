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
    uint64_t total;
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

static void td_blocks(struct td* t, const uint8_t* p, size_t n) {
    switch (t->alg) {
        case 1: kb_md5_blocks(t->st.w32, p, n); break;
        case 2: kb_sha1_blocks(t->st.w32, p, n); break;
        case 3: kb_sha256_blocks(t->st.w32, p, n); break;
        default: kb_sha512_blocks(t->st.w64, p, n);
    }
}

static int hd_new(int alg) {
    static const uint32_t i32[3][8] = {
        {0x67452301, 0xefcdab89, 0x98badcfe, 0x10325476},
        {0x67452301, 0xefcdab89, 0x98badcfe, 0x10325476, 0xc3d2e1f0},
        {0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c,
         0x1f83d9ab, 0x5be0cd19}
    };
    static const uint64_t i64[8] = {
        0x6a09e667f3bcc908ull, 0xbb67ae8584caa73bull, 0x3c6ef372fe94f82bull,
        0xa54ff53a5f1d36f1ull, 0x510e527fade682d1ull, 0x9b05688c2b3e6c1full,
        0x1f83d9abfb41bd6bull, 0x5be0cd19137e2179ull
    };
    if (!kb_digest_ready()) return -1;
    for (int i = 0; i < 16; i++) {
        if (tds[i]) continue;
        struct td* t = calloc(1, sizeof *t);
        if (!t) return -1;
        t->alg = alg;
        if (alg == 4)
            memcpy(t->st.w64, i64, sizeof i64);
        else
            memcpy(t->st.w32, i32[alg - 1], sizeof i32[0]);
        tds[i] = t;
        return i + 1;
    }
    return -1;
}

static int hd_update(int id, const void* p, size_t n) {
    struct td* t = id > 0 && id <= 16 ? tds[id - 1] : NULL;
    size_t block = t && t->alg == 4 ? 128 : 64;
    const uint8_t* b = p;
    if (!t) return -1;
    t->total += n;
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
    size_t block = t->alg == 4 ? 128 : 64, lenb = t->alg == 4 ? 16 : 8;
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
    int wsz = t->alg == 4 ? 8 : 4, nw = t->alg == 1 ? 4 : t->alg == 2 ? 5 : 8;
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
};

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

static uint64_t ldw(const uint8_t* p, int n) {
    uint64_t v = 0;
    for (int i = n - 1; i >= 0; i--) v = v << 8 | p[i];
    return v;
}

/* the first block call of a stream: ctx is the local of the stream function
 * that made the call, still at its initial state, and nothing else can run
 * before the stream finishes */
static struct owned* start(struct kb_cpu* cpu, int a, uint64_t ctx) {
    const struct dalg* g = &algs[a];
    const struct dsig* s = &dsigs[a];
    uint64_t sp = cpu->r[4], ret, mark = 0;
    uint8_t c[96], body[320];
    if (nowned == OWNED || kb_nthreads != 1) return NULL;
    for (int i = 1; i < 65; i++)
        if (cpu->sig[i].handler > 1) return NULL;
    if (ctx != sp + 8 + s->ctx || !kb_read(cpu, sp, &ret, 8) ||
        s->len > sizeof body || !kb_read(cpu, ret - s->ret, body, s->len) ||
        fnv(FNV0, body, s->len) != s->hash || !kb_read(cpu, ctx, c, g->buf))
        return NULL;
    for (int i = 0; i < g->nw; i++)
        if (ldw(c + i * g->wsz, g->wsz) != g->iv[i]) return NULL;
    for (int i = g->tot; i < g->buflen + g->lensz; i++)
        if (c[i]) return NULL;
    /* the finish it will call is one found by its bytes: the generic stream
     * function gets it in r13, the others call it directly */
    uint64_t fin = cpu->r[13];
    if (s->fin) {
        int32_t rel = (int32_t) (body[s->fin - 4] | body[s->fin - 3] << 8 |
                                 body[s->fin - 2] << 16 |
                                 (uint32_t) body[s->fin - 1] << 24);
        fin = ret - s->ret + s->fin + (uint64_t) (int64_t) rel;
    }
    if (kb_digest_at(cpu, fin) != a) return NULL;
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
    if (len & ((uint64_t) algs[a].block - 1) || !kb_reach(cpu, buf, len))
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
    if (!kb_read(cpu, ctx + (uint64_t) g->buflen, &left, (uint64_t) g->lensz) ||
        left >= 2 * (uint64_t) g->block ||
        !kb_read(cpu, ctx + (uint64_t) g->buf, tail, left)) {
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
    cpu->r[0] = res;
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
