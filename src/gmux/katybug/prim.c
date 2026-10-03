#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "kb.h"

/*
 * String functions run as host kernels. A block that starts at the entry of
 * musl's strlen, memcmp, strcmp or memchr (the whole function's bytes match a
 * build below) begins with a KB_PRIM op: it computes the result over guest
 * memory and returns to the caller. The functions only read, so a kernel that
 * reaches a page it cannot read gives up before it has changed anything, and
 * the interpreter runs the function's own code, faulting where it always did
 */

enum
{
    P_STRLEN = 1,
    P_MEMCMP,
    P_STRCMP,
    P_MEMCHR,
    P_MEMCPY =
        KB_THUNK_MEMCPY, /* the three below are found by name (thunk.c) */
    P_MEMMOVE = KB_THUNK_MEMMOVE,
    P_MEMSET = KB_THUNK_MEMSET,
    P_COUNT
};

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
};

static const char* const names[P_COUNT] = {"",        "strlen", "memcmp",
                                           "strcmp",  "memchr", "memcpy",
                                           "memmove", "memset"};

static uint64_t calls[P_COUNT], gave_up[P_COUNT];

/* bit i: function i runs as a kernel; KATYBUG_PRIM is 0 (none) or a
 * comma-separated list of names, and every function when unset */
int kb_prim_enabled(void) {
    static int mask = -1;
    if (mask < 0) {
        const char* e = getenv("KATYBUG_PRIM");
        mask = 0;
        for (int i = 1; i < P_COUNT; i++)
            if (!e || strstr(e, names[i])) mask |= 1 << i;
    }
    return mask;
}

/** the function whose entry is pc (1 strlen, 2 memcmp, 3 strcmp, 4 memchr), or
 * 0 */
int kb_prim_at(struct kb_cpu* cpu, uint64_t pc) {
    int on = kb_prim_enabled();
    for (size_t i = 0; on && i < sizeof sigs / sizeof *sigs; i++) {
        const struct sig* s = &sigs[i];
        if (s->arch != cpu->arch || !(on >> s->id & 1)) continue;
        const uint8_t* p = kb_host(cpu, pc, s->len);
        if (!p) continue;
        uint64_t head, h = 0xcbf29ce484222325ull;
        memcpy(&head, p, 8);
        if (head != s->head) continue;
        for (uint32_t k = 0; k < s->len; k++) h = (h ^ p[k]) * 0x100000001b3ull;
        if (h == s->hash) return s->id;
    }
    int t = on >> KB_THUNK_MEMCPY ? kb_thunk_at(cpu, pc) : 0;
    return t && (on >> t & 1) ? t : 0;
}

static uint64_t min3(uint64_t a, uint64_t b, uint64_t c) {
    uint64_t m = a < b ? a : b;
    return m < c ? m : c;
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
    struct kb_cpu* cpu, uint64_t s, uint64_t c, uint64_t n, uint64_t* out
) {
    for (uint64_t off = 0; off < n;) {
        uint64_t k;
        const uint8_t* p = kb_span(cpu, s + off, &k);
        if (!p) return 0;
        if (k > n - off) k = n - off;
        const uint8_t* z = memchr(p, (int) (uint8_t) c, k);
        if (z) return *out = s + off + (uint64_t) (z - p), 1;
        off += k;
    }
    return *out = 0, 1;
}

static int k_memcmp(
    struct kb_cpu* cpu, uint64_t a, uint64_t b, uint64_t n, uint64_t* out
) {
    for (uint64_t off = 0; off < n;) {
        uint64_t ka, kb;
        const uint8_t *pa = kb_span(cpu, a + off, &ka),
                      *pb = kb_span(cpu, b + off, &kb);
        if (!pa || !pb) return 0;
        uint64_t k = min3(ka, kb, n - off);
        if (memcmp(pa, pb, k))
            for (uint64_t i = 0;; i++)
                if (pa[i] != pb[i])
                    return *out = (uint64_t) ((int) pa[i] - (int) pb[i]), 1;
        off += k;
    }
    return *out = 0, 1;
}

static int k_strcmp(struct kb_cpu* cpu, uint64_t a, uint64_t b, uint64_t* out) {
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
                if (pa[i] != pb[i])
                    return *out = (uint64_t) ((int) pa[i] - (int) pb[i]), 1;
        if (z) return *out = 0, 1;
        off += k;
    }
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

/** runs function id for the call being made at its entry, and returns to the
 * caller: 1 with *next the caller's pc, or 0 (nothing changed) when a page the
 * function reads is not there and the function's own code should run */
int kb_prim(struct kb_cpu* cpu, int id, uint64_t* next) {
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
        case P_MEMCMP: ok = k_memcmp(cpu, a, b, n, &v); break;
        case P_STRCMP: ok = k_strcmp(cpu, a, b, &v); break;
        case P_MEMCHR: ok = k_memchr(cpu, a, b, n, &v); break;
    }
    if (!ok) return gave_up[id]++, 0;
    calls[id]++;
    /* int results are written as 32 bits, as the compiled code does */
    r[0] =
        id == P_STRLEN || id == P_MEMCHR || id >= P_MEMCPY ? v : (uint32_t) v;
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
