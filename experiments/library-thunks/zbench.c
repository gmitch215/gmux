#include <errno.h>
#include <signal.h>
#include <stdarg.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/mman.h>
#include <sys/wait.h>
#include <unistd.h>
#include <zlib.h>

/* the guest's libz through the loader's slots: crc32, adler32, compress2 and
 * uncompress. bytes: the deflate output over a 4 MiB corpus at levels 1, 6 and
 * 9, as a length and a hash (what two zlib builds are compared by); check: the
 * calls' results, edge cases and refusals included; run <op> <iters>: crc,
 * adl, def or inf over the corpus, for the timing. katybug's output must be
 * the same with its kernels on and off.
 *
 * The stream modes drive z_stream directly and print, after every call, the
 * return code, avail_in and avail_out, total_in and total_out, adler,
 * data_type, a hash of the bytes the call wrote and msg: levels, chunk sizes,
 * flush modes, window bits, memory levels, strategies, dictionaries, reuse,
 * deflateParams and deflateCopy mid-stream (stream-deflate), damaged input and
 * the inflate entries (stream-inflate), and the rest (stream-misc). alloc,
 * fork and fault are single hazards: a guest zalloc, a stream open across a
 * fork, and buffers that end in unmapped memory. gz and gzrun are the
 * gzip-format round trip over a file and over a generated stream */

static uLong (*volatile f_crc)(uLong, const Bytef*, uInt) = crc32;
static uLong (*volatile f_adl)(uLong, const Bytef*, uInt) = adler32;
static int (*volatile f_def)(Bytef*, uLongf*, const Bytef*, uLong, int) =
    compress2;
static int (*volatile f_inf)(Bytef*, uLongf*, const Bytef*, uLong) = uncompress;

static uint64_t seed = 88172645463325252ull;
static uint64_t rnd(void) {
    seed ^= seed << 13, seed ^= seed >> 7, seed ^= seed << 17;
    return seed;
}

static uint64_t fnv(const void* p, size_t n) {
    const uint8_t* b = p;
    uint64_t h = 1469598103934665603ull;
    for (size_t i = 0; i < n; i++) h = (h ^ b[i]) * 1099511628211ull;
    return h;
}

#define CORPUS (4u << 20)

/* shape 0: text-like words, runs and random bytes in blocks, so every level
 * has matches to find and some data it cannot shrink; 1: zeros; 2: random
 * bytes (stored blocks); 3: words only */
static uint8_t* corpus(size_t n, int shape) {
    static const char* const words[] = {
        "the ",      "of ",     "and ",    "to ",     "in ",
        "kernel ",   "memory ", "thread ", "page ",   "guest ",
        "host ",     "call ",   "byte ",   "return ", "value ",
        "function ", "stream ", "window ", "table ",  "block "
    };
    uint8_t* b = calloc(n, 1);
    for (size_t at = 0; at < n && shape != 1;) {
        size_t len = 512 + rnd() % 3584;
        if (len > n - at) len = n - at;
        switch (shape == 2 ? 3 : shape == 3 ? 0 : rnd() % 4) {
            case 0:
            case 1:
                for (size_t i = 0; i < len;) {
                    const char* w = words[rnd() % 20];
                    for (; *w && i < len; i++) b[at + i] = (uint8_t) *w++;
                }
                break;
            case 2: memset(b + at, (int) (rnd() & 0xff), len); break;
            default:
                for (size_t i = 0; i < len; i++) b[at + i] = (uint8_t) rnd();
        }
        at += len;
    }
    return b;
}

static void bytes(void) {
    static const char* const shapes[] = {"mixed", "zeros", "random", "text"};
    uLongf cap = compressBound(CORPUS);
    uint8_t* out = malloc(cap);
    uint8_t* back = malloc(CORPUS);
    static const int levels[] = {1, 6, 9};
    for (int s = 0; s < 4; s++) {
        uint8_t* in = corpus(CORPUS, s);
        for (int i = 0; i < 3; i++) {
            uLongf n = cap;
            int rc = f_def(out, &n, in, CORPUS, levels[i]);
            uLongf m = CORPUS;
            int rc2 = f_inf(back, &m, out, n);
            printf(
                "compress2 %s level %d rc %d len %lu hash %016llx; "
                "uncompress rc %d %s\n",
                shapes[s], levels[i], rc, (unsigned long) n,
                (unsigned long long) fnv(out, n), rc2,
                m == CORPUS && !memcmp(back, in, CORPUS) ? "same" : "differs"
            );
        }
        free(in);
    }
}

static void line(
    const char* what, int rc, uLongf n, const void* p, size_t len
) {
    printf(
        "%s rc %d len %lu hash %016llx\n", what, rc, (unsigned long) n,
        (unsigned long long) fnv(p, len)
    );
}

static void check(void) {
    uint8_t* in = corpus(300000, 0);
    char name[96];
    /* sums: lengths either side of the small and large cases, unaligned starts,
     * a running value, an init above 32 bits, and a null buffer */
    static const size_t lens[] = {1,    2,    3,    7,     8,     15,  16,
                                  17,   63,   64,   65,    255,   256, 4095,
                                  5551, 5552, 5553, 65536, 100003};
    for (size_t i = 0; i < sizeof lens / sizeof *lens; i++)
        for (int off = 0; off < 3; off++) {
            printf(
                "crc32 n=%zu off=%d %08lx adler32 %08lx\n", lens[i], off,
                f_crc(0, in + off, (uInt) lens[i]),
                f_adl(1, in + off, (uInt) lens[i])
            );
        }
    uLong c = 0, a = 1;
    for (int i = 0; i < 50; i++) {
        c = f_crc(c, in + i * 1000, 1000);
        a = f_adl(a, in + i * 1000, 1000);
    }
    printf("crc32 running %08lx adler32 running %08lx\n", c, a);
    printf(
        "crc32 init %08lx adler32 init %08lx\n", f_crc(0xdeadbeefUL, in, 777),
        f_adl(0xfffefffdUL, in, 777)
    );
    printf(
        "crc32 null %lu adler32 null %lu crc32 zero %08lx\n", f_crc(5, NULL, 0),
        f_adl(5, NULL, 0), f_crc(0x12345678, in, 0)
    );
    /* compress2: every level, a buffer that is too small, a bad level, empty */
    uLongf cap = compressBound(100000);
    uint8_t* out = malloc(cap + 64);
    for (int level = -1; level <= 10; level++) {
        memset(out, 0xa5, cap + 64);
        uLongf n = cap;
        int rc = f_def(out, &n, in, 100000, level);
        snprintf(name, sizeof name, "compress2 level %d", level);
        line(name, rc, n, out, cap + 64);
    }
    static const uLongf small[] = {1, 10, 100, 1000, 40000};
    for (size_t i = 0; i < sizeof small / sizeof *small; i++) {
        memset(out, 0xa5, cap + 64);
        uLongf n = small[i];
        int rc = f_def(out, &n, in, 100000, 6);
        snprintf(
            name, sizeof name, "compress2 dest %lu", (unsigned long) small[i]
        );
        line(name, rc, n, out, cap + 64);
    }
    memset(out, 0xa5, cap + 64);
    uLongf n0 = cap;
    int rc0 = f_def(out, &n0, in, 0, 6);
    line("compress2 empty", rc0, n0, out, cap + 64);
    n0 = 0;
    rc0 = f_def(out, &n0, in, 10, 6);
    line("compress2 dest 0", rc0, n0, out, cap + 64);
    /* uncompress: good data, a short dest, damaged and truncated input */
    uLongf zn = cap;
    f_def(out, &zn, in, 100000, 6);
    uint8_t* z = malloc(zn);
    memcpy(z, out, zn);
    uint8_t* back = malloc(100064);
    for (int variant = 0; variant < 6; variant++) {
        memset(back, 0x5a, 100064);
        uLongf n = 100000;
        uLong src = zn;
        uint8_t* data = z;
        uint8_t* bad = malloc(zn);
        memcpy(bad, z, zn);
        if (variant == 1) n = 50000;
        if (variant == 2) bad[zn / 2] ^= 0x40, data = bad;
        if (variant == 3) src = zn / 2;
        if (variant == 4) bad[0] = 0, data = bad;
        if (variant == 5) n = 100064;
        int rc = f_inf(back, &n, data, src);
        snprintf(name, sizeof name, "uncompress variant %d", variant);
        line(name, rc, n, back, 100064);
        free(bad);
    }
    uLongf en = 0;
    int erc = f_inf(back, &en, z, 0);
    printf("uncompress empty rc %d len %lu\n", erc, (unsigned long) en);
}

// #region streams
struct vec {
    uint8_t* p;
    size_t n, cap;
};

static void push(struct vec* v, const uint8_t* b, size_t n) {
    if (!v || !n) return;
    if (v->n + n > v->cap) {
        v->cap = (v->n + n) * 2;
        v->p = realloc(v->p, v->cap);
    }
    memcpy(v->p + v->n, b, n);
    v->n += n;
}

static char tag[160];
static unsigned long calln;

static void settag(const char* fmt, ...) {
    va_list ap;
    va_start(ap, fmt);
    vsnprintf(tag, sizeof tag, fmt, ap);
    va_end(ap);
    calln = 0;
}

static void show(int rc, const z_stream* z, const uint8_t* out, size_t got) {
    printf(
        "%s #%lu rc %d ai %u ao %u ti %lu to %lu ad %08lx dt %d n %zu h "
        "%016llx "
        "msg %s\n",
        tag, calln++, rc, z->avail_in, z->avail_out,
        (unsigned long) z->total_in, (unsigned long) z->total_out,
        (unsigned long) z->adler, z->data_type, got,
        (unsigned long long) fnv(out, got), z->msg ? z->msg : "-"
    );
}

static uint8_t* input(size_t n, int shape) {
    seed = 88172645463325252ull;
    return corpus(n, shape);
}

/* deflate or inflate over in[0, n) in pieces of inchunk bytes with room for
 * outchunk bytes per call, resumable: a call is made again with the same flush
 * while the stream still holds input. fin: the call that follows the last piece
 * is Z_FINISH */
struct ctx {
    const uint8_t* in;
    size_t n, pos, inchunk, outchunk;
    int flush, fin;
    struct vec* o;
};

static int def_go(z_stream* z, struct ctx* c) {
    uint8_t* out = malloc(c->outchunk);
    int rc = Z_OK, idle = 0;
    for (int guard = 0; guard < 20000000; guard++) {
        if (z->avail_in == 0 && c->pos < c->n) {
            size_t take = c->n - c->pos;
            if (take > c->inchunk) take = c->inchunk;
            z->next_in = (z_const Bytef*) c->in + c->pos;
            z->avail_in = (uInt) take;
            c->pos += take;
        }
        int last = c->fin && c->pos >= c->n;
        unsigned long prog = (unsigned long) (z->total_in + z->total_out);
        z->next_out = out;
        z->avail_out = (uInt) c->outchunk;
        rc = deflate(z, last ? Z_FINISH : c->flush);
        size_t got = c->outchunk - z->avail_out;
        show(rc, z, out, got);
        push(c->o, out, got);
        if (rc == Z_STREAM_END || (rc < 0 && rc != Z_BUF_ERROR)) break;
        if (!last && c->pos >= c->n && z->avail_in == 0 && z->avail_out != 0)
            break;
        idle =
            prog == (unsigned long) (z->total_in + z->total_out) ? idle + 1 : 0;
        if (idle > 3) break;
    }
    free(out);
    return rc;
}

static int inf_go(z_stream* z, struct ctx* c) {
    uint8_t* out = malloc(c->outchunk);
    int rc = Z_OK, idle = 0;
    for (int guard = 0; guard < 20000000; guard++) {
        if (z->avail_in == 0 && c->pos < c->n) {
            size_t take = c->n - c->pos;
            if (take > c->inchunk) take = c->inchunk;
            z->next_in = (z_const Bytef*) c->in + c->pos;
            z->avail_in = (uInt) take;
            c->pos += take;
        }
        unsigned long prog = (unsigned long) (z->total_in + z->total_out);
        z->next_out = out;
        z->avail_out = (uInt) c->outchunk;
        rc = inflate(z, c->flush);
        size_t got = c->outchunk - z->avail_out;
        show(rc, z, out, got);
        push(c->o, out, got);
        if (rc == Z_STREAM_END || rc == Z_NEED_DICT ||
            (rc < 0 && rc != Z_BUF_ERROR))
            break;
        idle =
            prog == (unsigned long) (z->total_in + z->total_out) ? idle + 1 : 0;
        if (idle > 3 || (!got && z->avail_in == 0 && c->pos >= c->n)) break;
    }
    free(out);
    return rc;
}

static struct ctx mk(
    const uint8_t* in, size_t n, size_t inc, size_t outc, int flush, int fin,
    struct vec* o
) {
    return (struct ctx){in, n, 0, inc, outc, flush, fin, o};
}

/* the stream's own fields, as init left them */
static void born(const char* what, int rc, const z_stream* z) {
    printf(
        "%s init rc %d dt %d ad %08lx msg %s\n", what, rc, z->data_type,
        (unsigned long) z->adler, z->msg ? z->msg : "-"
    );
}

/* a one-shot deflate without output lines, for inputs to the inflate tests */
static size_t comp(
    int wbits, int level, const uint8_t* in, size_t n, uint8_t** out
) {
    z_stream z;
    memset(&z, 0, sizeof z);
    deflateInit2(&z, level, Z_DEFLATED, wbits, 8, Z_DEFAULT_STRATEGY);
    size_t cap = deflateBound(&z, (uLong) n) + 64;
    *out = malloc(cap);
    z.next_in = (z_const Bytef*) in;
    z.avail_in = (uInt) n;
    z.next_out = *out;
    z.avail_out = (uInt) cap;
    deflate(&z, Z_FINISH);
    size_t got = cap - z.avail_out;
    deflateEnd(&z);
    return got;
}

/* deflate then inflate with the same window bits and chunks */
static void one(
    const char* name, int level, int wbits, int mem, int strat, size_t inc,
    size_t outc, int flush, const uint8_t* in, size_t n
) {
    z_stream z;
    struct vec o = {0}, back = {0};
    memset(&z, 0, sizeof z);
    settag(
        "%s L%d w%d m%d s%d i%zu o%zu f%d", name, level, wbits, mem, strat, inc,
        outc, flush
    );
    int rc = deflateInit2(&z, level, Z_DEFLATED, wbits, mem, strat);
    born("d", rc, &z);
    if (rc != Z_OK) return;
    struct ctx c = mk(in, n, inc, outc, flush, 1, &o);
    def_go(&z, &c);
    printf("%s end rc %d\n", tag, deflateEnd(&z));
    memset(&z, 0, sizeof z);
    int iw = wbits > 0 && wbits < 15 ? 15 : wbits;
    char base[160];
    memcpy(base, tag, sizeof base);
    settag("%s-rt", base);
    rc = inflateInit2(&z, iw);
    born("i", rc, &z);
    c = mk(o.p, o.n, inc, outc, Z_NO_FLUSH, 0, &back);
    inf_go(&z, &c);
    printf(
        "%s end rc %d same %d\n", tag, inflateEnd(&z),
        back.n == n && !memcmp(back.p, in, n)
    );
    free(o.p);
    free(back.p);
}

static void set_levels(void) {
    static const int levels[] = {0, 1, 6, 9};
    static const struct {
        size_t in, out, n;
    } pairs[] = {{1, 1, 2000},         {100, 100, 60000},
                 {4096, 4096, 300000}, {65536, 65536, 300000},
                 {1, 4096, 2000},      {4096, 1, 2000},
                 {65536, 100, 60000},  {100, 65536, 60000}};
    for (size_t l = 0; l < 4; l++)
        for (size_t p = 0; p < 8; p++) {
            uint8_t* in = input(pairs[p].n, 0);
            one("levels", levels[l], 15, 8, 0, pairs[p].in, pairs[p].out,
                Z_NO_FLUSH, in, pairs[p].n);
            free(in);
        }
}

static void set_flush(void) {
    static const int modes[] = {Z_NO_FLUSH,   Z_PARTIAL_FLUSH, Z_SYNC_FLUSH,
                                Z_FULL_FLUSH, Z_BLOCK,         Z_FINISH};
    static const int levels[] = {0, 1, 6, 9};
    uint8_t* in = input(100000, 0);
    for (size_t l = 0; l < 4; l++)
        for (size_t m = 0; m < 6; m++) {
            one("flush", levels[l], 15, 8, 0, 4096, 4096, modes[m], in, 100000);
            one("flush", levels[l], 15, 8, 0, 1000, 300, modes[m], in, 20000);
        }
    for (size_t l = 0; l < 4; l++) {
        one("whole", levels[l], 15, 8, 0, 100000, 65536, Z_NO_FLUSH, in,
            100000);
        one("whole", levels[l], 15, 8, 0, 100000, 100, Z_NO_FLUSH, in, 100000);
        one("whole", levels[l], 15, 8, 0, 100000, 1000000, Z_NO_FLUSH, in,
            100000);
    }
    free(in);
}

static void set_window(void) {
    static const int wbits[] = {15, -15, 31, 9, 12, -12, 25, -9};
    static const int mems[] = {1, 9};
    static const int levels[] = {1, 6};
    uint8_t* in = input(50000, 0);
    for (size_t w = 0; w < 8; w++)
        for (size_t m = 0; m < 2; m++)
            for (size_t l = 0; l < 2; l++)
                one("window", levels[l], wbits[w], mems[m], 0, 4096, 4096,
                    Z_NO_FLUSH, in, 50000);
    free(in);
}

static void set_strategy(void) {
    static const int levels[] = {1, 6, 9};
    uint8_t* in = input(60000, 0);
    for (int s = 1; s <= 4; s++)
        for (size_t l = 0; l < 3; l++)
            one("strategy", levels[l], 15, 8, s, 4096, 4096, Z_NO_FLUSH, in,
                60000);
    free(in);
    for (int shape = 1; shape <= 3; shape++) {
        in = input(40000, shape);
        for (int s = 0; s <= 4; s++)
            one("shape", 6, 15, 8, s, 4096, 4096, Z_NO_FLUSH, in, 40000);
        free(in);
    }
}

static void set_dict(void) {
    uint8_t *dict = input(4000, 3), *in = input(20000, 3), buf[32768];
    uInt len;
    for (int w = 0; w < 2; w++)
        for (int level = 1; level <= 9; level += 4) {
            int wb = w ? -15 : 15;
            z_stream z;
            struct vec o = {0}, back = {0};
            memset(&z, 0, sizeof z);
            settag("dict L%d w%d", level, wb);
            deflateInit2(&z, level, Z_DEFLATED, wb, 8, 0);
            int rc = deflateSetDictionary(&z, dict, 4000);
            printf("%s set rc %d ad %08lx\n", tag, rc, (unsigned long) z.adler);
            len = 0;
            rc = deflateGetDictionary(&z, buf, &len);
            printf(
                "%s get rc %d len %u h %016llx\n", tag, rc, len,
                (unsigned long long) fnv(buf, len)
            );
            struct ctx c = mk(in, 20000, 4096, 4096, Z_NO_FLUSH, 1, &o);
            def_go(&z, &c);
            len = 0;
            rc = deflateGetDictionary(&z, buf, &len);
            printf(
                "%s get2 rc %d len %u h %016llx\n", tag, rc, len,
                (unsigned long long) fnv(buf, len)
            );
            deflateEnd(&z);
            for (int bad = 0; bad < 2; bad++) {
                memset(&z, 0, sizeof z);
                settag("dict-rt L%d w%d bad%d", level, wb, bad);
                inflateInit2(&z, wb);
                const uint8_t* d = bad ? in : dict;
                if (wb < 0) {
                    rc = inflateSetDictionary(&z, d, 4000);
                    printf("%s set rc %d\n", tag, rc);
                }
                struct ctx ic = mk(o.p, o.n, 1000, 1000, Z_NO_FLUSH, 0, &back);
                rc = inf_go(&z, &ic);
                if (rc == Z_NEED_DICT) {
                    printf("%s need ad %08lx\n", tag, (unsigned long) z.adler);
                    rc = inflateSetDictionary(&z, d, 4000);
                    printf("%s set rc %d\n", tag, rc);
                    rc = inf_go(&z, &ic);
                }
                len = 0;
                rc = inflateGetDictionary(&z, buf, &len);
                printf(
                    "%s get rc %d len %u h %016llx\n", tag, rc, len,
                    (unsigned long long) fnv(buf, len)
                );
                printf(
                    "%s end rc %d same %d\n", tag, inflateEnd(&z),
                    back.n == 20000 && !memcmp(back.p, in, 20000)
                );
                back.n = 0;
            }
            free(o.p);
            free(back.p);
        }
    free(dict);
    free(in);
}

static void set_reuse(void) {
    uint8_t* a = input(30000, 0);
    uint8_t* b = input(50000, 3);
    uint8_t *za, *zb;
    size_t zan = comp(15, 6, a, 30000, &za), zbn = comp(15, 6, b, 50000, &zb);
    z_stream z;
    memset(&z, 0, sizeof z);
    settag("reuse-def");
    deflateInit(&z, 6);
    struct vec o = {0};
    struct ctx c = mk(a, 30000, 4096, 4096, Z_NO_FLUSH, 1, &o);
    def_go(&z, &c);
    printf("%s reset rc %d\n", tag, deflateReset(&z));
    show(0, &z, NULL, 0);
    c = mk(b, 50000, 1000, 5000, Z_SYNC_FLUSH, 1, &o);
    def_go(&z, &c);
    printf("%s resetkeep rc %d\n", tag, deflateResetKeep(&z));
    show(0, &z, NULL, 0);
    c = mk(a, 30000, 4096, 4096, Z_NO_FLUSH, 1, &o);
    def_go(&z, &c);
    printf("%s reset rc %d\n", tag, deflateReset(&z));
    printf("%s end rc %d\n", tag, deflateEnd(&z));
    memset(&z, 0, sizeof z);
    settag("reuse-inf");
    inflateInit(&z);
    struct vec back = {0};
    c = mk(za, zan, 4096, 4096, Z_NO_FLUSH, 0, &back);
    inf_go(&z, &c);
    printf("%s reset rc %d\n", tag, inflateReset(&z));
    show(0, &z, NULL, 0);
    c = mk(zb, zbn, 77, 1000, Z_NO_FLUSH, 0, &back);
    inf_go(&z, &c);
    printf("%s resetkeep rc %d\n", tag, inflateResetKeep(&z));
    show(0, &z, NULL, 0);
    c = mk(za, zan, 4096, 4096, Z_NO_FLUSH, 0, &back);
    inf_go(&z, &c);
    printf("%s reset2 rc %d\n", tag, inflateReset2(&z, -15));
    uint8_t* raw;
    size_t rn = comp(-15, 6, a, 30000, &raw);
    c = mk(raw, rn, 4096, 4096, Z_NO_FLUSH, 0, &back);
    inf_go(&z, &c);
    printf("%s reset2 rc %d\n", tag, inflateReset2(&z, 31));
    printf("%s reset2 rc %d\n", tag, inflateReset2(&z, 99));
    printf("%s end rc %d total %zu\n", tag, inflateEnd(&z), back.n);
    free(a);
    free(b);
    free(za);
    free(zb);
    free(raw);
    free(o.p);
    free(back.p);
}

/* deflateParams with input and output pending */
static void set_params(void) {
    static const int cases[][4] = {{1, 0, 9, 1}, {9, 0, 0, 0}, {0, 0, 6, 0},
                                   {6, 0, 6, 2}, {6, 1, 6, 3}, {3, 0, 1, 0}};
    static const size_t outs[] = {100, 4096, 65536};
    uint8_t* in = input(100000, 0);
    for (size_t k = 0; k < 6; k++)
        for (size_t oc = 0; oc < 3; oc++) {
            z_stream z;
            struct vec o = {0}, back = {0};
            uint8_t* buf = malloc(outs[oc]);
            memset(&z, 0, sizeof z);
            settag(
                "params %d,%d>%d,%d o%zu", cases[k][0], cases[k][1],
                cases[k][2], cases[k][3], outs[oc]
            );
            deflateInit2(&z, cases[k][0], Z_DEFLATED, 15, 8, cases[k][1]);
            z.next_in = in;
            z.avail_in = 40000;
            z.next_out = buf;
            z.avail_out = (uInt) outs[oc];
            int rc = deflate(&z, Z_NO_FLUSH);
            show(rc, &z, buf, outs[oc] - z.avail_out);
            push(&o, buf, outs[oc] - z.avail_out);
            z.next_out = buf;
            z.avail_out = (uInt) outs[oc];
            rc = deflateParams(&z, cases[k][2], cases[k][3]);
            show(rc, &z, buf, outs[oc] - z.avail_out);
            push(&o, buf, outs[oc] - z.avail_out);
            struct ctx c = mk(in + 40000, 60000, 4096, 4096, Z_NO_FLUSH, 1, &o);
            def_go(&z, &c);
            printf("%s end rc %d\n", tag, deflateEnd(&z));
            memset(&z, 0, sizeof z);
            inflateInit(&z);
            struct ctx ic = mk(o.p, o.n, 4096, 4096, Z_NO_FLUSH, 0, &back);
            settag("params-rt %d o%zu", (int) k, outs[oc]);
            inf_go(&z, &ic);
            printf(
                "%s same %d\n", tag,
                back.n == 100000 && !memcmp(back.p, in, 100000)
            );
            inflateEnd(&z);
            free(buf);
            free(o.p);
            free(back.p);
        }
    free(in);
}

static void set_copy(void) {
    uint8_t* in = input(80000, 0);
    for (int level = 1; level <= 9; level += 4) {
        z_stream z, y;
        struct vec o = {0}, p = {0};
        memset(&z, 0, sizeof z);
        deflateInit(&z, level);
        settag("copy L%d a", level);
        struct ctx c = mk(in, 40000, 4096, 4096, Z_NO_FLUSH, 0, &o);
        def_go(&z, &c);
        memset(&y, 0xa5, sizeof y);
        int rc = deflateCopy(&y, &z);
        printf(
            "%s copy rc %d ti %lu to %lu ad %08lx msg %s\n", tag, rc,
            (unsigned long) y.total_in, (unsigned long) y.total_out,
            (unsigned long) y.adler, y.msg ? y.msg : "-"
        );
        p.n = 0;
        push(&p, o.p, o.n);
        struct ctx c2 = mk(in + 40000, 40000, 4096, 4096, Z_NO_FLUSH, 1, &o);
        def_go(&z, &c2);
        settag("copy L%d b", level);
        struct ctx c3 = mk(in + 40000, 40000, 3000, 77, Z_SYNC_FLUSH, 1, &p);
        def_go(&y, &c3);
        printf("%s end %d %d\n", tag, deflateEnd(&z), deflateEnd(&y));
        printf("%s lengths %zu %zu\n", tag, o.n, p.n);
        free(o.p);
        free(p.p);
    }
    uint8_t* zz;
    size_t zn = comp(15, 6, in, 80000, &zz);
    z_stream z, y;
    struct vec o = {0}, p = {0};
    memset(&z, 0, sizeof z);
    inflateInit(&z);
    settag("icopy a");
    struct ctx c = mk(zz, zn / 2, 1000, 3000, Z_NO_FLUSH, 0, &o);
    inf_go(&z, &c);
    memset(&y, 0xa5, sizeof y);
    int rc = inflateCopy(&y, &z);
    printf(
        "%s copy rc %d ti %lu to %lu msg %s\n", tag, rc,
        (unsigned long) y.total_in, (unsigned long) y.total_out,
        y.msg ? y.msg : "-"
    );
    struct ctx c2 = mk(zz + zn / 2, zn - zn / 2, 1000, 3000, Z_NO_FLUSH, 0, &o);
    z.avail_in = 0;
    inf_go(&z, &c2);
    settag("icopy b");
    struct ctx c3 = mk(zz + zn / 2, zn - zn / 2, 17, 50000, Z_NO_FLUSH, 0, &p);
    y.avail_in = 0;
    inf_go(&y, &c3);
    printf(
        "%s end %d %d lengths %zu %zu\n", tag, inflateEnd(&z), inflateEnd(&y),
        o.n, p.n
    );
    free(zz);
    free(in);
}
static int inflate_run(
    int wbits, const uint8_t* z, size_t zn, size_t inc, size_t outc, int flush,
    struct vec* back
) {
    z_stream s;
    memset(&s, 0, sizeof s);
    int rc = inflateInit2(&s, wbits);
    if (rc != Z_OK) {
        printf("%s init rc %d\n", tag, rc);
        return rc;
    }
    struct ctx c = mk(z, zn, inc, outc, flush, 0, back);
    rc = inf_go(&s, &c);
    printf("%s end rc %d\n", tag, inflateEnd(&s));
    return rc;
}

/* inflate over streams cut short, bit-flipped, followed by garbage and with a
 * bad header, in each format */
static void set_errors(void) {
    static const int wbs[] = {15, -15, 31};
    static const char* const nm[] = {"zlib", "raw", "gzip"};
    for (int f = 0; f < 3; f++) {
        for (int small = 0; small < 2; small++) {
            size_t n = small ? 300 : 3000, step = small ? 7 : 97;
            size_t inc = small ? 1 : 4096, outc = small ? 100 : 4096;
            uint8_t* in = input(n, 0);
            uint8_t* z;
            size_t zn = comp(wbs[f], 6, in, n, &z);
            for (size_t cut = 0; cut < zn; cut += cut < 24 ? 1 : step) {
                settag("trunc %s s%d cut %zu", nm[f], small, cut);
                inflate_run(wbs[f], z, cut, inc, outc, Z_NO_FLUSH, NULL);
            }
            settag("trunc %s s%d last", nm[f], small);
            inflate_run(wbs[f], z, zn - 1, inc, outc, Z_NO_FLUSH, NULL);
            for (size_t at = 0; at < zn; at += at < 24 ? 1 : step) {
                uint8_t* bad = malloc(zn);
                memcpy(bad, z, zn);
                bad[at] ^= 0x10;
                settag("flip %s s%d at %zu", nm[f], small, at);
                inflate_run(wbs[f], bad, zn, inc, outc, Z_NO_FLUSH, NULL);
                free(bad);
            }
            uint8_t* tail = malloc(zn + 100);
            memcpy(tail, z, zn);
            for (int i = 0; i < 100; i++) tail[zn + i] = (uint8_t) (i * 7 + 1);
            settag("trailing %s s%d", nm[f], small);
            inflate_run(wbs[f], tail, zn + 100, inc, outc, Z_NO_FLUSH, NULL);
            settag("trailing-finish %s s%d", nm[f], small);
            inflate_run(wbs[f], tail, zn + 100, inc, outc, Z_FINISH, NULL);
            free(tail);
            free(z);
            free(in);
        }
    }
}

/* the same streams read under every window bits setting */
static void set_formats(void) {
    static const int wbs[] = {15, -15, 31, 47, 0, 9, 25, 8, 16, 40};
    static const int enc[] = {15, -15, 31};
    static const char* const nm[] = {"zlib", "raw", "gzip"};
    uint8_t* in = input(5000, 0);
    for (int f = 0; f < 3; f++) {
        uint8_t* z;
        size_t zn = comp(enc[f], 6, in, 5000, &z);
        for (size_t w = 0; w < sizeof wbs / sizeof *wbs; w++) {
            settag("format %s as w%d", nm[f], wbs[w]);
            inflate_run(wbs[w], z, zn, 4096, 4096, Z_NO_FLUSH, NULL);
        }
        free(z);
    }
    /* a stream written with a smaller window than the reader's, and larger */
    for (int w = 9; w <= 15; w += 3) {
        uint8_t* z;
        size_t zn = comp(w, 6, in, 5000, &z);
        for (int r = 9; r <= 15; r += 3) {
            settag("window w%d read r%d", w, r);
            inflate_run(r, z, zn, 4096, 4096, Z_NO_FLUSH, NULL);
        }
        free(z);
    }
    free(in);
}

/* a gzip stream with every header field set, and one with a wrong header crc */
static void set_gzhand(void) {
    uint8_t* in = input(3000, 0);
    uint8_t* raw;
    size_t rn = comp(-15, 6, in, 3000, &raw);
    for (int bad = 0; bad < 3; bad++) {
        uint8_t* g = malloc(rn + 128);
        size_t k = 0;
        static const uint8_t head[10] = {0x1f, 0x8b, 8, 0x1e, 1, 2, 3, 4, 0, 3};
        memcpy(g, head, 10);
        k = 10;
        g[k++] = 6, g[k++] = 0;
        memcpy(g + k, "abcdef", 6);
        k += 6;
        memcpy(g + k, "file.txt", 9);
        k += 9;
        memcpy(g + k, "hello", 6);
        k += 6;
        uLong hc = crc32(0, g, (uInt) k);
        g[k++] = (uint8_t) (hc & 0xff) ^ (bad == 1);
        g[k++] = (uint8_t) (hc >> 8 & 0xff);
        memcpy(g + k, raw, rn);
        k += rn;
        uLong crc = crc32(0, in, 3000) ^ (bad == 2);
        for (int i = 0; i < 4; i++) g[k++] = (uint8_t) (crc >> 8 * i);
        for (int i = 0; i < 4; i++) g[k++] = (uint8_t) (3000 >> 8 * i);
        static const size_t incs[] = {1, 7, 4096};
        for (size_t i = 0; i < 3; i++) {
            settag("gzhand bad%d i%zu", bad, incs[i]);
            inflate_run(31, g, k, incs[i], 1000, Z_NO_FLUSH, NULL);
        }
        free(g);
    }
    free(raw);
    free(in);
}

static void set_sync(void) {
    static const int wbs[] = {15, -15};
    uint8_t* in = input(4800, 0);
    for (int w = 0; w < 2; w++)
        for (int hit = 0; hit < 3; hit++) {
            z_stream z;
            struct vec o = {0};
            memset(&z, 0, sizeof z);
            deflateInit2(&z, 6, Z_DEFLATED, wbs[w], 8, 0);
            uint8_t out[8192];
            for (int blk = 0; blk < 6; blk++) {
                z.next_in = in + blk * 800;
                z.avail_in = 800;
                z.next_out = out;
                z.avail_out = sizeof out;
                deflate(&z, blk == 5 ? Z_FINISH : Z_SYNC_FLUSH);
                push(&o, out, sizeof out - z.avail_out);
            }
            deflateEnd(&z);
            o.p[3 + hit * 100] ^= 0x55;
            static const size_t incs[] = {4096, 7};
            for (int ii = 0; ii < 2; ii++) {
                memset(&z, 0, sizeof z);
                settag("sync w%d hit%d i%zu", wbs[w], hit, incs[ii]);
                inflateInit2(&z, wbs[w]);
                struct vec back = {0};
                struct ctx c =
                    mk(o.p, o.n, incs[ii], 3000, Z_NO_FLUSH, 0, &back);
                int rc = inf_go(&z, &c);
                for (int round = 0; rc == Z_DATA_ERROR && round < 8; round++) {
                    int s;
                    int tries = 0;
                    do {
                        if (z.avail_in == 0 && c.pos < c.n) {
                            size_t take = c.n - c.pos;
                            if (take > c.inchunk) take = c.inchunk;
                            z.next_in = (z_const Bytef*) c.in + c.pos;
                            z.avail_in = (uInt) take;
                            c.pos += take;
                        }
                        s = inflateSync(&z);
                        printf(
                            "%s sync rc %d ai %u ti %lu to %lu sp %d\n", tag, s,
                            z.avail_in, (unsigned long) z.total_in,
                            (unsigned long) z.total_out, inflateSyncPoint(&z)
                        );
                    } while (s != Z_OK && (z.avail_in || c.pos < c.n) &&
                             ++tries < 100000);
                    if (s != Z_OK) break;
                    rc = inf_go(&z, &c);
                }
                printf(
                    "%s end rc %d total %zu h %016llx\n", tag, inflateEnd(&z),
                    back.n, (unsigned long long) fnv(back.p, back.n)
                );
                free(back.p);
            }
            free(o.p);
        }
    free(in);
}

static void set_misc(void) {
    uint8_t* in = input(60000, 0);
    uint8_t out[70000];
    static const unsigned long lens[] = {0,     1,        100,
                                         65536, 1u << 20, 0x3fffffffu};
    static const int cfg[][4] = {{6, 15, 8, 0}, {1, 9, 1, 0},  {9, -15, 9, 1},
                                 {6, 31, 8, 0}, {0, 15, 8, 0}, {6, 15, 7, 0}};
    for (size_t k = 0; k < 6; k++) {
        z_stream z;
        memset(&z, 0, sizeof z);
        deflateInit2(
            &z, cfg[k][0], Z_DEFLATED, cfg[k][1], cfg[k][2], cfg[k][3]
        );
        settag("bound cfg%zu", k);
        for (int phase = 0; phase < 2; phase++) {
            for (size_t i = 0; i < 6; i++)
                printf(
                    "%s p%d %lu -> %lu\n", tag, phase, lens[i],
                    (unsigned long) deflateBound(&z, lens[i])
                );
            z.next_in = in;
            z.avail_in = 5000;
            z.next_out = out;
            z.avail_out = sizeof out;
            deflate(&z, Z_NO_FLUSH);
        }
        deflateEnd(&z);
    }
    {
        z_stream z;
        memset(&z, 0, sizeof z);
        deflateInit2(&z, 6, Z_DEFLATED, -15, 8, 0);
        settag("pending");
        printf(
            "%s prime %d %d %d\n", tag, deflatePrime(&z, 3, 5),
            deflatePrime(&z, 17, 0), deflatePrime(&z, 0, 0)
        );
        printf("%s tune %d\n", tag, deflateTune(&z, 8, 16, 128, 128));
        unsigned pend;
        int bits;
        z.next_in = in;
        z.avail_in = 20000;
        for (int i = 0; i < 12; i++) {
            z.next_out = out;
            z.avail_out = 7;
            int rc = deflate(&z, i == 11 ? Z_FINISH : Z_SYNC_FLUSH);
            pend = 99, bits = 99;
            int p1 = deflatePending(&z, &pend, &bits);
            printf(
                "%s call rc %d ao %u ai %u pending %d %u %d\n", tag, rc,
                z.avail_out, z.avail_in, p1, pend, bits
            );
            pend = 99;
            int p2 = deflatePending(&z, &pend, NULL);
            bits = 99;
            int p3 = deflatePending(&z, NULL, &bits);
            printf("%s only %d %u %d %d\n", tag, p2, pend, p3, bits);
        }
        printf("%s null %d\n", tag, deflatePending(&z, NULL, NULL));
        deflateEnd(&z);
    }
    {
        /* Z_BLOCK and Z_TREES stop at block boundaries; inflateMark tracks them
         */
        uint8_t* zz;
        size_t zn = comp(15, 6, in, 60000, &zz);
        static const int flushes[] = {
            Z_BLOCK, Z_TREES, Z_SYNC_FLUSH, Z_FINISH, Z_NO_FLUSH
        };
        for (size_t f = 0; f < 5; f++) {
            z_stream z;
            memset(&z, 0, sizeof z);
            inflateInit(&z);
            settag("mark f%d", flushes[f]);
            z.next_in = zz;
            z.avail_in = (uInt) zn;
            for (int i = 0; i < 400; i++) {
                z.next_out = out;
                z.avail_out = 20000;
                int rc = inflate(&z, flushes[f]);
                printf(
                    "%s call rc %d ai %u ao %u dt %d mark %ld sp %d codes "
                    "%lu\n",
                    tag, rc, z.avail_in, z.avail_out, z.data_type,
                    inflateMark(&z), inflateSyncPoint(&z), inflateCodesUsed(&z)
                );
                if (rc != Z_OK && rc != Z_BUF_ERROR) break;
                if (rc == Z_BUF_ERROR && !z.avail_in) break;
            }
            printf("%s end %d\n", tag, inflateEnd(&z));
        }
        uint8_t* gz;
        size_t gn = comp(31, 6, in, 60000, &gz);
        for (int mode = 0; mode < 4; mode++) {
            uint8_t* bad = malloc(gn);
            memcpy(bad, gz, gn);
            bad[gn - 6] ^= 0x01;
            z_stream z;
            memset(&z, 0, sizeof z);
            inflateInit2(&z, 31);
            settag("validate mode%d", mode);
            if (mode == 1)
                printf("%s validate %d\n", tag, inflateValidate(&z, 0));
            if (mode == 2)
                printf("%s undermine %d\n", tag, inflateUndermine(&z, 1));
            if (mode == 3)
                printf(
                    "%s prime %d %d %d\n", tag, inflatePrime(&z, 3, 7),
                    inflatePrime(&z, 17, 0), inflatePrime(&z, -1, 0)
                );
            z.next_in = bad;
            z.avail_in = (uInt) gn;
            z.next_out = out;
            z.avail_out = sizeof out;
            int rc = inflate(&z, Z_FINISH);
            show(rc, &z, out, sizeof out - z.avail_out);
            printf("%s end %d\n", tag, inflateEnd(&z));
            free(bad);
        }
        free(zz);
        free(gz);
    }
    /* inflate and deflate flush values on the chunk pairs */
    {
        uint8_t* zz;
        size_t zn = comp(15, 6, in, 20000, &zz);
        static const int flushes[] = {Z_NO_FLUSH,     Z_SYNC_FLUSH,
                                      Z_FINISH,       Z_BLOCK,
                                      Z_TREES,        Z_FULL_FLUSH,
                                      Z_PARTIAL_FLUSH};
        static const size_t pr[][2] = {
            {4096, 4096}, {1, 1}, {100, 7}, {65536, 65536}
        };
        for (size_t f = 0; f < 7; f++)
            for (size_t p = 0; p < 4; p++) {
                size_t n = pr[p][0] == 1 ? 300 : 20000;
                uint8_t* z1;
                size_t z1n = n == 300 ? comp(15, 6, in, 300, &z1) : zn;
                settag("iflush f%d i%zu o%zu", flushes[f], pr[p][0], pr[p][1]);
                inflate_run(
                    15, n == 300 ? z1 : zz, z1n, pr[p][0], pr[p][1], flushes[f],
                    NULL
                );
                if (n == 300) free(z1);
            }
        free(zz);
    }
    free(in);
}

/* calls the library refuses or that mix up what a stream is */
static void set_wrong(void) {
    z_stream z;
    uint8_t out[4096], in[64];
    memset(in, 'x', sizeof in);
    settag("wrong");
    memset(&z, 0, sizeof z);
    printf("%s badver %d\n", tag, deflateInit_(&z, 6, "0.0.0", (int) sizeof z));
    printf("%s badsize %d\n", tag, deflateInit_(&z, 6, ZLIB_VERSION, 1));
    printf("%s badlevel %d\n", tag, deflateInit(&z, 11));
    printf("%s badwbits %d\n", tag, inflateInit2(&z, 7));
    printf("%s badmem %d\n", tag, deflateInit2(&z, 6, Z_DEFLATED, 15, 10, 0));
    printf("%s badmethod %d\n", tag, deflateInit2(&z, 6, 7, 15, 8, 0));
    printf("%s inf badver %d\n", tag, inflateInit_(&z, "2.0", (int) sizeof z));
    printf(
        "%s null %d %d %d\n", tag, deflateInit(NULL, 6), inflateInit(NULL),
        deflate(NULL, 0)
    );
    memset(&z, 0, sizeof z);
    printf("%s init %d\n", tag, deflateInit(&z, 6));
    printf(
        "%s as-inflate %d %d %d %d\n", tag, inflate(&z, 0), inflateReset(&z),
        inflateSync(&z), inflateSyncPoint(&z)
    );
    printf(
        "%s as-inflate2 %d %ld %lu %d\n", tag, inflateEnd(&z), inflateMark(&z),
        inflateCodesUsed(&z), inflateSetDictionary(&z, in, 8)
    );
    printf("%s bound %lu\n", tag, (unsigned long) deflateBound(&z, 1000));
    static const int flushes[] = {-1, 6, 10, Z_NO_FLUSH};
    for (size_t i = 0; i < 4; i++) {
        z.next_in = in;
        z.avail_in = 10;
        z.next_out = out;
        z.avail_out = sizeof out;
        int rc = deflate(&z, flushes[i]);
        show(rc, &z, out, sizeof out - z.avail_out);
    }
    z.next_in = in;
    z.avail_in = 10;
    z.next_out = NULL;
    z.avail_out = 100;
    show(deflate(&z, 0), &z, out, 0);
    z.next_in = NULL;
    z.avail_in = 10;
    z.next_out = out;
    z.avail_out = 100;
    show(deflate(&z, 0), &z, out, 0);
    z.next_in = in;
    z.avail_in = 10;
    z.next_out = out;
    z.avail_out = 0;
    show(deflate(&z, 0), &z, out, 0);
    z.next_in = in;
    z.avail_in = 10;
    z.next_out = out;
    z.avail_out = sizeof out;
    show(deflate(&z, Z_FINISH), &z, out, sizeof out - z.avail_out);
    z.next_in = in;
    z.avail_in = 10;
    z.next_out = out;
    z.avail_out = sizeof out;
    show(deflate(&z, Z_NO_FLUSH), &z, out, 0);
    z.next_in = in;
    z.avail_in = 10;
    z.next_out = out;
    z.avail_out = sizeof out;
    show(deflate(&z, Z_FINISH), &z, out, 0);
    printf("%s params-after-finish %d\n", tag, deflateParams(&z, 1, 0));
    printf(
        "%s prime-after %d dict-after %d\n", tag, deflatePrime(&z, 1, 1),
        deflateSetDictionary(&z, in, 8)
    );
    printf(
        "%s end %d %d %d\n", tag, deflateEnd(&z), deflateEnd(&z), deflate(&z, 0)
    );
    printf(
        "%s reset-after %d %d %d\n", tag, deflateReset(&z),
        deflateParams(&z, 1, 0), deflateTune(&z, 1, 1, 1, 1)
    );
    memset(&z, 0, sizeof z);
    deflateInit2(&z, 6, Z_DEFLATED, 31, 8, 0);
    printf("%s gzip dict %d\n", tag, deflateSetDictionary(&z, in, 8));
    deflateEnd(&z);
    memset(&z, 0, sizeof z);
    inflateInit(&z);
    z.next_in = in;
    z.avail_in = 10;
    z.next_out = NULL;
    z.avail_out = 100;
    show(inflate(&z, 0), &z, out, 0);
    z.next_in = in;
    z.avail_in = 10;
    z.next_out = out;
    z.avail_out = 0;
    show(inflate(&z, 0), &z, out, 0);
    z.next_in = in;
    z.avail_in = 10;
    z.next_out = out;
    z.avail_out = 100;
    show(inflate(&z, 0), &z, out, 0);
    show(inflate(&z, 0), &z, out, 0);
    printf("%s inf end %d %d\n", tag, inflateEnd(&z), inflateEnd(&z));
}

static void streams_deflate(void) {
    set_levels();
    set_flush();
    set_window();
    set_strategy();
    set_dict();
    set_reuse();
    set_params();
    set_copy();
}

static void streams_inflate(void) {
    set_errors();
    set_formats();
    set_gzhand();
    set_sync();
}

static void streams_misc(void) {
    set_misc();
    set_wrong();
}

/* a stream with a zalloc: the guest's own init runs and every allocation is
 * the guest's */
static int allocs, frees;
static void* za(void* o, uInt items, uInt size) {
    (void) o;
    allocs++;
    return calloc(items, size);
}
static void zf(void* o, void* p) {
    (void) o;
    frees++;
    free(p);
}

static void hazard_alloc(void) {
    uint8_t* in = input(30000, 0);
    uint8_t* zz;
    size_t zn = comp(15, 6, in, 30000, &zz);
    uint8_t* out = malloc(40000);
    for (int infl = 0; infl < 2; infl++) {
        z_stream z;
        memset(&z, 0, sizeof z);
        z.zalloc = za;
        z.zfree = zf;
        int rc = infl ? inflateInit(&z) : deflateInit(&z, 6);
        z.next_in = infl ? zz : in;
        z.avail_in = infl ? (uInt) zn : 30000;
        z.next_out = out;
        z.avail_out = 40000;
        settag("alloc inflate%d", infl);
        printf("%s init %d allocs %d\n", tag, rc, allocs);
        rc = infl ? inflate(&z, Z_FINISH) : deflate(&z, Z_FINISH);
        show(rc, &z, out, 40000 - z.avail_out);
        printf(
            "%s end %d allocs %d frees %d\n", tag,
            infl ? inflateEnd(&z) : deflateEnd(&z), allocs, frees
        );
    }
    free(zz);
    free(out);
    free(in);
}

static void child_use(
    const char* who, z_stream* z, const uint8_t* in, size_t n
) {
    uint8_t out[8192];
    z->next_in = (z_const Bytef*) in;
    z->avail_in = (uInt) n;
    z->next_out = out;
    z->avail_out = sizeof out;
    settag("fork %s", who);
    int rc = deflate(z, Z_FINISH);
    show(rc, z, out, sizeof out - z->avail_out);
}

/* a stream open across fork: the parent goes on with it; the child tries the
 * same stream and opens another. fflush before fork keeps the lines apart */
static void hazard_fork(void) {
    uint8_t* in = input(6000, 0);
    uint8_t out[8192];
    z_stream z;
    memset(&z, 0, sizeof z);
    deflateInit(&z, 6);
    z.next_in = in;
    z.avail_in = 3000;
    z.next_out = out;
    z.avail_out = sizeof out;
    settag("fork before");
    show(deflate(&z, Z_NO_FLUSH), &z, out, sizeof out - z.avail_out);
    fflush(stdout);
    pid_t p = fork();
    if (p == 0) {
        child_use("child-old", &z, in + 3000, 3000);
        z_stream y;
        memset(&y, 0, sizeof y);
        deflateInit(&y, 6);
        child_use("child-new", &y, in, 6000);
        printf("child end %d %d\n", deflateEnd(&y), deflateEnd(&z));
        fflush(stdout);
        _exit(0);
    }
    int st = 0;
    waitpid(p, &st, 0);
    printf("parent child exit %d\n", WIFEXITED(st) ? WEXITSTATUS(st) : -1);
    child_use("parent", &z, in + 3000, 3000);
    printf("parent end %d\n", deflateEnd(&z));
    free(in);
}

static volatile sig_atomic_t hits;
static volatile long fault_page[8];
static uint8_t* region;
/* what the handler puts in a page it maps: byte a of the region is
 * fix[a - region - fix_at] where that is inside fix */
static const uint8_t* fix;
static long fix_at, fix_len;

static volatile int mapped[8];

/* the page it maps is the first unmapped one from the address's page on: a
 * load that starts in a mapped page and runs into the next may report either
 * address */
static void on_segv(int sig, siginfo_t* si, void* ctx) {
    (void) sig;
    (void) ctx;
    uint8_t* pg = (uint8_t*) ((uintptr_t) si->si_addr & ~(uintptr_t) 4095);
    long k = (long) (pg - region) / 4096;
    while (k >= 0 && k < 7 && mapped[k]) k++;
    if (k < 0 || k > 7) _exit(71);
    pg = region + k * 4096;
    mapped[k] = 1;
    if (hits < 8) fault_page[hits] = k;
    hits++;
    uint8_t* m = mmap(
        pg, 4096, PROT_READ | PROT_WRITE,
        MAP_FIXED | MAP_PRIVATE | MAP_ANONYMOUS, -1, 0
    );
    if (m != pg) _exit(70);
    for (long i = 0; i < 4096; i++) {
        long k = (long) (pg - region) + i - fix_at;
        if (k >= 0 && k < fix_len) pg[i] = fix[k];
    }
}

/* a buffer that runs on into unmapped memory: the handler maps the next page
 * (with the rest of the data when it is the input) and the call goes on.
 * Faulting pages are reported as page numbers from the region's start */
static void fault_case(int infl, int side) {
    uint8_t* src = input(6000, 0);
    uint8_t* zz;
    size_t zn = comp(15, 6, src, 6000, &zz);
    const uint8_t* data = infl ? zz : src;
    size_t dn = infl ? zn : 6000;
    region = mmap(
        NULL, 8 * 4096, PROT_READ | PROT_WRITE, MAP_PRIVATE | MAP_ANONYMOUS, -1,
        0
    );
    munmap(region + 2 * 4096, 6 * 4096);
    for (int i = 0; i < 8; i++) mapped[i] = i < 2;
    uint8_t* heap = malloc(60000);
    z_stream z;
    memset(&z, 0, sizeof z);
    if (infl)
        inflateInit(&z);
    else
        deflateInit(&z, 6);
    hits = 0;
    uint8_t* out;
    if (side == 0) {
        /* the input starts 1000 bytes before the end of the mapped pages */
        uint8_t* in = region + 2 * 4096 - 1000;
        memcpy(in, data, 1000);
        fix = data, fix_at = 2 * 4096 - 1000, fix_len = (long) dn;
        z.next_in = in;
        z.avail_in = (uInt) dn;
        out = heap;
    }
    else {
        out = region + 2 * 4096 - 300;
        fix = NULL, fix_at = 0, fix_len = 0;
        z.next_in = (z_const Bytef*) data;
        z.avail_in = (uInt) dn;
    }
    z.next_out = out;
    z.avail_out = 60000;
    settag("fault %s %s", infl ? "inflate" : "deflate", side ? "out" : "in");
    int rc = infl ? inflate(&z, Z_FINISH) : deflate(&z, Z_FINISH);
    size_t got = 60000 - z.avail_out;
    show(rc, &z, out, got);
    /* sorted: which page a memcpy touches first depends on the variant the
     * cpu's features select */
    long pages[8];
    int np = hits < 8 ? (int) hits : 8;
    for (int i = 0; i < np; i++) {
        int j = i;
        for (; j > 0 && pages[j - 1] > fault_page[i]; j--)
            pages[j] = pages[j - 1];
        pages[j] = fault_page[i];
    }
    printf("%s hits %d pages", tag, (int) hits);
    for (int i = 0; i < np; i++) printf(" %ld", pages[i]);
    printf("\n");
    printf("%s end %d\n", tag, infl ? inflateEnd(&z) : deflateEnd(&z));
    free(heap);
    munmap(region, 2 * 4096);
    for (int i = 2; i < 8; i++) munmap(region + i * 4096, 4096);
    free(zz);
    free(src);
}

static void hazard_fault(void) {
    struct sigaction sa;
    setvbuf(stdout, NULL, _IOLBF, 0);
    memset(&sa, 0, sizeof sa);
    sa.sa_sigaction = on_segv;
    sa.sa_flags = SA_SIGINFO | SA_NODEFER;
    sigaction(SIGSEGV, &sa, NULL);
    for (int infl = 0; infl < 2; infl++)
        for (int side = 0; side < 2; side++) fault_case(infl, side);
}
// #endregion

/* the corpus from a file when there is one (generating it costs katybug more
 * than the timed calls) */
static uint8_t* load(const char* path) {
    uint8_t* b = malloc(CORPUS);
    FILE* f = fopen(path, "rb");
    if (!f || fread(b, 1, CORPUS, f) != CORPUS) exit(2);
    fclose(f);
    return b;
}

static void run(const char* op, long iters, const char* path) {
    uint8_t* in = path ? load(path) : corpus(CORPUS, 0);
    uLongf cap = compressBound(1u << 20);
    uint8_t* out = malloc(cap);
    uint8_t* back = malloc(1u << 20);
    uLongf zn = cap;
    f_def(out, &zn, in, 1u << 20, 6);
    uint64_t sum = 0;
    for (long i = 0; i < iters; i++) {
        if (!strcmp(op, "crc"))
            sum += f_crc((uLong) i, in, CORPUS);
        else if (!strcmp(op, "adl"))
            sum += f_adl((uLong) i, in, CORPUS);
        else if (!strcmp(op, "def")) {
            uLongf n = cap;
            f_def(out, &n, in + (i & 7) * 4096, 1u << 20, 6);
            sum += n;
        }
        else {
            uLongf n = 1u << 20;
            f_inf(back, &n, out, zn);
            sum += n + back[i & 1023];
        }
    }
    printf("%s %ld %llu\n", op, iters, (unsigned long long) sum);
}

// #region gzip
#define BLK 65536u

/* block i of a generated stream: 64 KiB of a 1 MiB corpus from a start that
 * moves with i, so the stream does not repeat for a long time */
static const uint8_t* gbase;
static void gblock(uint8_t* b, long i) {
    if (!gbase) gbase = input(1u << 20, 0);
    memcpy(b, gbase + (size_t) ((i * 4099ull * 7) % ((1u << 20) - BLK)), BLK);
}

/* c: a stream of mib MiB deflated in gzip format at a level; cd: and inflated
 * again, its sum checked against the input's */
static int gzrun(const char* mode, long mib, int level, size_t ch) {
    long nblk = mib * 16;
    int both = !strcmp(mode, "cd");
    z_stream z;
    memset(&z, 0, sizeof z);
    if (ch < 1 || ch > BLK) ch = BLK;
    if (deflateInit2(&z, level, Z_DEFLATED, 31, 8, 0) != Z_OK) return 1;
    uint8_t *blk = malloc(BLK), *out = malloc(ch);
    struct vec v = {0};
    uLong cin = crc32(0, NULL, 0), cout = crc32(0, NULL, 0);
    unsigned long long total = 0;
    for (long i = 0; i < nblk; i++) {
        gblock(blk, i);
        cin = crc32(cin, blk, BLK);
        for (size_t off = 0; off < BLK; off += ch) {
            size_t take = BLK - off < ch ? BLK - off : ch;
            int last = i == nblk - 1 && off + take == BLK;
            z.next_in = blk + off;
            z.avail_in = (uInt) take;
            do {
                z.next_out = out;
                z.avail_out = (uInt) ch;
                deflate(&z, last ? Z_FINISH : Z_NO_FLUSH);
                size_t got = ch - z.avail_out;
                cout = crc32(cout, out, (uInt) got);
                total += got;
                if (both) push(&v, out, got);
            } while (z.avail_out == 0);
        }
    }
    printf(
        "gzrun %s mib %ld level %d chunk %zu in %llu out %llu crc_in %08lx "
        "crc_out %08lx",
        mode, mib, level, ch, (unsigned long long) nblk * BLK, total, cin, cout
    );
    deflateEnd(&z);
    if (both) {
        memset(&z, 0, sizeof z);
        inflateInit2(&z, 31);
        uLong cb = crc32(0, NULL, 0);
        unsigned long long back = 0;
        size_t pos = 0;
        int rc = Z_OK;
        while (rc == Z_OK) {
            if (z.avail_in == 0 && pos < v.n) {
                size_t take = v.n - pos < ch ? v.n - pos : ch;
                z.next_in = v.p + pos;
                z.avail_in = (uInt) take;
                pos += take;
            }
            z.next_out = out;
            z.avail_out = (uInt) ch;
            rc = inflate(&z, Z_NO_FLUSH);
            cb = crc32(cb, out, (uInt) (ch - z.avail_out));
            back += ch - z.avail_out;
            if (rc == Z_BUF_ERROR && !z.avail_in && pos >= v.n) break;
        }
        printf(
            " back %llu crc_back %08lx rc %d same %d", back, cb, rc,
            cb == cin && back == (unsigned long long) nblk * BLK
        );
        inflateEnd(&z);
    }
    printf("\n");
    free(v.p);
    free(blk);
    free(out);
    return 0;
}

/* gz gen <mib> <file>; gz c <in> <out> [wbits [level]]; gz d <in> <out>
 * [wbits]: files in 64 KiB pieces through the stream entries */
static int gz_file(int argc, char** argv) {
    const char* m = argv[2];
    if (!strcmp(m, "gen") && argc > 4) {
        FILE* f = fopen(argv[4], "wb");
        uint8_t* b = malloc(BLK);
        for (long i = 0; f && i < atol(argv[3]) * 16; i++) {
            gblock(b, i);
            if (fwrite(b, 1, BLK, f) != BLK) return 1;
        }
        return !f || fclose(f);
    }
    if (argc < 5) return 2;
    int comp_ = !strcmp(m, "c");
    int wbits = argc > 5 ? atoi(argv[5]) : 31,
        level = argc > 6 ? atoi(argv[6]) : 6;
    FILE *in = fopen(argv[3], "rb"), *out = fopen(argv[4], "wb");
    if (!in || !out) return 1;
    uint8_t *ib = malloc(BLK), *ob = malloc(BLK);
    z_stream z;
    memset(&z, 0, sizeof z);
    int rc = comp_ ? deflateInit2(&z, level, Z_DEFLATED, wbits, 8, 0)
                   : inflateInit2(&z, wbits);
    uLong cout = crc32(0, NULL, 0);
    unsigned long long tin = 0, tout = 0;
    int end = 0;
    while (rc == Z_OK || rc == Z_BUF_ERROR) {
        size_t got = fread(ib, 1, BLK, in);
        int eof = got < BLK;
        z.next_in = ib;
        z.avail_in = (uInt) got;
        tin += got;
        do {
            z.next_out = ob;
            z.avail_out = BLK;
            rc = comp_ ? deflate(&z, eof ? Z_FINISH : Z_NO_FLUSH)
                       : inflate(&z, Z_NO_FLUSH);
            size_t w = BLK - z.avail_out;
            if (fwrite(ob, 1, w, out) != w) return 1;
            cout = crc32(cout, ob, (uInt) w);
            tout += w;
        } while (z.avail_out == 0 && rc != Z_STREAM_END);
        if (rc == Z_STREAM_END) end = 1;
        if (end || eof) break;
        if (rc == Z_BUF_ERROR) rc = Z_OK;
    }
    printf(
        "gz %s rc %d end %d in %llu out %llu crc_out %08lx\n", m, rc, end, tin,
        tout, cout
    );
    fclose(out);
    comp_ ? deflateEnd(&z) : inflateEnd(&z);
    return !end;
}
// #endregion

int main(int argc, char** argv) {
    if (argc > 1 && !strcmp(argv[1], "bytes")) return bytes(), 0;
    if (argc > 1 && !strcmp(argv[1], "check")) return check(), 0;
    if (argc > 1 && !strcmp(argv[1], "stream-deflate"))
        return streams_deflate(), 0;
    if (argc > 1 && !strcmp(argv[1], "stream-inflate"))
        return streams_inflate(), 0;
    if (argc > 1 && !strcmp(argv[1], "stream-misc")) return streams_misc(), 0;
    if (argc > 1 && !strcmp(argv[1], "alloc")) return hazard_alloc(), 0;
    if (argc > 1 && !strcmp(argv[1], "fork")) return hazard_fork(), 0;
    if (argc > 1 && !strcmp(argv[1], "fault")) return hazard_fault(), 0;
    if (argc > 4 && !strcmp(argv[1], "gzrun"))
        return gzrun(
            argv[2], atol(argv[3]), atoi(argv[4]),
            argc > 5 ? (size_t) atol(argv[5]) : BLK
        );
    if (argc > 2 && !strcmp(argv[1], "gz")) return gz_file(argc, argv);
    if (argc > 2 && !strcmp(argv[1], "corpus")) {
        FILE* f = fopen(argv[2], "wb");
        uint8_t* b = corpus(CORPUS, 0);
        return !f || fwrite(b, 1, CORPUS, f) != CORPUS || fclose(f);
    }
    if (argc > 3 && !strcmp(argv[1], "run"))
        return run(argv[2], atol(argv[3]), argc > 4 ? argv[4] : NULL), 0;
    fprintf(
        stderr, "usage: zbench bytes | check | corpus <file> | run "
                "crc|adl|def|inf <iters> [corpus] | stream-deflate | "
                "stream-inflate | stream-misc | alloc | fork | fault | gz gen "
                "<mib> <file> | gz c|d <in> <out> [wbits [level]] | gzrun "
                "c|cd <mib> <level> [chunk]\n"
    );
    return 2;
}
