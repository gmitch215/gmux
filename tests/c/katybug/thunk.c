#define _GNU_SOURCE
#include <setjmp.h>
#include <signal.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/mman.h>
#include <ucontext.h>

/* libc's memcpy, memmove, memset, strlen, memcmp, strcmp and memchr through the
 * dynamic loader's slots: results, return values and what a bad pointer does;
 * the output must be the same with katybug's kernels on and off. rip is printed
 * as an offset from the function the slot holds, and ranges as offsets from
 * their mapping. With an argument only the string functions' clean cases run */

#define PAGE 4096
#define LEN (16 * PAGE)

static void* (*volatile cp)(void*, const void*, size_t) = memcpy;
static void* (*volatile mv)(void*, const void*, size_t) = memmove;
static void* (*volatile st)(void*, int, size_t) = memset;

static sigjmp_buf env;
static uint64_t where, fault_addr;
static int got;

static void handler(int sig, siginfo_t* si, void* uc) {
    ucontext_t* u = uc;
#ifdef __x86_64__
    where = (uint64_t) u->uc_mcontext.gregs[REG_RIP];
#else
    where = (uint64_t) u->uc_mcontext.pc;
#endif
    fault_addr = (uint64_t) si->si_addr;
    got = sig;
    siglongjmp(env, 1);
}

static uint64_t sum(const uint8_t* p, size_t n) {
    uint64_t h = 1469598103934665603ull;
    for (size_t i = 0; i < n; i++) h = (h ^ p[i]) * 1099511628211ull;
    return h;
}

static uint8_t *a, *b;

static void fill(void) {
    for (size_t i = 0; i < 2 * LEN; i++) a[i] = (uint8_t) (i * 7 + (i >> 8));
    memset(b, 0x5a, 2 * LEN);
}

/* 0 = copy, 1 = move, 2 = set; the output covers the arguments' effects and the
 * fault */
static void run(
    const char* name, int op, uint8_t* d, const uint8_t* s, size_t n, int c,
    uint8_t* base
) {
    void* r = 0;
    uintptr_t fn = op == 0   ? (uintptr_t) cp
                   : op == 1 ? (uintptr_t) mv
                             : (uintptr_t) st;
    got = 0;
    if (!sigsetjmp(env, 1)) {
        if (op == 0)
            r = cp(d, s, n);
        else if (op == 1)
            r = mv(d, s, n);
        else
            r = st(d, c, n);
    }
    mprotect(a + PAGE, PAGE, PROT_READ | PROT_WRITE);
    mprotect(b + PAGE, PAGE, PROT_READ | PROT_WRITE);
    printf("%s: ret=%s", name, got ? "-" : r == d ? "dst" : "other");
    if (got) {
        int in_a = fault_addr - (uint64_t) a < 2 * LEN + PAGE;
        int in_b = fault_addr - (uint64_t) b < 2 * LEN + PAGE;
        if (in_a || in_b)
            printf(
                " sig=%d addr=%c%+lld", got, in_a ? 'a' : 'b',
                (long long) (fault_addr - (uint64_t) (in_a ? a : b))
            );
        else
            printf(" sig=%d addr=%#llx", got, (unsigned long long) fault_addr);
        printf(" rip=%+lld", (long long) (where - fn));
    }
    printf(" sum=%016llx\n", (unsigned long long) sum(base, LEN));
}

static size_t (*volatile sl)(const char*) = strlen;
static int (*volatile mc)(const void*, const void*, size_t) = memcmp;
static int (*volatile sc)(const char*, const char*) = strcmp;
static void* (*volatile mh)(const void*, int, size_t) = memchr;

/* 0 strlen, 1 memcmp, 2 strcmp, 3 memchr; memchr's result is an offset from ref
 */
static void tc(
    const char* name, int op, const void* p, const void* q, size_t n, int c,
    const void* ref
) {
    long long r = 0;
    uintptr_t fn = op == 0   ? (uintptr_t) sl
                   : op == 1 ? (uintptr_t) mc
                   : op == 2 ? (uintptr_t) sc
                             : (uintptr_t) mh;
    got = 0;
    if (!sigsetjmp(env, 1)) {
        if (op == 0)
            r = (long long) sl(p);
        else if (op == 1)
            r = mc(p, q, n);
        else if (op == 2)
            r = sc(p, q);
        else {
            const uint8_t* m = mh(p, c, n);
            r = m ? m - (const uint8_t*) ref : -9999;
        }
    }
    if (got)
        printf(
            "%s: fault sig=%d addr=%+lld rip=%+lld\n", name, got,
            (long long) (fault_addr - (uint64_t) ref), (long long) (where - fn)
        );
    else
        printf("%s: %lld\n", name, r);
}

/* bytes 1 to 63, so no 0, 'A' or 0xff in them */
static void pat(uint8_t* p, size_t n, size_t seed) {
    for (size_t i = 0; i < n; i++) p[i] = (uint8_t) (1 + (i * 13 + seed) % 63);
}

static const size_t lens[] = {0,   1,   2,   3,   7,    8,    9,   15,  16,
                              17,  31,  32,  33,  63,   64,   65,  127, 128,
                              129, 255, 256, 257, 4095, 4096, 8191};
static const size_t offs[] = {0, 1, 7, 15};

/* every length, alignment and difference of the four functions, in a readable
 * mapping, then plain calls (the PLT slot) */
static void clean(void) {
    char nm[96];
    uint8_t* s = mmap(
        0, 8 * PAGE, PROT_READ | PROT_WRITE, MAP_PRIVATE | MAP_ANONYMOUS, -1, 0
    );
    uint8_t* t = s + 4 * PAGE;
    for (size_t i = 0; i < sizeof lens / sizeof *lens; i++)
        for (size_t o = 0; o < sizeof offs / sizeof *offs; o++) {
            pat(s, 4 * PAGE, o);
            s[offs[o] + lens[i]] = 0;
            snprintf(nm, sizeof nm, "strlen n=%zu off=%zu", lens[i], offs[o]);
            tc(nm, 0, s + offs[o], 0, 0, 0, s);
        }
    static const size_t pairs[][2] = {{0, 0}, {1, 3}, {5, 0}, {0, 9}, {15, 2}};
    static const uint8_t hi[][2] = {
        {0xf0, 0x10}, {0x10, 0xf0}, {0x00, 0xff}, {0x7f, 0x80}, {0x41, 0x40}
    };
    for (size_t i = 0; i < sizeof lens / sizeof *lens; i++)
        for (size_t k = 0; k < sizeof pairs / sizeof *pairs; k++)
            for (int m = -1; m < 3 * 5; m++) {
                size_t n = lens[i], oa = pairs[k][0], ob = pairs[k][1];
                size_t d = m < 0        ? 0
                           : m % 3 == 0 ? 0
                           : m % 3 == 1 ? n / 2
                                        : n - 1;
                if (m >= 0 && !n) continue;
                pat(s, 4 * PAGE, k);
                memcpy(t + ob, s + oa, n + 1);
                if (m >= 0) s[oa + d] = hi[m / 3][0], t[ob + d] = hi[m / 3][1];
                snprintf(
                    nm, sizeof nm, "memcmp n=%zu a=%zu b=%zu diff=%d", n, oa,
                    ob, m
                );
                tc(nm, 1, s + oa, t + ob, n, 0, s);
            }
    static const size_t slens[] = {0,  1,  2,  7,  15, 16,  17,  31,
                                   32, 33, 63, 64, 65, 200, 4095};
    for (size_t i = 0; i < sizeof slens / sizeof *slens; i++)
        for (size_t k = 0; k < 3; k++)
            for (int m = 0; m < 12; m++) {
                size_t n = slens[i], oa = pairs[k][0], ob = pairs[k][1],
                       d = n / 2;
                pat(s, 4 * PAGE, k);
                s[oa + n] = 0;
                memcpy(t + ob, s + oa, n + 1);
                if (m == 1 && n) s[oa + d] = 0xf0, t[ob + d] = 0x10;
                if (m == 2 && n) s[oa + d] = 0x10, t[ob + d] = 0xf0;
                if (m == 3 && n) s[oa + d] = 0, t[ob + d] = 0x41;
                if (m == 4 && n) t[ob + d] = 0, s[oa + d] = 0x41;
                if (m == 5) t[ob + n] = 0x80, t[ob + n + 1] = 0;
                if (m == 6) s[oa + n] = 0x80, s[oa + n + 1] = 0;
                if (m == 7 && n) s[oa + n - 1] = 0xff, t[ob + n - 1] = 0xfe;
                if (m == 8 && n) s[oa + d] = 0x00, t[ob + d] = 0xff;
                if (m == 9 && n) s[oa + d] = 0x7f, t[ob + d] = 0x80;
                if (m == 10) s[oa + n] = 0, t[ob + n] = 1, t[ob + n + 1] = 0;
                snprintf(
                    nm, sizeof nm, "strcmp n=%zu a=%zu b=%zu v=%d", n, oa, ob, m
                );
                tc(nm, 2, s + oa, t + ob, 0, 0, s);
            }
    static const int cs[] = {0x41, 0x1141, 0, 0xff};
    for (size_t i = 0; i < sizeof lens / sizeof *lens; i++)
        for (size_t o = 0; o < sizeof offs / sizeof *offs; o++)
            for (int pk = -1; pk < 3; pk++)
                for (size_t ci = 0; ci < 4; ci++) {
                    size_t n = lens[i];
                    size_t pos = pk == 0 ? 0 : pk == 1 ? n / 2 : n - 1;
                    pat(s, 4 * PAGE, o);
                    if (pk >= 0 && n) s[offs[o] + pos] = (uint8_t) cs[ci];
                    if (pk >= 0 && !n) continue;
                    snprintf(
                        nm, sizeof nm, "memchr n=%zu off=%zu pos=%d c=%#x", n,
                        offs[o], pk, cs[ci]
                    );
                    tc(nm, 3, s + offs[o], 0, n, cs[ci], s + offs[o]);
                }
    for (size_t ci = 0; ci < 4; ci++) {
        pat(s, 4 * PAGE, 0);
        s[100] = (uint8_t) cs[ci];
        snprintf(nm, sizeof nm, "memchr huge n c=%#x", cs[ci]);
        tc(nm, 3, s, 0, (size_t) -1, cs[ci], s);
    }
    /* plain calls bind through the PLT */
    for (int i = 0; i < 3; i++) {
        pat(s, 4 * PAGE, 4 + i);
        s[300 + i] = 0;
        memcpy(t, s, 400);
        t[200] ^= 0x20;
        printf(
            "plain %d: %zu %d %d %d\n", i, strlen((char*) s),
            memcmp(s, t, 300) < 0, strcmp((char*) s, (char*) t) > 0,
            (int) ((uint8_t*) memchr(s, s[50 + i], 300) - s)
        );
    }
}

/* the page cases of prim-faults.c: a page and a hole, two mappings side by
 * side, a page then a PROT_NONE page */
static void pages(void) {
    uint8_t* A = (uint8_t*) 0x7e0000000000ull;
    uint8_t* B = A + 0x10000;
    uint8_t* C = A + 0x20000;
    int rw = PROT_READ | PROT_WRITE,
        fx = MAP_PRIVATE | MAP_FIXED | MAP_ANONYMOUS;
    mmap(A, 8192, rw, fx, -1, 0);
    munmap(A + 4096, 4096);
    mmap(B, 4096, rw, fx, -1, 0);
    mmap(B + 4096, 4096, rw, fx, -1, 0);
    mmap(C, 4096, rw, fx, -1, 0);
    mmap(C + 4096, 4096, PROT_NONE, fx, -1, 0);
    mmap(C + 8192, 4096, rw, fx, -1, 0);
    memset(A, 'x', 4096);
    memset(B, 'x', 8192);
    memset(C, 'x', 4096);
    memset(C + 8192, 'x', 4096);
    A[150] = 0;
    memcpy(A + 2000, "abc", 4);
    memcpy(A + 3000, "abd", 4);
    A[2100] = 'q';
    B[4150] = 0;
    B[4100] = 'q';
    A[3500] = 0;

    tc("fault strlen in a page", 0, A + 3400, 0, 0, 0, A);
    A[4095] = 0;
    tc("fault strlen ends at the last byte", 0, A + 4000, 0, 0, 0, A);
    A[4095] = 'x';
    tc("fault strlen runs off the page", 0, A + 4090, 0, 0, 0, A);
    tc("fault strlen unaligned off", 0, A + 4093, 0, 0, 0, A);
    tc("fault strlen in the hole", 0, A + 4096, 0, 0, 0, A);
    tc("fault strlen across mappings", 0, B + 4000, 0, 0, 0, B);
    tc("fault strlen into PROT_NONE", 0, C + 4090, 0, 0, 0, C);

    tc("fault memcmp equal", 1, A + 100, A + 200, 40, 0, A);
    tc("fault memcmp differs early", 1, A + 2000, A + 3000, 1 << 20, 0, A);
    tc("fault memcmp a runs off", 1, A + 4090, A + 100, 64, 0, A);
    tc("fault memcmp b runs off", 1, A + 100, A + 4090, 64, 0, A);
    tc("fault memcmp n 0 in the hole", 1, A + 4096, A + 4096, 0, 0, A);
    tc("fault memcmp across mappings", 1, B + 4000, B + 5000, 300, 0, B);
    tc("fault memcmp into PROT_NONE", 1, C + 4090, C + 200, 64, 0, C);

    tc("fault strcmp equal", 2, A + 100, A + 100, 0, 0, A);
    tc("fault strcmp differs", 2, A + 2000, A + 3000, 0, 0, A);
    tc("fault strcmp differs, reversed", 2, A + 3000, A + 2000, 0, 0, A);
    tc("fault strcmp a runs off", 2, A + 4090, A + 100, 0, 0, A);
    tc("fault strcmp b in the hole", 2, A + 2000, A + 4096, 0, 0, A);
    A[4095] = 'y';
    memset(A + 300, 'x', 5);
    A[305] = 'z';
    A[306] = 0;
    tc("fault strcmp differs before the page end", 2, A + 4090, A + 300, 0, 0,
       A);
    A[4095] = 'x';
    tc("fault strcmp across mappings", 2, B + 4000, B + 4000, 0, 0, B);
    tc("fault strcmp into PROT_NONE", 2, C + 4090, C + 100, 0, 0, C);

    tc("fault memchr in a page", 3, A + 2000, 0, 400, 'q', A);
    tc("fault memchr huge n, match early", 3, A + 2000, 0, (size_t) 1 << 40,
       'q', A);
    tc("fault memchr runs off", 3, A + 4000, 0, 200, 'z', A);
    tc("fault memchr n 0 in the hole", 3, A + 4096, 0, 0, 'q', A);
    tc("fault memchr unaligned runs off", 3, A + 4093, 0, 10, 'z', A);
    tc("fault memchr across mappings", 3, B + 4090, 0, 100, 'q', B);
    A[4095] = 'q';
    tc("fault memchr last byte", 3, A + 4000, 0, 96, 'q', A);
    tc("fault memchr past the end of n", 3, A + 4000, 0, 95, 'q', A);
    A[4095] = 'x';
    tc("fault memchr into PROT_NONE", 3, C + 4090, 0, 100, 'z', C);
}

int main(int argc, char** argv) {
    (void) argv;
    struct sigaction sa = {
        .sa_sigaction = handler, .sa_flags = SA_SIGINFO | SA_NODEFER
    };
    sigaction(SIGSEGV, &sa, 0);
    sigaction(SIGBUS, &sa, 0);
    if (argc > 1) {
        clean();
        return 0;
    }
    a = mmap(
        0, 2 * LEN + PAGE, PROT_READ | PROT_WRITE, MAP_PRIVATE | MAP_ANONYMOUS,
        -1, 0
    );
    b = mmap(
        0, 2 * LEN + PAGE, PROT_READ | PROT_WRITE, MAP_PRIVATE | MAP_ANONYMOUS,
        -1, 0
    );
    mprotect(a + 2 * LEN, PAGE, PROT_NONE);
    mprotect(b + 2 * LEN, PAGE, PROT_NONE);
    char nm[64];

    static const size_t sizes[] = {0,    1,    7,     63,    64,
                                   65,   127,  128,   255,   4095,
                                   4096, 4097, 65535, 65536, LEN - 1};
    for (size_t i = 0; i < sizeof sizes / sizeof *sizes; i++)
        for (int off = 0; off < 3; off++) {
            fill();
            snprintf(nm, sizeof nm, "copy n=%zu off=%d", sizes[i], off);
            run(nm, 0, b + 5 * off, a + 3 * off, sizes[i], 0, b);
            fill();
            snprintf(nm, sizeof nm, "move n=%zu off=%d", sizes[i], off);
            run(nm, 1, b + 5 * off, a + 3 * off, sizes[i], 0, b);
            snprintf(nm, sizeof nm, "set n=%zu off=%d", sizes[i], off);
            run(nm, 2, b + 5 * off, 0, sizes[i], 0x1ab + off, b);
        }

    static const long shifts[] = {1,  3,   64,   100,   4096,  4099, -1,
                                  -3, -64, -100, -4096, -4099, 0};
    for (size_t i = 0; i < sizeof shifts / sizeof *shifts; i++) {
        fill();
        memcpy(b, a, LEN);
        snprintf(nm, sizeof nm, "overlap shift=%ld", shifts[i]);
        run(nm, 1, b + 3 * PAGE + shifts[i], b + 3 * PAGE, 8 * PAGE + 17, 0, b);
        snprintf(nm, sizeof nm, "overlap-copy shift=%ld", shifts[i]);
        memcpy(b, a, LEN);
        if (shifts[i] <= 0 || shifts[i] >= 4096)
            run(nm, 0, b + 3 * PAGE + shifts[i], b + 3 * PAGE, 4000, 0, b);
    }

    /* a bad page: the second page of each mapping goes PROT_NONE */
    for (int bad = 0; bad < 3; bad++) {
        static const size_t sizes2[] = {64, 96, 192, 4096, 8192};
        for (size_t i = 0; i < sizeof sizes2 / sizeof *sizes2; i++) {
            fill();
            mprotect(b + PAGE, PAGE, PROT_NONE);
            mprotect(a + PAGE, PAGE, PROT_NONE);
            uint8_t* d = b + PAGE - 96;
            const uint8_t* s = a + 8 * PAGE;
            if (bad == 1) d = b + 8 * PAGE, s = a + PAGE - 96;
            if (bad == 2) d = b + PAGE - 96, s = a + PAGE - 48;
            snprintf(nm, sizeof nm, "fault copy bad=%d n=%zu", bad, sizes2[i]);
            run(nm, 0, d, s, sizes2[i], 0, b);
            snprintf(nm, sizeof nm, "fault move bad=%d n=%zu", bad, sizes2[i]);
            run(nm, 1, d, s, sizes2[i], 0, b);
            snprintf(nm, sizeof nm, "fault set bad=%d n=%zu", bad, sizes2[i]);
            run(nm, 2, d, 0, sizes2[i], 0x77, b);
            mprotect(b + PAGE, PAGE, PROT_READ | PROT_WRITE);
            mprotect(a + PAGE, PAGE, PROT_READ | PROT_WRITE);
        }
    }
    fill();
    run("fault copy null dst", 0, 0, a, 4096, 0, b);
    run("fault copy null src", 0, b, 0, 4096, 0, b);
    run("fault set null", 2, 0, 0, 4096, 1, b);
    run("fault set past end", 2, b + 2 * LEN - 16, 0, 200, 9, b);
    run("fault copy huge", 0, 0, a, (size_t) 1 << 40, 0, b);
    clean();
    pages();
    return 0;
}
