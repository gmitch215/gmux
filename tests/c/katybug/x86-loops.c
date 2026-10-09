#include <stdint.h>

#define NR_WRITE 1
#define NR_MMAP 9
#define NR_MPROTECT 10
#define NR_MUNMAP 11
#define NR_SIGACTION 13
#define NR_GETPID 39
#define NR_KILL 62
#define NR_FUTEX 202
#define NR_CLONE 56
#define NR_EXIT 60
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

#define BUF 0x30000000L  /* one page the loops work on */
#define BIG 0x40000000L  /* two pieces, for the straddling loop */
#define MASK 0x50000000L /* two pages the masked loop starts with */
#define HIGH 0x7e0000200000L
#define SIDE 0x58000000L

/* a loop's base register is the same for every iteration, so its accesses are
   one window kept across iterations; every case then takes something away or
   moves it under the loop, and the loop must see what native Linux does */
__asm__(".text\n"
        ".globl _start\n_start:\n xor %rbp, %rbp\n mov %rsp, %rdi\n and $-16, "
        "%rsp\n call loops_main\n hlt\n"
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

/* the page that takes the freed block's place before the buffer is mapped
   again, so a window kept from before reads this page's bytes, not zeros */
static void remap(void) {
    sys(NR_MUNMAP, BUF, PAGE, 0);
    sys6(NR_MMAP, SIDE, PAGE, 3, MAP_FIXED_ANON, -1, 0);
    ((volatile long*) SIDE)[2] = 0x5151;
    sys6(NR_MMAP, BUF, PAGE, 3, MAP_FIXED_ANON, -1, 0);
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

/* b[2] is read and b[3] written in every iteration */
__attribute__((noinline)) static long walk(volatile long* b, long n) {
    long s = 0;
    for (long i = 0; i < n; i++) {
        s += b[2];
        b[3] = s + i;
    }
    return s;
}

/* the page of b goes to `prot` at iteration `at`; the handler gives it back */
__attribute__((noinline)) static long walk_prot(
    volatile long* b, long n, volatile long at, long prot
) {
    long s = 0;
    for (long i = 0; i < n; i++) {
        s += b[2];
        b[3] = s + i;
        if (i == at) sys(NR_MPROTECT, (long) b & ~(PAGE - 1), PAGE, prot);
    }
    return s;
}

/* an index masked to 2048 elements over a mapping of 1024 */
__attribute__((noinline)) static long walk_mask(volatile long* b, long n) {
    long s = 0;
    for (long i = 0; i < n; i++) {
        long k = (i * 13) & 0x7ff;
        s += b[k];
        b[k] = s + i;
    }
    return s;
}

/* a mapping far away comes and goes between two iterations */
__attribute__((noinline)) static long walk_high(
    volatile long* b, long n, volatile long at
) {
    long s = 0;
    for (long i = 0; i < n; i++) {
        s += b[2];
        b[3] = s + i;
        if (i == at) sys6(NR_MMAP, HIGH, PAGE, 3, MAP_FIXED_ANON, -1, 0);
        if (i == at + 5) sys(NR_MUNMAP, HIGH, PAGE, 0);
    }
    return s;
}

/* another thread unmaps the buffer and maps a fresh one while this one waits */
__attribute__((noinline)) static long walk_thread(
    volatile long* b, long n, volatile long at
) {
    long s = 0;
    for (long i = 0; i < n; i++) {
        s += b[2];
        b[3] = s + i;
        if (i == at) {
            go = 1;
            sys6(NR_FUTEX, (long) &go, 129, 1, 0, 0, 0);
            while (!ack) sys6(NR_FUTEX, (long) &ack, 128, 0, 0, 0, 0);
        }
    }
    return s;
}

/* a signal handler unmaps the buffer and maps a fresh one */
__attribute__((noinline)) static long walk_sig(
    volatile long* b, long n, volatile long at
) {
    long s = 0;
    for (long i = 0; i < n; i++) {
        s += b[2];
        b[3] = s + i;
        if (i == at) sys(NR_KILL, sys(NR_GETPID, 0, 0, 0), SIGUSR1, 0);
    }
    return s;
}

static char out[2048];
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

static void fill(long at, long n) {
    for (long i = 0; i < n; i++)
        ((volatile long*) at)[i] = i * 0x9e3779b1L + 11;
}
static long sum(long at, long n) {
    long s = 0;
    for (long i = 0; i < n; i++) s = s * 31 + ((volatile long*) at)[i];
    return s;
}

static int pick(const char* want, const char* name) {
    if (!want) return 1;
    while (*name)
        if (*want++ != *name++) return 0;
    return !*want;
}

void loops_main(long* sp) {
    const char* only = sp[0] > 1 ? ((char**) (sp + 1))[1] : 0;
    struct ksigaction sa = {on_segv, SA_SIGINFO | SA_RESTORER, restore_rt, 0};
    sys6(NR_SIGACTION, SIGSEGV, (long) &sa, 0, 8, 0, 0);
    struct ksigaction su = {
        (void (*)(int, void*, void*)) on_usr1, SA_RESTORER, restore_rt, 0
    };
    sys6(NR_SIGACTION, SIGUSR1, (long) &su, 0, 8, 0, 0);
    sys6(NR_MMAP, BUF, PAGE, 3, MAP_FIXED_ANON, -1, 0);
    sys6(NR_MMAP, BIG, 0x20000, 3, MAP_FIXED_ANON, -1, 0);
    long r;
    if (pick(only, "plain")) {
        fill(BUF, 64);
        r = walk((long*) BUF, 300);
        line("plain", r, sum(BUF, 64), 0);
    }
    if (pick(only, "straddle")) {
        fill(BIG, 0x20000 / 8);
        r = walk((long*) (BIG + 0xffec), 300);
        line("straddle", r, sum(BIG, 0x20000 / 8), 0);
    }
    if (pick(only, "none")) {
        fill(BUF, 64);
        faults = faddr = 0;
        fbase = BUF;
        fmode = 0;
        r = walk_prot((long*) BUF, 300, 100, 0);
        line("none", r, faults, faddr);
        line("none sum", sum(BUF, 64), 0, 0);
    }
    /* katybug maps a read-only page as writable (mem.c checks only for a zero
       protection), so this case runs when it is named and not by default */
    if (only && pick(only, "ro")) {
        sys(NR_MPROTECT, BUF, PAGE, 3);
        fill(BUF, 64);
        faults = faddr = 0;
        fbase = BUF;
        fmode = 0;
        r = walk_prot((long*) BUF, 300, 100, 1);
        line("ro", r, faults, faddr);
        line("ro sum", sum(BUF, 64), 0, 0);
    }
    if (pick(only, "over")) {
        sys6(NR_MMAP, MASK, 2 * PAGE, 3, MAP_FIXED_ANON, -1, 0);
        fill(MASK, 2 * PAGE / 8);
        faults = faddr = 0;
        fbase = MASK;
        fmode = 1;
        r = walk_mask((long*) MASK, 700);
        line("over", r, faults, faddr);
        line("over sum", sum(MASK, 0x4000 / 8), 0, 0);
    }
    if (pick(only, "high")) {
        fill(BUF, 64);
        r = walk_high((long*) BUF, 300, 100);
        line("high", r, sum(BUF, 64), 0);
    }
    if (pick(only, "thread")) {
        fill(BUF, 64);
        thread_start(tbody, tstack + sizeof tstack);
        r = walk_thread((long*) BUF, 300, 100);
        line("thread", r, sum(BUF, 64), 0);
    }
    if (pick(only, "sigmap")) {
        fill(BUF, 64);
        r = walk_sig((long*) BUF, 300, 100);
        line("sigmap", r, sum(BUF, 64), 0);
    }
    sys(NR_WRITE, 1, (long) out, used);
    sys(NR_EXIT, 0, 0, 0);
}
