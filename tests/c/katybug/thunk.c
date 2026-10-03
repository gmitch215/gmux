#define _GNU_SOURCE
#include <setjmp.h>
#include <signal.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/mman.h>
#include <ucontext.h>

/* libc's memcpy, memmove and memset through the dynamic loader's slots:
 * results, return values and what a bad pointer does; the output must be the
 * same with katybug's kernels on and off. rip is printed as an offset from the
 * function the slot holds, and ranges as offsets from their mapping */

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

int main(void) {
    struct sigaction sa = {
        .sa_sigaction = handler, .sa_flags = SA_SIGINFO | SA_NODEFER
    };
    sigaction(SIGSEGV, &sa, 0);
    sigaction(SIGBUS, &sa, 0);
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
    return 0;
}
