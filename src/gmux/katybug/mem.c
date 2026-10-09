#include <errno.h>
#include <stdlib.h>
#include <string.h>
#include <sys/mman.h>
#include <sys/stat.h>
#include <unistd.h>

#include "kb.h"

#define PAGE 4096ull
#define PIECE (1ull << KB_PIECE_BITS)

/* a mapping's host memory is one block per piece: the part of it inside one
 * aligned KB_PIECE-byte range of the guest address space, allocated (zeroed)
 * on first touch, so no allocation is larger than a piece */

/* blocks of this size and over come from mmap: malloc pads a 64 KiB request
 * to 17 pages, and a machine without an MMU needs a contiguous power of two
 * for that (order 5), where 16 pages need order 4 and leave nothing over */
#define MAP_MIN (16ull << 10)

/* KATYBUG_PIECE_SKEW=base[,step] (off when unset): mmap block k starts at a
 * multiple of 16 in [16, 4096) into a mapping a page longer, and the byte
 * before it holds the offset in 16s */
static int skew_on, skew_init;
static uint64_t skew_base, skew_step, skew_n;

static void skew_read(void) {
    if (skew_init) return;
    skew_init = 1;
    const char* e = getenv("KATYBUG_PIECE_SKEW");
    if (!e) return;
    char* end;
    skew_base = strtoull(e, &end, 0);
    if (*end == ',') skew_step = strtoull(end + 1, NULL, 0);
    skew_on = 1;
}

static uint8_t* block_new(uint64_t n) {
    if (n < MAP_MIN) return calloc(1, n);
    skew_read();
    void* p = mmap(
        NULL, skew_on ? n + PAGE : n, PROT_READ | PROT_WRITE,
        MAP_PRIVATE | MAP_ANON, -1, 0
    );
    if (p == MAP_FAILED) return NULL;
    if (!skew_on) return p;
    uint64_t off = 16 + (((skew_base + skew_n++ * skew_step) % 4080) & ~15ull);
    uint8_t* q = (uint8_t*) p + off;
    q[-1] = (uint8_t) (off / 16);
    return q;
}

static void block_free(uint8_t* p, uint64_t n) {
    if (!p) return;
    skew_read();
    if (n < MAP_MIN)
        free(p);
    else if (skew_on)
        munmap(p - p[-1] * 16, n + PAGE);
    else
        munmap(p, n);
}

/* p, n bytes, as a block of n2 bytes (both page multiples): the block, or NULL
 * with p untouched */
static uint8_t* block_resize(uint8_t* p, uint64_t n, uint64_t n2) {
    skew_read();
    if (n >= MAP_MIN && n2 >= MAP_MIN && n2 < n && !skew_on) {
        munmap(p + n2, n - n2);
        return p;
    }
    if (n < MAP_MIN && n2 < MAP_MIN && n2 < n) return realloc(p, n2);
    uint8_t* q = block_new(n2);
    if (!q) return NULL;
    memcpy(q, p, n < n2 ? n : n2);
    block_free(p, n);
    return q;
}

static int last = -1;

/* the last piece an image's file could not fill (it ends before a page the
 * piece holds): an access in it is a SIGBUS, as a file mapping's is */
static uint64_t bus_lo, bus_hi;

/* the mapping holding va; mappings never overlap */
static struct kb_mapping* find(struct kb_cpu* cpu, uint64_t va) {
    if (last >= 0 && last < cpu->nmaps && va >= cpu->maps[last].start &&
        va < cpu->maps[last].end)
        return &cpu->maps[last];
    for (int i = 0; i < cpu->nmaps; i++)
        if (va >= cpu->maps[i].start && va < cpu->maps[i].end) {
            last = i;
            return &cpu->maps[i];
        }
    return NULL;
}

static void changed(struct kb_cpu* cpu) {
    last = -1;
    bus_lo = bus_hi = 0;
    cpu->mapgen++;
    KB_BUMP_AS(map);
#ifdef KB_AOT
    static uint32_t seen;
    if (cpu->codegen != seen) {
        seen = cpu->codegen;
        kb_aot_stale(cpu);
    }
#endif
}

/** how many pieces [s, e) touches */
uint64_t kb_pieces(uint64_t s, uint64_t e) {
    return ((e - 1) >> KB_PIECE_BITS) - (s >> KB_PIECE_BITS) + 1;
}

/* piece i of m covers [*lo, *hi) */
static void bounds(
    const struct kb_mapping* m, uint64_t i, uint64_t* lo, uint64_t* hi
) {
    uint64_t g = ((m->start >> KB_PIECE_BITS) + i) << KB_PIECE_BITS;
    *lo = g > m->start ? g : m->start;
    *hi = g + PIECE < m->end ? g + PIECE : m->end;
}

/* n bytes at va of what an image's file puts there, into dst (zeroed): the
 * file's bytes inside each segment, nothing elsewhere. -1 when the file ends
 * before a page the range needs (the page holding its last byte is read as far
 * as it goes and zero after, as a file mapping does) */
static int image_read(
    const struct kb_image* im, uint8_t* dst, uint64_t va, uint64_t n
) {
    for (int i = 0; i < im->nseg; i++) {
        uint64_t a = va > im->seg[i].va ? va : im->seg[i].va;
        uint64_t e = im->seg[i].va + im->seg[i].len;
        if (va + n < e) e = va + n;
        if (a >= e) continue;
        uint64_t off = im->seg[i].off + (a - im->seg[i].va), got = 0;
        while (got < e - a) {
            ssize_t r = pread(
                im->fd, dst + (a - va) + got, (size_t) (e - a - got),
                (off_t) (off + got)
            );
            if (r < 0 && errno == EINTR) continue;
            if (r <= 0) break;
            got += (uint64_t) r;
        }
        if (got == e - a) continue;
        struct stat st;
        if (fstat(im->fd, &st) || (uint64_t) st.st_size > off + got)
            return -1; /* a read error, or a short read before the end */
        if (off + (e - a) > ((uint64_t) st.st_size + PAGE - 1) / PAGE * PAGE)
            return -1;
    }
    return 0;
}

/** the block of the piece of m holding va, made on first touch (read from the
 * image file when m has one: NULL when the file cannot give it); *lo is the
 * address of its first byte and *hi where it ends */
uint8_t* kb_piece(
    struct kb_cpu* cpu, struct kb_mapping* m, uint64_t va, uint64_t* lo,
    uint64_t* hi
) {
    uint64_t i = (va >> KB_PIECE_BITS) - (m->start >> KB_PIECE_BITS);
    bounds(m, i, lo, hi);
    if (m->pieces[i]) return m->pieces[i];
    uint8_t* p = block_new(*hi - *lo);
    if (p && m->image) {
        if (image_read(&cpu->images[m->image - 1], p, *lo, *hi - *lo)) {
            block_free(p, *hi - *lo);
            bus_lo = *lo, bus_hi = *hi;
            return NULL;
        }
        cpu->image_filled++;
    }
    return m->pieces[i] = p;
}

/** whether va is in the piece an image's file last failed to fill */
int kb_bus(uint64_t va) {
    return va >= bus_lo && va < bus_hi;
}

/** kb_piece without the image: a zeroed block, for a piece whose bytes come
 * from somewhere else (a fork's stream) */
uint8_t* kb_piece_blank(
    struct kb_mapping* m, uint64_t va, uint64_t* lo, uint64_t* hi
) {
    uint64_t i = (va >> KB_PIECE_BITS) - (m->start >> KB_PIECE_BITS);
    bounds(m, i, lo, hi);
    if (!m->pieces[i]) m->pieces[i] = block_new(*hi - *lo);
    return m->pieces[i];
}

/** the ELF header an image mapping starts with, from the file's copy, while
 * the mapping has not made its first piece; 0 when there is none */
int kb_image_header(
    const struct kb_cpu* cpu, const struct kb_mapping* m, uint8_t out[64]
) {
    if (!m->image) return 0;
    const struct kb_image* im = &cpu->images[m->image - 1];
    if (!im->hdr_ok || im->start != m->start) return 0;
    memcpy(out, im->hdr, 64);
    return 1;
}

/** what the image mappings hold now, and the guest memory in all */
void kb_image_report(const struct kb_cpu* cpu) {
    uint64_t held = 0, pieces = 0, pages = 0;
    for (int i = 0; i < cpu->nmaps; i++) {
        const struct kb_mapping* m = &cpu->maps[i];
        for (uint64_t k = 0, n = kb_pieces(m->start, m->end); k < n; k++) {
            if (!m->pieces[k]) continue;
            uint64_t lo, hi;
            bounds(m, k, &lo, &hi);
            pieces++, pages += (hi - lo) / PAGE;
            if (m->image) held++;
        }
    }
    fprintf(
        kb_log,
        "katybug: image pieces %llu filled of %llu, %llu held; guest memory "
        "%llu pages in %llu pieces\n",
        (unsigned long long) cpu->image_filled,
        (unsigned long long) cpu->image_total, (unsigned long long) held,
        (unsigned long long) pages, (unsigned long long) pieces
    );
}

/* kb_host, and when ic is given, ic keeps the piece; *cross is set when the
 * range starts in an accessible mapping but runs past its piece (or its end,
 * into the next mapping, which kb_read and kb_write check) */
static uint8_t* translate(
    struct kb_cpu* cpu, struct kb_ic* ic, uint64_t va, uint64_t len, int* cross
) {
    struct kb_mapping* m = find(cpu, va);
    if (!m || !m->prot || va + len < va) return NULL;
    uint64_t lo, hi;
    uint8_t* p = kb_piece(cpu, m, va, &lo, &hi);
    if (!p) return NULL;
    if (va + len > hi) {
        if (cross) *cross = 1;
        return NULL;
    }
    if (ic) *ic = (struct kb_ic){lo, hi - lo, p, cpu->mapgen};
    return p + (va - lo);
}

/* a mapping across a becomes two at a; the piece across it is copied into two
 */
static int split(struct kb_cpu* cpu, uint64_t a) {
    struct kb_mapping* m = find(cpu, a);
    if (!m || m->start == a) return 0;
    if (cpu->nmaps == (int) (sizeof cpu->maps / sizeof cpu->maps[0])) return -1;
    uint64_t i = (a >> KB_PIECE_BITS) - (m->start >> KB_PIECE_BITS);
    uint64_t n = kb_pieces(a, m->end);
    int mid = (a & (PIECE - 1)) != 0; /* a falls inside a piece */
    uint8_t** up = calloc((size_t) n, sizeof *up);
    if (!up) return -1;
    uint64_t lo, hi;
    bounds(m, i, &lo, &hi);
    if (mid && m->pieces[i]) {
        up[0] = block_new(hi - a);
        if (!up[0]) {
            free(up);
            return -1;
        }
        memcpy(up[0], m->pieces[i] + (a - lo), hi - a);
        uint8_t* low = block_resize(m->pieces[i], hi - lo, a - lo);
        if (!low) {
            block_free(up[0], hi - a);
            free(up);
            return -1;
        }
        m->pieces[i] = low;
    }
    for (uint64_t k = mid; k < n; k++) up[k] = m->pieces[i + k];
    uint8_t** keep =
        realloc(m->pieces, (size_t) kb_pieces(m->start, a) * sizeof *keep);
    cpu->maps[cpu->nmaps++] =
        (struct kb_mapping){a, m->end, up, m->prot, m->image};
    m->end = a;
    if (keep) m->pieces = keep;
    changed(cpu);
    return 0;
}

static void release(struct kb_mapping* m) {
    uint64_t n = kb_pieces(m->start, m->end);
    for (uint64_t i = 0; i < n; i++) {
        uint64_t lo, hi;
        bounds(m, i, &lo, &hi);
        block_free(m->pieces[i], hi - lo);
    }
    free(m->pieces);
}

/** the host bytes behind [va, va + len), or NULL when they are not inside one
 * piece of one accessible mapping (kb_buf and kb_read cross pieces) */
uint8_t* kb_host(struct kb_cpu* cpu, uint64_t va, uint64_t len) {
    return translate(cpu, NULL, va, len, NULL);
}

/** the host bytes at va and, in *len, how many follow in its piece; NULL when
 * va is not accessible */
uint8_t* kb_span(struct kb_cpu* cpu, uint64_t va, uint64_t* len) {
    struct kb_mapping* m = find(cpu, va);
    if (!m || !m->prot) return NULL;
    uint64_t lo, hi;
    uint8_t* p = kb_piece(cpu, m, va, &lo, &hi);
    if (!p) return NULL;
    *len = hi - va;
    return p + (va - lo);
}

/** kb_host for a KB_RESOLVE whose inline cache missed; it refills the cache */
uint8_t* kb_host_ic(
    struct kb_cpu* cpu, struct kb_ic* ic, uint64_t va, uint64_t len
) {
#ifdef KB_COUNT
    kb_count.refills++;
#endif
    return translate(cpu, ic, va, len, NULL);
}

/** copies guest [va, va + len) out to dst, or 0 when a byte is not accessible.
 * Guest ranges may cross pieces and adjacent mappings */
int kb_read(struct kb_cpu* cpu, uint64_t va, void* dst, uint64_t len) {
    for (uint64_t done = 0, k; done < len; done += k) {
        const uint8_t* p = kb_span(cpu, va + done, &k);
        if (!p) return 0;
        if (k > len - done) k = len - done;
        memcpy((uint8_t*) dst + done, p, k);
    }
    return 1;
}

/** copies src to guest [va, va + len), or 0 when a byte is not accessible */
int kb_write(struct kb_cpu* cpu, uint64_t va, const void* src, uint64_t len) {
    for (uint64_t done = 0, k; done < len; done += k) {
        uint8_t* p = kb_span(cpu, va + done, &k);
        if (!p) return 0;
        if (k > len - done) k = len - done;
        memcpy(p, (const uint8_t*) src + done, k);
    }
    return 1;
}

/** guest [va, va + len) as host pieces in iov, at most max of them; the count,
 * or -1 when a byte is not accessible. A range longer than max pieces is cut
 * short: sum the lengths for what was covered */
int kb_iov(
    struct kb_cpu* cpu, uint64_t va, uint64_t len, struct iovec* iov, int max
) {
    int n = 0;
    for (uint64_t done = 0, k; done < len; done += k) {
        uint8_t* p = kb_span(cpu, va + done, &k);
        if (!p) return -1;
        if (k > len - done) k = len - done;
        if (n < max) iov[n++] = (struct iovec){p, (size_t) k};
    }
    return n;
}

/* copies of guest ranges a syscall handler asked for as one flat buffer,
 * written back (or, for strings, dropped) when the syscall ends */
static struct {
    uint64_t va, len;
    uint8_t* buf;
} bounce[32];
static int nbounce;
static char** strs;
static int nstrs, capstrs;

/** kb_host that also serves a range crossing pieces, from a copy that goes
 * back to the guest when the syscall ends (kb_flush); NULL when the range is
 * not accessible, is over KB_BUF_MAX bytes and crosses, or the copies are used
 * up */
uint8_t* kb_buf(struct kb_cpu* cpu, uint64_t va, uint64_t len) {
    int cross = 0;
    uint8_t* p = translate(cpu, NULL, va, len, &cross);
    if (p || !cross || len > KB_BUF_MAX || nbounce == 32) return p;
    uint8_t* b = malloc(len);
    if (!b) return NULL;
    if (!kb_read(cpu, va, b, len)) {
        free(b);
        return NULL;
    }
    bounce[nbounce].va = va, bounce[nbounce].len = len,
    bounce[nbounce++].buf = b;
    return b;
}

/** the NUL-terminated guest string at va (at most 4,095 bytes), in place when
 * it sits in one piece and otherwise as a copy that lasts until the syscall
 * ends; NULL when it is not accessible or too long */
char* kb_str(struct kb_cpu* cpu, uint64_t va) {
    uint64_t k;
    uint8_t* p = kb_span(cpu, va, &k);
    if (!p) return NULL;
    uint64_t lim = k < 4096 ? k : 4096;
    if (memchr(p, 0, lim)) return (char*) p;
    if (k >= 4096) return NULL;
    char* s = malloc(4096);
    if (!s) return NULL;
    uint64_t n = 0;
    for (;;) {
        p = kb_span(cpu, va + n, &k);
        if (!p) break;
        uint64_t take = k < 4096 - n ? k : 4096 - n;
        uint8_t* z = memchr(p, 0, take);
        if (z) take = (uint64_t) (z - p) + 1;
        memcpy(s + n, p, take);
        n += take;
        if (z) {
            if (nstrs == capstrs) {
                char** g = realloc(
                    strs,
                    (size_t) (capstrs = capstrs ? 2 * capstrs : 16) * sizeof *g
                );
                if (!g) break;
                strs = g;
            }
            return strs[nstrs++] = s;
        }
        if (n >= 4096) break;
    }
    free(s);
    return NULL;
}

/** ends a syscall's use of kb_buf and kb_str: copies go back to the guest */
void kb_flush(struct kb_cpu* cpu) {
    while (nbounce) {
        nbounce--;
        kb_write(
            cpu, bounce[nbounce].va, bounce[nbounce].buf, bounce[nbounce].len
        );
        free(bounce[nbounce].buf);
    }
    while (nstrs) free(strs[--nstrs]);
}

static struct kb_mapping* add(
    struct kb_cpu* cpu, uint64_t s, uint64_t e, uint8_t** pieces, int prot
) {
    if (cpu->nmaps == (int) (sizeof cpu->maps / sizeof cpu->maps[0]))
        return NULL;
    struct kb_mapping* m = &cpu->maps[cpu->nmaps++];
    *m = (struct kb_mapping){s, e, pieces, prot, 0};
    changed(cpu);
    return m;
}

/** a new mapping over [start, start + len), zeroed; what was there goes, as
 * MAP_FIXED does */
struct kb_mapping* kb_map(
    struct kb_cpu* cpu, uint64_t start, uint64_t len, int prot
) {
    uint64_t s = start & ~(PAGE - 1);
    uint64_t e = (start + len + PAGE - 1) & ~(PAGE - 1);
    if (kb_unmap(cpu, s, e - s)) return NULL;
    uint8_t** pieces = calloc((size_t) kb_pieces(s, e), sizeof *pieces);
    if (!pieces) return NULL;
    struct kb_mapping* m = add(cpu, s, e, pieces, prot);
    if (!m) free(pieces);
    return m;
}

/** the mapping m, ending at its end, now ends at end (page aligned, above); the
 * new bytes are zero. 0, or -1 when out of memory */
int kb_grow(struct kb_cpu* cpu, struct kb_mapping* m, uint64_t end) {
    uint64_t n0 = kb_pieces(m->start, m->end), n1 = kb_pieces(m->start, end);
    if (n1 > n0) {
        uint8_t** g = realloc(m->pieces, (size_t) n1 * sizeof *g);
        if (!g) return -1;
        memset(g + n0, 0, (size_t) (n1 - n0) * sizeof *g);
        m->pieces = g;
    }
    uint64_t lo, hi, nhi;
    bounds(m, n0 - 1, &lo, &hi);
    struct kb_mapping grown = *m;
    grown.end = end;
    bounds(&grown, n0 - 1, &lo, &nhi);
    if (m->pieces[n0 - 1] && nhi > hi) {
        uint8_t* p = block_resize(m->pieces[n0 - 1], hi - lo, nhi - lo);
        if (!p) return -1;
        m->pieces[n0 - 1] = p;
    }
    m->end = end;
    changed(cpu);
    return 0;
}

/** the lowest address from at up where len bytes touch no mapping */
uint64_t kb_free_at(struct kb_cpu* cpu, uint64_t at, uint64_t len) {
    for (int i = 0; i < cpu->nmaps; i++)
        if (cpu->maps[i].start < at + len && cpu->maps[i].end > at) {
            at = cpu->maps[i].end + PAGE;
            i = -1;
        }
    return at;
}

/** munmap: the pages of [start, start + len) go, splitting mappings across its
 * ends */
int kb_unmap(struct kb_cpu* cpu, uint64_t start, uint64_t len) {
    uint64_t e = (start + len + PAGE - 1) & ~(PAGE - 1);
    if (split(cpu, start) || split(cpu, e)) return -1;
    for (int i = 0; i < cpu->nmaps; i++) {
        struct kb_mapping* m = &cpu->maps[i];
        if (m->start >= start && m->end <= e) {
            if (m->prot & 4) cpu->codegen++; /* blocks decoded from it go */
            release(m);
            *m = cpu->maps[--cpu->nmaps];
            i--;
        }
    }
    changed(cpu);
    return 0;
}

/** mprotect, splitting mappings across the range's ends */
int kb_protect(struct kb_cpu* cpu, uint64_t start, uint64_t len, int prot) {
    uint64_t e = (start + len + PAGE - 1) & ~(PAGE - 1);
    if (split(cpu, start) || split(cpu, e)) return -1;
    for (int i = 0; i < cpu->nmaps; i++) {
        struct kb_mapping* m = &cpu->maps[i];
        if (m->start >= start && m->end <= e) {
            if ((m->prot ^ prot) & 4) cpu->codegen++;
            m->prot = prot;
        }
    }
    changed(cpu);
    return 0;
}

uint64_t kb_load(struct kb_cpu* cpu, uint64_t va, int w) {
    return kb_load_ic(cpu, NULL, va, w);
}

void kb_store(struct kb_cpu* cpu, uint64_t va, uint64_t v, int w) {
    kb_store_ic(cpu, NULL, va, v, w);
}

/* what a faulting access reports: x86 gives the first byte it cannot reach
 * (the page it ran into), AArch64 the access's own address */
static uint64_t fault_at(struct kb_cpu* cpu, uint64_t va, int w) {
    if (cpu->arch != KB_X86) return va;
    for (uint64_t at = 0, k; at < (uint64_t) w; at += k)
        if (!kb_span(cpu, va + at, &k)) return va + at;
    return va;
}

/* the slow path of a load or store whose inline cache missed; run.c holds the
 * fast one. An access across a piece boundary goes through both pieces */
uint64_t kb_load_ic(struct kb_cpu* cpu, struct kb_ic* ic, uint64_t va, int w) {
#ifdef KB_COUNT
    kb_count.refills += ic != NULL;
#endif
    int cross = 0;
    uint64_t v = 0;
    uint8_t* p = translate(cpu, ic, va, (uint64_t) w, &cross);
    if (p)
        memcpy(
            &v, p, (size_t) w
        ); /* hosts are little-endian, as both guests are */
    else if (!cross || !kb_read(cpu, va, &v, (uint64_t) w)) {
        cpu->fault = "load outside the address space";
        cpu->fault_addr = fault_at(cpu, va, w);
        cpu->fault_sig = kb_bus(cpu->fault_addr) ? 7 : 11;
        return 0;
    }
    return v;
}

void kb_store_ic(
    struct kb_cpu* cpu, struct kb_ic* ic, uint64_t va, uint64_t v, int w
) {
#ifdef KB_COUNT
    kb_count.refills += ic != NULL;
#endif
    int cross = 0;
    uint8_t probe[8];
    uint8_t* p = translate(cpu, ic, va, (uint64_t) w, &cross);
    if (p)
        memcpy(p, &v, (size_t) w);
    else if (
        !cross || !kb_read(cpu, va, probe, (uint64_t) w) ||
        !kb_write(cpu, va, &v, (uint64_t) w)
    ) {
        cpu->fault = "store outside the address space";
        cpu->fault_addr = fault_at(cpu, va, w);
        cpu->fault_sig = kb_bus(cpu->fault_addr) ? 7 : 11;
    }
}
