#include "kb.h"

#ifdef KB_ZLIB
    #include <stdio.h>
    #include <stdlib.h>
    #include <string.h>
    #include <zlib.h>

/*
 * A guest's z_stream served by the host's zlib. The init entries take a stream
 * over only when the guest's own init could not tell the difference (prim.c
 * and thunk.c say when); from then on the stream is a host z_stream in a table
 * and every entry on it runs here, with the guest's struct kept in step. The
 * guest's libz never ran an init for it, so its state field holds the stream's
 * own address: a libz entry that meets it fails its state check and touches
 * nothing. A stream the table does not hold is the guest's, and every entry
 * on it gives up
 */

const char* const kb_zs_name[KB_ZS_N] = {
    "deflateInit_",
    "deflateInit2_",
    "inflateInit_",
    "inflateInit2_",
    "deflate",
    "inflate",
    "deflateEnd",
    "inflateEnd",
    "deflateReset",
    "deflateResetKeep",
    "deflateParams",
    "deflateSetDictionary",
    "deflateGetDictionary",
    "deflateBound",
    "deflatePending",
    "deflatePrime",
    "deflateTune",
    "deflateCopy",
    "inflateReset",
    "inflateResetKeep",
    "inflateReset2",
    "inflateSetDictionary",
    "inflateGetDictionary",
    "inflateSync",
    "inflateSyncPoint",
    "inflatePrime",
    "inflateMark",
    "inflateCopy",
    "inflateUndermine",
    "inflateValidate",
    "inflateCodesUsed"
};

enum
{
    ZE_DEFLATE_INIT,
    ZE_DEFLATE_INIT2,
    ZE_INFLATE_INIT,
    ZE_INFLATE_INIT2,
    ZE_DEFLATE,
    ZE_INFLATE,
    ZE_DEFLATE_END,
    ZE_INFLATE_END,
    ZE_DEFLATE_RESET,
    ZE_DEFLATE_RESETKEEP,
    ZE_DEFLATE_PARAMS,
    ZE_DEFLATE_SETDICT,
    ZE_DEFLATE_GETDICT,
    ZE_DEFLATE_BOUND,
    ZE_DEFLATE_PENDING,
    ZE_DEFLATE_PRIME,
    ZE_DEFLATE_TUNE,
    ZE_DEFLATE_COPY,
    ZE_INFLATE_RESET,
    ZE_INFLATE_RESETKEEP,
    ZE_INFLATE_RESET2,
    ZE_INFLATE_SETDICT,
    ZE_INFLATE_GETDICT,
    ZE_INFLATE_SYNC,
    ZE_INFLATE_SYNCPOINT,
    ZE_INFLATE_PRIME,
    ZE_INFLATE_MARK,
    ZE_INFLATE_COPY,
    ZE_INFLATE_UNDERMINE,
    ZE_INFLATE_VALIDATE,
    ZE_INFLATE_CODESUSED
};

/* the guest's z_stream, the same 112 bytes on x86-64 and AArch64 */
enum
{
    O_NEXT_IN = 0,
    O_AVAIL_IN = 8,
    O_TOTAL_IN = 16,
    O_NEXT_OUT = 24,
    O_AVAIL_OUT = 32,
    O_TOTAL_OUT = 40,
    O_MSG = 48,
    O_STATE = 56,
    O_ZALLOC = 64,
    O_ZFREE = 72,
    O_DATA_TYPE = 88,
    O_ADLER = 96,
    ZSIZE = 112
};

    #define ZS_MAX 64
    /* the most one call to deflate, inflate or inflateSync hands the host at
     * once, in and out; the entries that cannot be split take up to ZMAX */
    #define ZCHUNK (1u << 20)
    #define ZMAX (64u << 20)
    /* deflateBound's own arithmetic is 32 bits on a wasm host */
    #define BOUND_EXACT 0x3fffffffull

/* tin and tout are the 64-bit totals; lin and lout the host's own counters
 * (as wide as its uLong) when they were last added in: a call that moves them
 * without consuming input, as deflateSetDictionary does, still shows */
static struct zs {
    int used, inflate, ver;
    uint64_t va, tin, tout;
    uLong lin, lout;
    z_stream hs;
} tab[ZS_MAX];

static void tally(struct zs* z) {
    z->tin += (uLong) (z->hs.total_in - z->lin);
    z->tout += (uLong) (z->hs.total_out - z->lout);
    z->lin = z->hs.total_in, z->lout = z->hs.total_out;
}

static void zero_totals(struct zs* z) {
    z->tin = z->tout = 0;
    z->lin = z->hs.total_in, z->lout = z->hs.total_out;
}

static uint64_t lost, nomsg;
static struct {
    const char* host;
    uint64_t lo, va;
} mc[32];
static int nmc;
static uint8_t dummy[8];

static uint64_t ld(const uint8_t* g, int off, int w) {
    uint64_t v = 0;
    memcpy(&v, g + off, (size_t) w);
    return v;
}

static void st(uint8_t* g, int off, uint64_t v, int w) {
    memcpy(g + off, &v, (size_t) w);
}

/* argument i of the call being made, in the arguments' order */
static uint64_t arg(struct kb_cpu* cpu, int i) {
    static const int xr[6] = {7, 6, 2, 1, 8, 9};
    uint64_t v = 0;
    if (cpu->arch == KB_A64) return cpu->r[i];
    if (i < 6) return cpu->r[xr[i]];
    if (!kb_read(cpu, cpu->r[4] + 8 + 8 * (uint64_t) (i - 6), &v, 8)) return 0;
    return v;
}

static uint64_t caller(struct kb_cpu* cpu) {
    uint64_t ret = 0;
    if (cpu->arch == KB_A64) return cpu->r[30];
    if (!kb_read(cpu, cpu->r[4], &ret, 8)) return 0;
    return ret;
}

static struct zs* find(uint64_t va) {
    for (int i = 0; i < ZS_MAX; i++)
        if (tab[i].used && tab[i].va == va) return &tab[i];
    return NULL;
}

static struct zs* slot(void) {
    for (int i = 0; i < ZS_MAX; i++)
        if (!tab[i].used) return &tab[i];
    return NULL;
}

static void drop(struct zs* z) {
    if (z->inflate)
        inflateEnd(&z->hs);
    else
        deflateEnd(&z->hs);
    memset(z, 0, sizeof *z);
}

/* how many of [va, va + want) the guest has mapped, from its start */
static uint64_t reach_n(struct kb_cpu* cpu, uint64_t va, uint64_t want) {
    uint64_t n = 0, k;
    while (n < want && va + n >= va && kb_span(cpu, va + n, &k)) n += k;
    return n < want ? n : want;
}

static uint64_t chunk(void) {
    static uint64_t c;
    if (!c) {
        const char* e = getenv("KATYBUG_ZCHUNK");
        c = e && atol(e) > 0 ? (uint64_t) atol(e) : ZCHUNK;
    }
    return c;
}

/* where a text of the host's zlib is inside the guest's libz image, so that
 * msg points at a string in guest memory as it does natively; 0 when the image
 * has no such text */
static uint64_t find_text(
    struct kb_cpu* cpu, uint64_t lo, uint64_t hi, const char* text
) {
    uint8_t buf[4096 + 128];
    size_t n = strlen(text) + 1;
    if (n > 128) return 0;
    for (uint64_t at = lo; at < hi; at += 4096) {
        uint64_t m = hi - at < sizeof buf ? hi - at : sizeof buf;
        if (!kb_read(cpu, at, buf, m)) {
            m = hi - at < 4096 ? hi - at : 4096;
            if (!kb_read(cpu, at, buf, m)) continue;
        }
        for (uint64_t i = 0; i < 4096 && i + n <= m; i++)
            if (buf[i] == (uint8_t) text[0] && !memcmp(buf + i, text, n))
                return at + i;
    }
    return 0;
}

static uint64_t text_va(struct kb_cpu* cpu, const char* text) {
    uint64_t lo, hi, va;
    if (!text) return 0;
    if (!kb_thunk_object(cpu, cpu->pc, &lo, &hi)) return nomsg++, 0;
    for (int i = 0; i < nmc; i++)
        if (mc[i].host == text && mc[i].lo == lo) return mc[i].va;
    va = find_text(cpu, lo, hi, text);
    if (!va) {
        if (!nomsg++ && kb_log)
            fprintf(kb_log, "katybug: zlib message not found: %s\n", text);
        return 0;
    }
    int at = nmc < 32 ? nmc++ : (int) (va & 31);
    mc[at].host = text, mc[at].lo = lo, mc[at].va = va;
    return va;
}

/* the guest struct's fields the library owns, from the host's */
static void pub(struct kb_cpu* cpu, struct zs* z, uint8_t* g) {
    st(g, O_TOTAL_IN, z->tin, 8);
    st(g, O_TOTAL_OUT, z->tout, 8);
    st(g, O_MSG, text_va(cpu, z->hs.msg), 8);
    st(g, O_DATA_TYPE, (uint32_t) z->hs.data_type, 4);
    st(g, O_ADLER, (uint64_t) z->hs.adler, 8);
    kb_write(cpu, z->va, g, ZSIZE);
}

static int fault(struct kb_cpu* cpu, uint64_t addr) {
    cpu->fault = "zlib: a buffer the guest gave is not mapped";
    cpu->fault_sig = 11;
    cpu->fault_addr = addr;
    return 2;
}

static int is_inflate(int e) {
    return e == ZE_INFLATE || e == ZE_INFLATE_END || e >= ZE_INFLATE_RESET;
}

enum
{
    OP_DEFLATE,
    OP_INFLATE,
    OP_SYNC,
    OP_PARAMS
};

struct args {
    int op, flush, level, strategy;
};

/* deflate, inflate, inflateSync or deflateParams over the guest's buffers: the
 * host runs on copies of what the guest passed, one window at a time when a
 * buffer is longer than chunk() or ends where the guest's memory does. *at is
 * the address to fault at, or 0; g is updated and the struct not yet written */
static int run(
    struct kb_cpu* cpu, struct zs* z, uint8_t* g, const struct args* a,
    uint64_t* at
) {
    uint64_t nin = ld(g, O_NEXT_IN, 8), nout = ld(g, O_NEXT_OUT, 8);
    uint64_t ain = ld(g, O_AVAIL_IN, 4), aout = ld(g, O_AVAIL_OUT, 4);
    uint64_t ci = 0, co = 0, cap = a->op == OP_PARAMS ? ZMAX : chunk();
    int rc = Z_OK, iter = 0, useout = a->op != OP_SYNC;
    for (;;) {
        uint64_t rin = ain - ci, rout = useout ? aout - co : 0;
        uint64_t win = rin, wout = rout;
        /* a null pointer goes to the host as it is: it refuses before reading
         */
        if (nin && rin) win = reach_n(cpu, nin + ci, rin < cap ? rin : cap);
        if (nout && rout)
            wout = reach_n(cpu, nout + co, rout < cap ? rout : cap);
        if (nin && rin && !win) {
            *at = nin + ci;
            break;
        }
        if (nout && rout && !wout) {
            *at = nout + co;
            break;
        }
        int more_in = win < rin, more_out = wout < rout;
        uint8_t *hin = NULL, *hout = NULL;
        if (nin && win) {
            hin = malloc((size_t) win);
            if (!hin || !kb_read(cpu, nin + ci, hin, win)) {
                free(hin);
                rc = Z_MEM_ERROR;
                break;
            }
        }
        if (nout && wout && !(hout = malloc((size_t) wout))) {
            free(hin);
            rc = Z_MEM_ERROR;
            break;
        }
        z->hs.next_in = nin ? (hin ? hin : dummy) : NULL;
        z->hs.avail_in = (uInt) win;
        z->hs.next_out = !useout ? NULL : nout ? (hout ? hout : dummy) : NULL;
        z->hs.avail_out = (uInt) wout;
        int fl = a->flush;
        if (more_in && a->op == OP_DEFLATE) fl = Z_NO_FLUSH;
        if (more_in && a->op == OP_INFLATE && fl == Z_FINISH) fl = Z_NO_FLUSH;
        switch (a->op) {
            case OP_DEFLATE: rc = deflate(&z->hs, fl); break;
            case OP_INFLATE: rc = inflate(&z->hs, fl); break;
            case OP_SYNC: rc = inflateSync(&z->hs); break;
            default: rc = deflateParams(&z->hs, a->level, a->strategy);
        }
        uint64_t c = win - z->hs.avail_in, p = wout - z->hs.avail_out;
        if (!useout) p = 0;
        int out_full = useout && z->hs.avail_out == 0;
        int in_done = z->hs.avail_in == 0;
        if (p && !kb_write(cpu, nout + co, hout, p)) *at = nout + co;
        free(hin);
        free(hout);
        z->hs.next_in = z->hs.next_out = NULL;
        z->hs.avail_in = z->hs.avail_out = 0;
        ci += c, co += p;
        tally(z);
        iter++;
        if (*at) break;
        if (a->op == OP_PARAMS) {
            /* one host call: input or room left over means the call ran out of
             * what the guest has mapped (or of ZMAX) */
            if (in_done && more_in) {
                *at = nin + ci;
                if (win >= cap) *at = 0, rc = Z_MEM_ERROR;
            }
            else if (out_full && more_out) {
                *at = nout + co;
                if (wout >= cap) *at = 0, rc = Z_MEM_ERROR;
            }
            break;
        }
        int need = a->op == OP_SYNC ? rc == Z_DATA_ERROR
                                    : rc == Z_OK || rc == Z_BUF_ERROR;
        if (!need || (out_full && !more_out) || (!c && !p)) break;
        if (!(in_done && more_in) && !(out_full && more_out)) break;
    }
    if (iter > 1 && rc == Z_BUF_ERROR &&
        !(a->op == OP_INFLATE && a->flush == Z_FINISH))
        rc = Z_OK;
    st(g, O_NEXT_IN, nin + ci, 8);
    st(g, O_AVAIL_IN, ain - ci, 4);
    st(g, O_NEXT_OUT, nout + co, 8);
    st(g, O_AVAIL_OUT, aout - co, 4);
    return rc;
}

static int call(
    struct kb_cpu* cpu, struct zs* z, uint8_t* g, const struct args* a,
    uint64_t* v
) {
    uint64_t at = 0;
    int rc = run(cpu, z, g, a, &at);
    pub(cpu, z, g);
    if (at) return fault(cpu, at);
    return *v = (uint32_t) rc, 1;
}

/* an init the guest would run to success on its own: taken over by a host
 * stream, or 0 and the guest's own init runs */
static int init(struct kb_cpu* cpu, int e, int ver, uint64_t* v) {
    int inflate = e >= ZE_INFLATE_INIT, rc, vi;
    vi = e == ZE_DEFLATE_INIT    ? 2
         : e == ZE_DEFLATE_INIT2 ? 6
         : e == ZE_INFLATE_INIT  ? 1
                                 : 2;
    uint64_t strm = arg(cpu, 0);
    uint8_t g[ZSIZE], c = 0;
    if (!strm || (int) (uint32_t) arg(cpu, vi + 1) != ZSIZE ||
        !kb_read(cpu, arg(cpu, vi), &c, 1) || c != '1' ||
        !kb_read(cpu, strm, g, ZSIZE) || ld(g, O_ZALLOC, 8) ||
        ld(g, O_ZFREE, 8) || !kb_thunk_zok(cpu, caller(cpu), inflate))
        return 0;
    struct zs* z = find(strm);
    if (z) drop(z);
    if (!z && !(z = slot())) return 0;
    memset(z, 0, sizeof *z);
    int a1 = (int) (uint32_t) arg(cpu, 1);
    switch (e) {
        case ZE_DEFLATE_INIT:
            rc = deflateInit_(&z->hs, a1, ZLIB_VERSION, (int) sizeof z->hs);
            break;
        case ZE_DEFLATE_INIT2:
            rc = deflateInit2_(
                &z->hs, a1, (int) (uint32_t) arg(cpu, 2),
                (int) (uint32_t) arg(cpu, 3), (int) (uint32_t) arg(cpu, 4),
                (int) (uint32_t) arg(cpu, 5), ZLIB_VERSION, (int) sizeof z->hs
            );
            break;
        case ZE_INFLATE_INIT:
            rc = inflateInit_(&z->hs, ZLIB_VERSION, (int) sizeof z->hs);
            break;
        default:
            rc = inflateInit2_(&z->hs, a1, ZLIB_VERSION, (int) sizeof z->hs);
    }
    if (rc != Z_OK) return memset(z, 0, sizeof *z), 0;
    z->used = 1, z->inflate = inflate, z->ver = ver, z->va = strm;
    st(g, O_STATE, strm, 8);
    pub(cpu, z, g);
    return *v = 0, 1;
}

/* what the guest's libz returns for a stream of the other kind: its state
 * check fails */
static uint64_t mismatch(int e, uint64_t len) {
    if (e == ZE_DEFLATE_BOUND) return deflateBound(NULL, (uLong) len);
    if (e == ZE_INFLATE_MARK) return (uint64_t) (int64_t) inflateMark(NULL);
    if (e == ZE_INFLATE_CODESUSED) return ~0ull;
    return (uint32_t) Z_STREAM_ERROR;
}

static int copy(
    struct kb_cpu* cpu, int e, struct zs* z, const uint8_t* g, uint64_t* v
) {
    uint64_t dest = arg(cpu, 0);
    uint8_t gd[ZSIZE];
    if (!dest || dest == z->va) return *v = (uint32_t) Z_STREAM_ERROR, 1;
    struct zs* d = find(dest);
    if (d) drop(d);
    if (!d && !(d = slot())) return *v = (uint32_t) Z_MEM_ERROR, 1;
    memset(d, 0, sizeof *d);
    int rc = e == ZE_DEFLATE_COPY ? deflateCopy(&d->hs, &z->hs)
                                  : inflateCopy(&d->hs, &z->hs);
    if (rc != Z_OK) return memset(d, 0, sizeof *d), *v = (uint32_t) rc, 1;
    d->used = 1, d->inflate = z->inflate, d->va = dest;
    d->tin = z->tin, d->tout = z->tout, d->lin = z->lin, d->lout = z->lout;
    memcpy(gd, g, ZSIZE);
    st(gd, O_STATE, dest, 8);
    if (!kb_write(cpu, dest, gd, ZSIZE)) return fault(cpu, dest);
    return *v = 0, 1;
}

static int dict(
    struct kb_cpu* cpu, int e, struct zs* z, uint8_t* g, uint64_t* v
) {
    uint64_t d = arg(cpu, 1);
    uint32_t n = (uint32_t) arg(cpu, 2);
    uint8_t* buf = NULL;
    if (d && n) {
        if (n > ZMAX) return *v = (uint32_t) Z_MEM_ERROR, 1;
        uint64_t r = reach_n(cpu, d, n);
        if (r < n) return fault(cpu, d + r);
        if (!(buf = malloc(n)) || !kb_read(cpu, d, buf, n)) {
            free(buf);
            return *v = (uint32_t) Z_MEM_ERROR, 1;
        }
    }
    const Bytef* hd = d ? (buf ? buf : dummy) : NULL;
    int rc = e == ZE_DEFLATE_SETDICT ? deflateSetDictionary(&z->hs, hd, n)
                                     : inflateSetDictionary(&z->hs, hd, n);
    free(buf);
    tally(z);
    pub(cpu, z, g);
    return *v = (uint32_t) rc, 1;
}

static int getdict(struct kb_cpu* cpu, int e, struct zs* z, uint64_t* v) {
    uint64_t d = arg(cpu, 1), lp = arg(cpu, 2);
    uInt len = 0;
    uint8_t* buf = malloc(32768);
    if (!buf) return *v = (uint32_t) Z_MEM_ERROR, 1;
    int rc = e == ZE_DEFLATE_GETDICT
                 ? deflateGetDictionary(&z->hs, d ? buf : NULL, &len)
                 : inflateGetDictionary(&z->hs, d ? buf : NULL, &len);
    uint64_t at = 0;
    if (rc == Z_OK) {
        uint64_t r = d ? reach_n(cpu, d, len) : 0;
        if (d && r) kb_write(cpu, d, buf, r);
        if (d && r < len)
            at = d + r;
        else if (lp && !kb_write(cpu, lp, &len, 4))
            at = lp;
    }
    free(buf);
    if (at) return fault(cpu, at);
    return *v = (uint32_t) rc, 1;
}

static int pending(struct kb_cpu* cpu, struct zs* z, uint64_t* v) {
    uint64_t pp = arg(cpu, 1), bp = arg(cpu, 2), at = 0;
    unsigned pend = 0;
    int bits = 0;
    int rc = deflatePending(&z->hs, pp ? &pend : NULL, bp ? &bits : NULL);
    if (rc == Z_OK) {
        if (pp && !kb_write(cpu, pp, &pend, 4))
            at = pp;
        else if (bp && !kb_write(cpu, bp, &bits, 4))
            at = bp;
    }
    if (at) return fault(cpu, at);
    return *v = (uint32_t) rc, 1;
}

    #define IARG(i) ((int) (uint32_t) arg(cpu, i))

int kb_zs(struct kb_cpu* cpu, int e, int ver, uint64_t* v) {
    if (e <= ZE_INFLATE_INIT2) return init(cpu, e, ver, v);
    uint64_t strm =
        arg(cpu, e == ZE_DEFLATE_COPY || e == ZE_INFLATE_COPY ? 1 : 0);
    uint8_t g[ZSIZE];
    if (!strm || !kb_read(cpu, strm, g, ZSIZE)) return 0;
    struct zs* z = find(strm);
    if (!z) {
        /* a token with no table entry: the stream was open across a fork by
         * exec, whose child has guest memory only */
        if (ld(g, O_STATE, 8) == strm) {
            if (!lost++ && kb_log)
                fprintf(
                    kb_log,
                    "katybug: zlib stream %#llx was open across fork-by-exec\n",
                    (unsigned long long) strm
                );
        }
        return 0;
    }
    if (ld(g, O_STATE, 8) != strm) return drop(z), 0;
    if (z->inflate != is_inflate(e)) return *v = mismatch(e, arg(cpu, 1)), 1;
    int rc = Z_OK;
    switch (e) {
        case ZE_DEFLATE:
        case ZE_INFLATE: {
            struct args a = {
                e == ZE_DEFLATE ? OP_DEFLATE : OP_INFLATE, IARG(1), 0, 0
            };
            return call(cpu, z, g, &a, v);
        }
        case ZE_DEFLATE_PARAMS: {
            struct args a = {OP_PARAMS, 0, IARG(1), IARG(2)};
            return call(cpu, z, g, &a, v);
        }
        case ZE_INFLATE_SYNC: {
            struct args a = {OP_SYNC, 0, 0, 0};
            return call(cpu, z, g, &a, v);
        }
        case ZE_DEFLATE_END:
        case ZE_INFLATE_END: {
            uint64_t none = 0;
            rc = e == ZE_DEFLATE_END ? deflateEnd(&z->hs) : inflateEnd(&z->hs);
            kb_write(cpu, strm + O_STATE, &none, 8);
            memset(z, 0, sizeof *z);
            return *v = (uint32_t) rc, 1;
        }
        case ZE_DEFLATE_RESET: rc = deflateReset(&z->hs); goto reset;
        case ZE_DEFLATE_RESETKEEP: rc = deflateResetKeep(&z->hs); goto reset;
        case ZE_INFLATE_RESET: rc = inflateReset(&z->hs); goto reset;
        case ZE_INFLATE_RESETKEEP: rc = inflateResetKeep(&z->hs); goto reset;
        case ZE_INFLATE_RESET2:
            rc = inflateReset2(&z->hs, IARG(1));
        reset:
            if (rc == Z_OK) {
                zero_totals(z);
                /* the guest's libz decides what an inflate reset does to
                 * data_type, not the host's */
                if (z->inflate)
                    z->hs.data_type =
                        z->ver >= KB_ZV_RESET_CLEARS
                            ? 0
                            : (int) (uint32_t) ld(g, O_DATA_TYPE, 4);
            }
            pub(cpu, z, g);
            return *v = (uint32_t) rc, 1;
        case ZE_DEFLATE_SETDICT:
        case ZE_INFLATE_SETDICT: return dict(cpu, e, z, g, v);
        case ZE_DEFLATE_GETDICT:
        case ZE_INFLATE_GETDICT: return getdict(cpu, e, z, v);
        case ZE_DEFLATE_BOUND: {
            uint64_t n = arg(cpu, 1);
            /* above this a 32 bit uLong overflows: the larger of the two
             * conservative bounds and the longest wrapper, never below the
             * library's */
            if (n > BOUND_EXACT)
                return *v = n + (n >> 3) + (n >> 8) + (n >> 9) + 4 + 18, 1;
            return *v = (uint64_t) deflateBound(&z->hs, (uLong) n), 1;
        }
        case ZE_DEFLATE_PENDING: return pending(cpu, z, v);
        case ZE_DEFLATE_PRIME:
            rc = deflatePrime(&z->hs, IARG(1), IARG(2));
            return *v = (uint32_t) rc, 1;
        case ZE_DEFLATE_TUNE:
            rc = deflateTune(&z->hs, IARG(1), IARG(2), IARG(3), IARG(4));
            return *v = (uint32_t) rc, 1;
        case ZE_DEFLATE_COPY:
        case ZE_INFLATE_COPY: return copy(cpu, e, z, g, v);
        case ZE_INFLATE_SYNCPOINT:
            return *v = (uint32_t) inflateSyncPoint(&z->hs), 1;
        case ZE_INFLATE_PRIME:
            rc = inflatePrime(&z->hs, IARG(1), IARG(2));
            return *v = (uint32_t) rc, 1;
        case ZE_INFLATE_MARK:
            return *v = (uint64_t) (int64_t) inflateMark(&z->hs), 1;
        case ZE_INFLATE_UNDERMINE:
            return *v = (uint32_t) inflateUndermine(&z->hs, IARG(1)), 1;
        case ZE_INFLATE_VALIDATE:
            return *v = (uint32_t) inflateValidate(&z->hs, IARG(1)), 1;
        default: /* ZE_INFLATE_CODESUSED */
            return *v = (uint64_t) inflateCodesUsed(&z->hs), 1;
    }
}

void kb_zs_report(FILE* f) {
    if (lost || nomsg)
        fprintf(
            f, " zstream lost %llu message-not-found %llu",
            (unsigned long long) lost, (unsigned long long) nomsg
        );
}
#endif
