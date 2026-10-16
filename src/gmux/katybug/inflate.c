#include <errno.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <unistd.h>

#include "kb.h"
#ifdef KB_ZLIB
    #include <zlib.h>
#endif

/*
 * A gzip member's whole deflate stream on the host's zlib. The static x86-64
 * GNU gzip 1.13 that inflate-sigs.h describes decodes with inflate(), which
 * reads through fill_inbuf and writes the decoded bytes through flush_window
 * each time its 32 KiB window fills. Its state is globals, so it cannot be
 * taken in the middle of the stream. It is taken whole, and only when nothing
 * can differ from what gzip's code would do:
 *  - the input is a regular file the host can read ahead without consuming
 *    (pread), so the whole stream is decoded and checked before a byte is
 *    released: a data error, a stream that stops early or has fewer than 8
 *    bytes after it (gzip's lookahead and trailer) leave the call to the
 *    guest's own code, which then fails where and how it always did
 *  - one thread, and every signal handler is gzip's own (abort_gzip_signal,
 *    found by its bytes), which ends the process
 * Then the guest's own fill_inbuf and flush_window run the reads and writes in
 * the order gzip would make them (a read when the decode reaches the end of
 * the buffer, a write for each full window): this code puts each window of the
 * host's output in gzip's window, sets outcnt, and calls flush_window by
 * leaving it a return address that comes back to inflate's entry. A mark in bk
 * tells a call that comes back from one that begins; a process that has the
 * mark and no stream (a fork by exec in the middle) ends. Natively the host is
 * a test double over the system's zlib, on with KATYBUG_HOSTINFLATE
 */

enum
{
    WSIZE = 32768,
    INBUFSIZ = 0x40000,
    CHUNK = 0x40000
};

/* inflate-sigs.h's row: the distances are from inflate's entry */
static const struct isig {
    uint32_t len;
    uint64_t head, hash;
    int32_t dfill;
    uint32_t flen;
    uint64_t fhead, fhash;
    int32_t dflush;
    uint32_t wlen;
    uint64_t whead, whash;
    int32_t dhandler;
    uint32_t hlen;
    uint64_t hhead, hhash;
    int32_t inptr, insize, inbuf, ifd, window, outcnt, bk, bb;
} row = {
#include "inflate-sigs.h"
};

// #region host
#if defined(__wasm__)
/* the machine's __gmux_digest ops 8 to 13 (digest.c declares the import) */
__attribute__((import_module("env"), import_name("__gmux_digest"))) extern int
gmux_digest(int op, int a, int b, int c);

static int hi_open(void) {
    return gmux_digest(8, 0, 0, 0);
}
static int hi_feed(int id, const void* p, size_t n) {
    return gmux_digest(9, id, (int) (uintptr_t) p, (int) n);
}
static int hi_stat(int id, uint32_t out[4]) {
    return gmux_digest(10, id, (int) (uintptr_t) out, 0);
}
static int hi_mark(int id, int k) {
    return gmux_digest(11, id, k, 0);
}
static int hi_copy(int id, void* dst, int k) {
    return gmux_digest(12, id, (int) (uintptr_t) dst, k);
}
static void hi_close(int id) {
    gmux_digest(13, id, 0, 0);
}
int kb_inflate_ready(void) {
    return 1;
}
#elif defined(KB_ZLIB)
/* the double keeps what the machine keeps: the decoded bytes, whole windows */
struct hinf {
    z_stream z;
    uint8_t* out;
    size_t len, cap;
    uint32_t* marks;
    size_t nmarks, capmarks;
    uint64_t taken;
    int ended, failed;
};
static struct hinf* hinfs[4];

int kb_inflate_ready(void) {
    static int on = -1;
    if (on < 0) on = getenv("KATYBUG_HOSTINFLATE") != NULL;
    return on;
}

static struct hinf* hget(int id) {
    return id > 0 && id <= 4 ? hinfs[id - 1] : NULL;
}

static int hi_open(void) {
    if (!kb_inflate_ready()) return -1;
    for (int i = 0; i < 4; i++) {
        if (hinfs[i]) continue;
        struct hinf* h = calloc(1, sizeof *h);
        if (!h || inflateInit2(&h->z, -15) != Z_OK) return free(h), -1;
        hinfs[i] = h;
        return i + 1;
    }
    return -1;
}

static int hi_feed(int id, const void* p, size_t n) {
    struct hinf* h = hget(id);
    if (!h || h->failed) return -1;
    if (h->ended) return 1;
    h->z.next_in = (Bytef*) p;
    h->z.avail_in = (uInt) n;
    for (;;) {
        size_t room = WSIZE - h->len % WSIZE;
        if (h->len + room > h->cap) {
            size_t cap = h->cap ? h->cap * 2 : 1u << 20;
            uint8_t* o = realloc(h->out, cap);
            if (!o) return h->failed = 1, -1;
            h->out = o, h->cap = cap;
        }
        uInt before = h->z.avail_in;
        h->z.next_out = h->out + h->len;
        h->z.avail_out = (uInt) room;
        int rc = inflate(&h->z, Z_NO_FLUSH);
        size_t written = room - h->z.avail_out;
        h->taken += before - h->z.avail_in, h->len += written;
        if (rc != Z_OK && rc != Z_STREAM_END && rc != Z_BUF_ERROR)
            return h->failed = 1, -1;
        if (written && h->len % WSIZE == 0) {
            if (h->nmarks == h->capmarks) {
                size_t c = h->capmarks ? h->capmarks * 2 : 64;
                uint32_t* m = realloc(h->marks, c * sizeof *m);
                if (!m) return h->failed = 1, -1;
                h->marks = m, h->capmarks = c;
            }
            h->marks[h->nmarks++] = (uint32_t) h->taken;
        }
        if (rc == Z_STREAM_END) return h->ended = 1;
        if (written < room) return h->z.avail_in ? (h->failed = 1, -1) : 0;
    }
}

static int hi_stat(int id, uint32_t out[4]) {
    struct hinf* h = hget(id);
    if (!h) return -1;
    out[0] = (uint32_t) h->len, out[1] = (uint32_t) h->taken;
    out[2] = (uint32_t) h->nmarks, out[3] = (uint32_t) h->ended;
    return 0;
}

static int hi_mark(int id, int k) {
    struct hinf* h = hget(id);
    return h && k >= 0 && (size_t) k < h->nmarks ? (int) h->marks[k] : -1;
}

static int hi_copy(int id, void* dst, int k) {
    struct hinf* h = hget(id);
    if (!h || !h->ended || k < 0 || (size_t) k * WSIZE > h->len) return -1;
    size_t n = h->len - (size_t) k * WSIZE;
    if (n > WSIZE) n = WSIZE;
    memcpy(dst, h->out + (size_t) k * WSIZE, n);
    return (int) n;
}

static void hi_close(int id) {
    struct hinf* h = hget(id);
    if (!h) return;
    inflateEnd(&h->z);
    free(h->out), free(h->marks), free(h);
    hinfs[id - 1] = NULL;
}
#else
int kb_inflate_ready(void) {
    return 0;
}
static int hi_open(void) {
    return -1;
}
static int hi_feed(int id, const void* p, size_t n) {
    (void) id, (void) p, (void) n;
    return -1;
}
static int hi_stat(int id, uint32_t out[4]) {
    (void) id, (void) out;
    return -1;
}
static int hi_mark(int id, int k) {
    (void) id, (void) k;
    return -1;
}
static int hi_copy(int id, void* dst, int k) {
    (void) id, (void) dst, (void) k;
    return -1;
}
static void hi_close(int id) {
    (void) id;
}
#endif
// #endregion

// #region identity
#define FNV0 0xcbf29ce484222325ull
static uint64_t fnv(const uint8_t* p, size_t n) {
    uint64_t h = FNV0;
    for (size_t i = 0; i < n; i++) h = (h ^ p[i]) * 0x100000001b3ull;
    return h;
}

/* the code at pc is len bytes whose hash is hash */
static int is_code(
    struct kb_cpu* cpu, uint64_t pc, uint32_t len, uint64_t head, uint64_t hash
) {
    static uint8_t buf[1100];
    uint64_t h;
    if (len > sizeof buf || !kb_read(cpu, pc, &h, 8) || h != head) return 0;
    return kb_read(cpu, pc, buf, len) && fnv(buf, len) == hash;
}

static uint64_t entry;

/** 1 when pc is the entry of the inflate of the build inflate-sigs.h describes,
 * with the functions it calls (found by their bytes at their distances) */
int kb_inflate_at(struct kb_cpu* cpu, uint64_t pc) {
    uint64_t head;
    if (!kb_read(cpu, pc, &head, 8) || head != row.head) return 0;
    if (!is_code(cpu, pc, row.len, row.head, row.hash) ||
        !is_code(
            cpu, pc + (uint64_t) (int64_t) row.dfill, row.flen, row.fhead,
            row.fhash
        ) ||
        !is_code(
            cpu, pc + (uint64_t) (int64_t) row.dflush, row.wlen, row.whead,
            row.whash
        ))
        return 0;
    return entry = pc, 1;
}
// #endregion

// #region stream
/* what the call that came back from the guest is waiting for */
enum
{
    FILL = 1,
    FLUSH
};

static struct {
    int on, id, pending, finalized;
    uint64_t sp0, ret, mark;
    uint32_t nwin, rem, k;
    uint64_t cons;   /* the stream's bytes the decode needs, all told */
    uint64_t have;   /* the stream's bytes the guest has read so far */
    uint64_t base;   /* the stream's bytes before the buffer it holds now */
    uint32_t inptr0; /* where the stream began in the buffer the call found */
    int fills;       /* guest reads made */
    uint8_t* stage;
} cur;
static uint64_t serial;

static void die(void) {
    fprintf(kb_log, "katybug: a host inflate stream lost its state\n");
    fflush(kb_log);
    _exit(134);
}

static uint64_t at(int32_t d) {
    return entry + (uint64_t) (int64_t) d;
}

static int rd32(struct kb_cpu* cpu, int32_t d, uint32_t* v) {
    return kb_read(cpu, at(d), v, 4);
}
static int wr32(struct kb_cpu* cpu, int32_t d, uint32_t v) {
    return kb_write(cpu, at(d), &v, 4);
}

/* every handler installed is gzip's own, which ends the process */
static int handlers_ok(struct kb_cpu* cpu) {
    uint64_t seen = 0;
    for (int i = 1; i < 65; i++) {
        uint64_t h = cpu->sig[i].handler;
        if (h <= 1 || h == seen) continue;
        if (!is_code(cpu, h, row.hlen, row.hhead, row.hhash)) return 0;
        seen = h;
    }
    return 1;
}

/* runs the guest function at target and comes back to inflate's entry with
 * the stack as the call found it (the callee returns to the word it is given
 * and a pad word keeps its frame aligned) */
static int call_guest(struct kb_cpu* cpu, uint64_t target, uint64_t* next) {
    uint64_t sp = cpu->r[4] - 16, word[2] = {entry, 0};
    if (!kb_write(cpu, sp, word, 16)) die();
    cpu->r[4] = sp;
    *next = target;
    return 1;
}

static void release(void) {
    if (cur.id > 0) hi_close(cur.id);
    free(cur.stage);
    memset(&cur, 0, sizeof cur);
}

/* the next thing gzip's code would do: read when the decode reaches the end of
 * the buffer, write a full window, and at the end the last partial one */
static int step(struct kb_cpu* cpu, uint64_t* next) {
    uint64_t need =
        cur.k < cur.nwin ? (uint64_t) hi_mark(cur.id, (int) cur.k) : cur.cons;
    if (cur.k < cur.nwin && (int64_t) need < 0) die();
    if (cur.have < need) {
        cur.pending = FILL;
        cpu->r[7] = 0;
        return call_guest(cpu, at(row.dfill), next);
    }
    uint32_t n = 0;
    if (cur.k < cur.nwin)
        n = WSIZE;
    else if (!cur.finalized)
        n = cur.rem, cur.finalized = 1;
    if (n) {
        if (hi_copy(cur.id, cur.stage, (int) cur.k) != (int) n ||
            !kb_write(cpu, at(row.window), cur.stage, n) ||
            !wr32(cpu, row.outcnt, n))
            die();
        if (n == WSIZE) cur.k++;
        cur.pending = FLUSH;
        return call_guest(cpu, at(row.dflush), next);
    }
    /* the stream is out: the buffer is where gzip's decode would leave it */
    uint32_t inptr = cur.fills ? (uint32_t) (cur.cons - cur.base)
                               : cur.inptr0 + (uint32_t) cur.cons;
    uint64_t zero = 0;
    if (!wr32(cpu, row.inptr, inptr) || !wr32(cpu, row.bk, 0) ||
        !kb_write(cpu, at(row.bb), &zero, 8))
        die();
    uint64_t ret = cur.ret;
    release();
    cpu->r[0] = 0;
    cpu->r[4] += 8;
    *next = ret;
    return 1;
}

/* a call that came back from fill_inbuf or flush_window */
static int resume(struct kb_cpu* cpu, uint64_t* next) {
    uint32_t bk = 0, insize = 0;
    cpu->r[4] += 8;
    if (cpu->r[4] != cur.sp0 || !rd32(cpu, row.bk, &bk) ||
        bk != (uint32_t) cur.mark)
        die();
    if (cur.pending == FILL) {
        if (!rd32(cpu, row.insize, &insize) || !insize) die();
        cur.fills++, cur.base = cur.have, cur.have += insize;
    }
    return step(cpu, next);
}

/* the stream at inflate's entry, decoded and checked, or 0 and nothing changed
 */
static int start(struct kb_cpu* cpu, uint64_t* next) {
    uint64_t sp = cpu->r[4], ret;
    uint32_t inptr, insize, ifd, bk;
    struct stat st;
    uint8_t* buf = NULL;
    int id = -1;
    static int unavailable;
    if (unavailable || kb_nthreads != 1 || (sp & 15) != 8 ||
        !kb_read(cpu, sp, &ret, 8) || !kb_can(cpu, sp - 16, 16, KB_W) ||
        !handlers_ok(cpu) || !rd32(cpu, row.inptr, &inptr) ||
        !rd32(cpu, row.insize, &insize) || !rd32(cpu, row.ifd, &ifd) ||
        !rd32(cpu, row.bk, &bk) || inptr > insize || insize > INBUFSIZ ||
        !kb_can(cpu, at(row.window), WSIZE, KB_W) ||
        !kb_can(cpu, at(row.inbuf) + inptr, insize - inptr, KB_R) ||
        !kb_can(cpu, at(row.outcnt), 4, KB_W) ||
        !kb_can(cpu, at(row.inptr), 4, KB_W) ||
        !kb_can(cpu, at(row.bk), 4, KB_W) || !kb_can(cpu, at(row.bb), 8, KB_W))
        return 0;
    /* a stream that is not ours but wears the mark is a fork child's */
    if (bk >> 16 == 0x5c5c) die();
    if (fstat((int) ifd, &st) || !S_ISREG(st.st_mode)) return 0;
    off_t pos = lseek((int) ifd, 0, SEEK_CUR);
    if (pos < 0 || pos > st.st_size) return 0;
    buf = malloc(CHUNK);
    if (!buf) return 0;
    if (!(cur.stage = malloc(WSIZE))) return free(buf), 0;
    id = hi_open();
    if (id <= 0) {
        unavailable = id < 0;
        free(buf), free(cur.stage), cur.stage = NULL;
        return 0;
    }
    uint64_t fed = 0, rest = (uint64_t) (st.st_size - pos);
    int rc = 0;
    uint64_t first = insize - inptr;
    if (first && (!kb_read(cpu, at(row.inbuf) + inptr, buf, first) ||
                  (rc = hi_feed(id, buf, first)) < 0))
        goto refuse;
    fed = first;
    for (off_t at_ = pos; rc == 0;) {
        ssize_t got = pread((int) ifd, buf, CHUNK, at_);
        if (got <= 0) goto refuse;
        at_ += got, rest -= (uint64_t) got;
        rc = hi_feed(id, buf, (size_t) got);
        if (rc < 0) goto refuse;
        fed += (uint64_t) got;
    }
    {
        uint32_t w[4];
        if (hi_stat(id, w) < 0 || !w[3] || w[2] != w[0] / WSIZE) goto refuse;
        /* what is left of the stream's bytes after its end: gzip's lookahead
         * and the 8 bytes of trailer must be there */
        if (fed - w[1] + rest < 8) goto refuse;
        cur.nwin = w[0] / WSIZE, cur.rem = w[0] % WSIZE, cur.cons = w[1];
    }
    free(buf);
    cur.on = 1, cur.id = id, cur.sp0 = sp, cur.ret = ret, cur.inptr0 = inptr;
    cur.have = first, cur.base = 0, cur.fills = 0, cur.k = 0, cur.finalized = 0;
    cur.mark = 0x5c5c0000u + (++serial & 0xffff);
    uint64_t zero = 0;
    if (!wr32(cpu, row.outcnt, 0) || !wr32(cpu, row.bk, (uint32_t) cur.mark) ||
        !kb_write(cpu, at(row.bb), &zero, 8))
        die();
    return step(cpu, next) ? 2 : 0;
refuse:
    free(buf);
    free(cur.stage);
    cur.stage = NULL;
    hi_close(id);
    return 0;
}

/** inflate's entry: 2 a stream began (the call went to the guest's own
 * function or finished), 1 a call came back, 0 not taken and nothing changed */
int kb_inflate(struct kb_cpu* cpu, uint64_t* next) {
    if (!cur.on) return start(cpu, next);
    if (cpu->r[4] != cur.sp0 - 8) die();
    return resume(cpu, next);
}
// #endregion

// #region crc
static uint64_t crctab[256];

/* gzip's crc update, the loop flush_window carries: rdx the byte pointer, rsi
 * its end, rax the running crc, r8 the table of 8 byte entries. The
 * kernel does all but the last iteration, so the block's own ops leave the
 * temporaries and flags as they always do. The table is the guest's, so one of
 * other values is still right; the standard one goes to zlib */
int kb_gzcrc(struct kb_cpu* cpu) {
    uint64_t* r = cpu->r;
    uint64_t p = r[2], end = r[6], crc = r[0];
    uint64_t t[256];
    if (end <= p || end - p < 2 || !kb_read(cpu, r[8], t, sizeof t) ||
        !kb_can(cpu, p, end - p, KB_R))
        return 0;
    uint64_t bytes = end - p - 1;
    if (!crctab[1])
        for (uint32_t i = 0; i < 256; i++) {
            uint32_t c = i;
            for (int k = 0; k < 8; k++)
                c = c & 1 ? 0xedb88320u ^ c >> 1 : c >> 1;
            crctab[i] = c;
        }
    int std = !(crc >> 32) && !memcmp(t, crctab, sizeof t);
    for (uint64_t off = 0, k; off < bytes; off += k) {
        const uint8_t* q = kb_span_r(cpu, p + off, &k);
        if (!q) return 0;
        if (k > bytes - off) k = bytes - off;
#ifdef KB_ZLIB
        if (std) {
            crc = (uint32_t) ~crc32((uLong) (uint32_t) ~crc, q, (uInt) k);
            continue;
        }
#endif
        (void) std;
        for (uint64_t i = 0; i < k; i++)
            crc = t[(crc ^ q[i]) & 0xff] ^ crc >> 8;
    }
    r[2] = p + bytes;
    r[0] = crc;
    return 1;
}
// #endregion
