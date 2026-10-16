#include <stdint.h>

#define NR_READ 0
#define NR_WRITE 1
#define NR_MMAP 9
#define NR_MPROTECT 10
#define NR_MUNMAP 11
#define NR_BRK 12
#define NR_SIGACTION 13
#define NR_PIPE 22
#define NR_GETPID 39
#define NR_CLONE 56
#define NR_FORK 57
#define NR_EXIT 60
#define NR_WAIT4 61
#define NR_KILL 62
#define NR_FUTEX 202
#define SA_SIGINFO 4
#define SA_RESTORER 0x04000000
#define SIGUSR1 10
#define SIGSEGV 11
#define MAP_FIXED_ANON 0x32
#define PAGE 4096L

static inline __attribute__((always_inline)) long sys6(
    long n, long a, long b, long c, long d, long e, long f
) {
    long r;
    register long r10 __asm__("r10") = d;
    register long r8 __asm__("r8") = e;
    register long r9 __asm__("r9") = f;
    __asm__ volatile("syscall"
                     : "=a"(r)
                     : "a"(n), "D"(a), "S"(b), "d"(c), "r"(r10), "r"(r8),
                       "r"(r9)
                     : "rcx", "r11", "memory");
    return r;
}
#define sys(n, a, b, c) sys6(n, a, b, c, 0, 0, 0)

#define BUF 0x30000000L /* three pages the gathers work on */
#define IDX 0x38000000L /* the indexes they read: 4096 of them */
#define SIDE 0x58000000L
#define ALIAS (BUF + (1L << 32))       /* the same low 32 bits as BUF */
#define HALIAS (0x7e0000000000L + BUF) /* and far above it */
#define LONGS (3 * PAGE / 8)
#define HEAPLONGS (4 * PAGE / 8)

__asm__(".text\n"
        ".globl _start\n_start:\n xor %rbp, %rbp\n mov %rsp, %rdi\n and $-16, "
        "%rsp\n call flat_main\n hlt\n"
        ".globl restore_rt\nrestore_rt:\n mov $15, %eax\n syscall\n"
        ".globl thread_start\n.type thread_start,@function\nthread_start:\n"
        " mov %rdi, %r9\n mov $0x50f00, %edi\n xor %edx, %edx\n xor %r10d, "
        "%r10d\n xor %r8d, %r8d\n mov $56, %eax\n syscall\n test %rax, %rax\n "
        "jnz 1f\n call *%r9\n mov $60, %eax\n xor %edi, %edi\n syscall\n1: "
        "ret\n.size thread_start, .-thread_start\n");
void restore_rt(void);
long thread_start(void (*fn)(void), void* stack_top);

struct ksigaction {
    void (*handler)(int, void*, void*);
    unsigned long flags;
    void (*restorer)(void);
    unsigned long mask;
};

static volatile long faults, faddr;
static long fbase, fmode;

/* the handler gives the page back (mode 0: protection, 1: a fresh mapping) */
static void on_segv(int s, void* info, void* uc) {
    (void) s;
    (void) uc;
    long a = ((long*) info)[2];
    faults++;
    faddr += a - fbase;
    long page = a & ~(PAGE - 1);
    if (fmode == 0)
        sys(NR_MPROTECT, page, PAGE, 3);
    else
        sys6(NR_MMAP, page, PAGE, 3, MAP_FIXED_ANON, -1, 0);
}

/* a page that takes the freed block's place before the buffer is mapped again,
   so a bound kept from before reads this page's bytes, not zeros */
static void remap(void) {
    sys(NR_MUNMAP, BUF, 3 * PAGE, 0);
    sys6(NR_MMAP, SIDE, 3 * PAGE, 3, MAP_FIXED_ANON, -1, 0);
    for (long i = 0; i < LONGS; i++) ((volatile long*) SIDE)[i] = 0x5151 + i;
    sys6(NR_MMAP, BUF, 3 * PAGE, 3, MAP_FIXED_ANON, -1, 0);
}

static void on_usr1(int s) {
    (void) s;
    remap();
}

static volatile int go, ack;
static char tstack[16384] __attribute__((aligned(16)));
static void tbody(void) {
    while (!go) sys6(NR_FUTEX, (long) &go, 128, 0, 0, 0, 0);
    remap();
    ack = 1;
    sys6(NR_FUTEX, (long) &ack, 129, 1, 0, 0, 0);
}

static long heap;

/* what happens to the buffer at the iteration a gather names */
__attribute__((noinline)) static void act(long what) {
    switch (what) {
        case 1: sys(NR_MUNMAP, BUF + PAGE, PAGE, 0); break;
        case 2: sys(NR_MPROTECT, BUF + PAGE, PAGE, 0); break;
        case 3: sys(NR_MPROTECT, BUF + PAGE, PAGE, 1); break;
        case 4:
            go = 1;
            sys6(NR_FUTEX, (long) &go, 129, 1, 0, 0, 0);
            while (!ack) sys6(NR_FUTEX, (long) &ack, 128, 0, 0, 0, 0);
            break;
        case 5: sys(NR_KILL, sys(NR_GETPID, 0, 0, 0), SIGUSR1, 0); break;
        case 6: sys(NR_BRK, heap + 0x300000, 0, 0); break;
        case 7: sys(NR_MPROTECT, BUF, 3 * PAGE, 1); break;
        case 8: sys(NR_MPROTECT, BUF, 3 * PAGE, 0); break;
    }
}

/* the index comes from memory, so no bound covers b[k]: every access is one the
   lifter checks one by one, and one function per buffer keeps each site on one
   mapping for the run that counts them */
#define GATHER(name)                                                           \
    __attribute__((noinline)) static long name(                                \
        volatile long* b, const volatile unsigned* ix, long n,                 \
        volatile long at, long what                                            \
    ) {                                                                        \
        long s = 0;                                                            \
        for (long i = 0; i < n; i++) {                                         \
            long k = ix[i];                                                    \
            s += b[k];                                                         \
            b[k] = s + i;                                                      \
            if (i == at) act(what);                                            \
        }                                                                      \
        return s;                                                              \
    }
GATHER(gather)
GATHER(gather_heap)

static char out[4096];
static int used;
static void put(const char* s) {
    while (*s) out[used++] = *s++;
}
static void num(long v) {
    char b[24];
    int n = 0;
    unsigned long u = v < 0 ? -(unsigned long) v : (unsigned long) v;
    do b[n++] = (char) ('0' + u % 10);
    while (u /= 10);
    if (v < 0) out[used++] = '-';
    while (n) out[used++] = b[--n];
}
static void line(const char* k, long a, long b, long c) {
    put(k);
    put(" ");
    num(a);
    put(" ");
    num(b);
    put(" ");
    num(c);
    put("\n");
}

static void fill(long at, long n, long seed) {
    for (long i = 0; i < n; i++)
        ((volatile long*) at)[i] = i * 0x9e3779b1L + seed;
}
static long sum(long at, long n) {
    long s = 0;
    for (long i = 0; i < n; i++) s = s * 31 + ((volatile long*) at)[i];
    return s;
}
static void mkidx(long range) {
    for (long i = 0; i < 4096; i++)
        ((volatile unsigned*) IDX)[i] =
            (unsigned) ((unsigned) i * 2654435761u + 12345u) % (unsigned) range;
}

/* a new buffer of three pages, one mapping, and nothing else of the cases */
static void reset(void) {
    sys(NR_MUNMAP, ALIAS, 3 * PAGE, 0);
    sys(NR_MUNMAP, HALIAS, 3 * PAGE, 0);
    sys(NR_MUNMAP, SIDE, 3 * PAGE, 0);
    sys6(NR_MMAP, BUF, 3 * PAGE, 3, MAP_FIXED_ANON, -1, 0);
    fill(BUF, LONGS, 11);
    mkidx(LONGS);
    faults = faddr = 0;
    fbase = BUF;
    fmode = 1;
}

static int pick(const char* want, const char* name) {
    if (!want) return 1;
    while (*name)
        if (*want++ != *name++) return 0;
    return !*want;
}

static void case_page(const char* name, long what, long at, long mode) {
    reset();
    fmode = mode;
    if (at < 0) {
        if (what == 1) sys(NR_MUNMAP, BUF + PAGE, PAGE, 0);
        if (what == 2) sys(NR_MPROTECT, BUF + PAGE, PAGE, 0);
        if (what == 3) sys(NR_MPROTECT, BUF + PAGE, PAGE, 1);
        if (what == 7 || what == 8) act(what);
    }
    long r = gather((long*) BUF, (unsigned*) IDX, 3000, at, what);
    line(name, r, faults, faddr);
    put(name);
    put(" sum ");
    num(sum(BUF, LONGS));
    put("\n");
}

static void flat_run(const char* only) {
    long r;
    if (pick(only, "grow")) {
        reset();
        long p = sys(NR_BRK, 0, 0, 0);
        heap = (p + PAGE - 1) & ~(PAGE - 1);
        sys(NR_BRK, heap + 0x20000, 0, 0);
        fill(heap, HEAPLONGS, 44);
        mkidx(HEAPLONGS);
        r = gather_heap((long*) heap, (unsigned*) IDX, 3000, 1000, 6);
        ((volatile long*) (heap + 0x200000))[5] = 77;
        line(
            "grow", r, sum(heap, HEAPLONGS),
            ((volatile long*) (heap + 0x200000))[5]
        );
    }
    if (pick(only, "plain")) {
        reset();
        r = gather((long*) BUF, (unsigned*) IDX, 3000, -1, 0);
        line("plain", r, sum(BUF, LONGS), 0);
    }
    if (pick(only, "hole")) case_page("hole", 1, -1, 1);
    if (pick(only, "hole-mid")) case_page("hole-mid", 1, 1000, 1);
    if (pick(only, "none")) case_page("none", 2, -1, 0);
    if (pick(only, "none-mid")) case_page("none-mid", 2, 1000, 0);
    if (pick(only, "ro")) case_page("ro", 3, -1, 0);
    if (pick(only, "ro-mid")) case_page("ro-mid", 3, 1000, 0);
    if (pick(only, "ro-all")) case_page("ro-all", 7, -1, 0);
    if (pick(only, "ro-all-mid")) case_page("ro-all-mid", 7, 1000, 0);
    if (pick(only, "none-all")) case_page("none-all", 8, -1, 0);
    if (pick(only, "none-all-mid")) case_page("none-all-mid", 8, 1000, 0);
    if (pick(only, "alias")) {
        reset();
        sys6(NR_MMAP, ALIAS, 3 * PAGE, 3, MAP_FIXED_ANON, -1, 0);
        sys6(NR_MMAP, HALIAS, 3 * PAGE, 3, MAP_FIXED_ANON, -1, 0);
        fill(ALIAS, LONGS, 22);
        fill(HALIAS, LONGS, 33);
        long a = gather((long*) BUF, (unsigned*) IDX, 3000, -1, 0);
        long b = gather((long*) ALIAS, (unsigned*) IDX, 3000, -1, 0);
        long c = gather((long*) HALIAS, (unsigned*) IDX, 3000, -1, 0);
        line("alias", a, b, c);
        line(
            "alias sum", sum(BUF, LONGS), sum(ALIAS, LONGS), sum(HALIAS, LONGS)
        );
    }
    if (pick(only, "sigmap")) {
        reset();
        r = gather((long*) BUF, (unsigned*) IDX, 3000, 1000, 5);
        line("sigmap", r, sum(BUF, LONGS), 0);
    }
    if (pick(only, "thread")) {
        reset();
        thread_start(tbody, tstack + sizeof tstack);
        r = gather((long*) BUF, (unsigned*) IDX, 3000, 1000, 4);
        line("thread", r, sum(BUF, LONGS), 0);
    }
    if (pick(only, "fork")) {
        reset();
        int pfd[2];
        sys(NR_PIPE, (long) pfd, 0, 0);
        long pid = sys(NR_FORK, 0, 0, 0);
        if (pid == 0) {
            long v = gather((long*) BUF, (unsigned*) IDX, 3000, -1, 0);
            v += sum(BUF, LONGS);
            sys(NR_WRITE, pfd[1], (long) &v, 8);
            sys(NR_EXIT, 0, 0, 0);
        }
        int status = -1;
        long v = 0;
        sys6(NR_WAIT4, pid, (long) &status, 0, 0, 0, 0);
        sys(NR_READ, pfd[0], (long) &v, 8);
        long before = sum(BUF, LONGS);
        r = gather((long*) BUF, (unsigned*) IDX, 3000, -1, 0);
        line("fork", status, before, v);
        line("fork parent", r, sum(BUF, LONGS), 0);
    }
}

/* the loops a lifted run counts its sites in: nothing moves, one buffer */
static void warm(void) {
    reset();
    gather((long*) BUF, (unsigned*) IDX, 3000, -1, 0);
    gather((long*) BUF, (unsigned*) IDX, 3000, -1, 0);
    long p = sys(NR_BRK, 0, 0, 0);
    heap = (p + PAGE - 1) & ~(PAGE - 1);
    sys(NR_BRK, heap + 0x20000, 0, 0);
    fill(heap, HEAPLONGS, 44);
    mkidx(HEAPLONGS);
    gather_heap((long*) heap, (unsigned*) IDX, 3000, -1, 0);
    put("warm\n");
}

void flat_main(long* sp) {
    const char* only = sp[0] > 1 ? ((char**) (sp + 1))[1] : 0;
    struct ksigaction sa = {on_segv, SA_SIGINFO | SA_RESTORER, restore_rt, 0};
    sys6(NR_SIGACTION, SIGSEGV, (long) &sa, 0, 8, 0, 0);
    struct ksigaction su = {
        (void (*)(int, void*, void*)) on_usr1, SA_RESTORER, restore_rt, 0
    };
    sys6(NR_SIGACTION, SIGUSR1, (long) &su, 0, 8, 0, 0);
    sys6(NR_MMAP, IDX, 4 * PAGE, 3, MAP_FIXED_ANON, -1, 0);
    if (only && pick(only, "warm"))
        warm();
    else
        flat_run(only);
    sys(NR_WRITE, 1, (long) out, used);
    sys(NR_EXIT, 0, 0, 0);
}
