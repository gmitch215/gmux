#include <stdint.h>

#if defined(__x86_64__)
    #define ARCH_X86 1
    #define NR_READ 0
    #define NR_WRITE 1
    #define NR_MMAP 9
    #define NR_MPROTECT 10
    #define NR_SIGACTION 13
    #define NR_FUTEX 202
    #define NR_EXIT 60
    #define NR_PIPE2 293
__attribute__((noinline)) static long sys6(
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
__asm__(".text\n"
        ".globl _start\n_start:\n xor %rbp, %rbp\n mov %rsp, %rdi\n and $-16, "
        "%rsp\n call rights_main\n hlt\n"
        ".globl restore_rt\nrestore_rt:\n mov $15, %eax\n syscall\n"
        ".globl thread_start\n.type thread_start,@function\nthread_start:\n"
        " mov %rdi, %r9\n mov $0x50f00, %edi\n xor %edx, %edx\n xor %r10d, "
        "%r10d\n xor %r8d, %r8d\n mov $56, %eax\n syscall\n test %rax, %rax\n "
        "jnz 1f\n call *%r9\n mov $60, %eax\n xor %edi, %edi\n syscall\n1: "
        "ret\n.size thread_start, .-thread_start\n");
/* v is the byte the patched function returns: mov eax, v; ret */
static void put_fn(unsigned char* p, int v) {
    p[0] = 0xb8, p[1] = (unsigned char) v, p[2] = p[3] = p[4] = 0, p[5] = 0xc3;
}
static void put_ret(unsigned char* p) {
    p[0] = 0xc3;
}
static void sync_code(void* p) {
    (void) p;
}
/* the byte or word a patch stores, and the code a store of it leaves */
static void patch(unsigned char* p, int v) {
    p[1] = (unsigned char) v;
}
static void patch_alias(unsigned char* volatile* pp, long idx, int v) {
    (*pp)[idx + 1] = (unsigned char) v;
}
    #define PATCH_BYTES 1
    #define PATCH_AT 1
static void patch_word(int v, unsigned char* out) {
    out[0] = (unsigned char) v;
}
/* smc_self(v): stores v over the immediate of the next instruction in the same
 * block, which returns it */
__asm__(".text\n.globl smc_self\nsmc_self:\n"
        " mov %dil, 1f+1(%rip)\n"
        "1: mov $0, %eax\n ret\n");
#elif defined(__aarch64__)
    #define NR_READ 63
    #define NR_WRITE 64
    #define NR_MMAP 222
    #define NR_MPROTECT 226
    #define NR_SIGACTION 134
    #define NR_FUTEX 98
    #define NR_EXIT 93
    #define NR_PIPE2 59
__attribute__((noinline)) static long sys6(
    long n, long a, long b, long c, long d, long e, long f
) {
    register long x0 __asm__("x0") = a;
    register long x1 __asm__("x1") = b;
    register long x2 __asm__("x2") = c;
    register long x3 __asm__("x3") = d;
    register long x4 __asm__("x4") = e;
    register long x5 __asm__("x5") = f;
    register long x8 __asm__("x8") = n;
    __asm__ volatile("svc 0"
                     : "+r"(x0)
                     : "r"(x1), "r"(x2), "r"(x3), "r"(x4), "r"(x5), "r"(x8)
                     : "memory");
    return x0;
}
__asm__(".text\n"
        ".globl _start\n_start:\n mov x0, sp\n bl rights_main\n"
        ".globl restore_rt\nrestore_rt:\n mov x8, #139\n svc 0\n"
        ".globl thread_start\n.type thread_start,@function\nthread_start:\n"
        " mov x9, x0\n movz x0, #0x0f00\n movk x0, #5, lsl #16\n mov x2, #0\n "
        "mov x3, #0\n mov x4, #0\n mov x8, #220\n svc 0\n cbnz x0, 1f\n blr "
        "x9\n mov x8, #93\n mov x0, #0\n svc 0\n1: ret\n"
        ".size thread_start, .-thread_start\n");
/* v is the value the patched function returns: movz w0, #v; ret */
static void put_fn(unsigned char* p, int v) {
    unsigned w[2] = {0x52800000u | (unsigned) v << 5, 0xd65f03c0u};
    for (int i = 0; i < 8; i++)
        p[i] = (unsigned char) (w[i / 4] >> (8 * (i % 4)));
}
static void sync_code(void* p) {
    __asm__ volatile(
        "dc cvau, %0\n dsb ish\n ic ivau, %0\n dsb ish\n isb" ::"r"(p)
        : "memory"
    );
}
static void put_ret(unsigned char* p) {
    *(unsigned*) p = 0xd65f03c0u;
    sync_code(p);
}
static void patch(unsigned char* p, int v) {
    *(volatile unsigned*) p = 0x52800000u | (unsigned) v << 5;
    sync_code(p);
}
static void patch_alias(unsigned char* volatile* pp, long idx, int v) {
    ((volatile unsigned*) *pp)[idx] = 0x52800000u | (unsigned) v << 5;
    sync_code(*pp);
}
    #define PATCH_BYTES 4
    #define PATCH_AT 0
static void patch_word(int v, unsigned char* out) {
    unsigned w = 0x52800000u | (unsigned) v << 5;
    for (int i = 0; i < 4; i++) out[i] = (unsigned char) (w >> (8 * i));
}
/* smc_self(v): stores movz w0, #v over the next instruction in the same
 * block, which returns it */
__asm__(".text\n.globl smc_self\nsmc_self:\n"
        " movz w17, #0x5280, lsl #16\n orr w17, w17, w0, lsl #5\n"
        " adr x11, 1f\n str w17, [x11]\n"
        " dc cvau, x11\n dsb ish\n ic ivau, x11\n dsb ish\n isb\n"
        "1: movz w0, #0\n ret\n");
#endif

void restore_rt(void);
long thread_start(void (*fn)(void), void* stack_top);
int smc_self(int v);

struct ksigaction {
    void (*handler)(int, void*, void*);
    unsigned long flags;
    void (*restorer)(void);
    unsigned long mask;
};

#define SA_SIGINFO 4
#define SA_RESTORER 0x04000000
#define SIGSEGV 11
#define MAP_FIXED_ANON 0x32 /* MAP_PRIVATE | MAP_FIXED | MAP_ANONYMOUS */
#define PAGE 4096L
#define EFAULT 14
#define N 3000
#define AT 1500

/* fixed mappings, so a fault's address prints as an offset into one */
#define DATA 0x7e0000000000L
#define CODE 0x7e0000200000L
#define HOLE 0x7e0000400000L
#define BIG 0x7e0000600000L

#define PROT_R 1
#define PROT_W 2
#define PROT_X 4

static char out[8192];
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
static void line(const char* k, long a, long b, long c, long d, long e) {
    put(k);
    long v[5] = {a, b, c, d, e};
    for (int i = 0; i < 5; i++) {
        put(" ");
        num(v[i]);
    }
    put("\n");
}

static void map(long at, long len, long prot) {
    sys6(NR_MMAP, at, len, prot, MAP_FIXED_ANON, -1, 0);
}

/* what the last fault was, and what the handler does about it: it gives the
 * page back its rights (mode 0), or maps a page of code over a hole (mode 1) */
static volatile long hits, fcode, faddr, fbyte, fix_prot, fix_mode;
static volatile unsigned char* volatile peek_at;

static void on_segv(int s, void* info, void* uc) {
    (void) s;
    (void) uc;
    hits++;
    fcode = ((int*) info)[2];
    faddr = ((long*) info)[2];
    /* the byte under a store that faulted is still the old one */
    if (peek_at) fbyte = *peek_at;
    long page = faddr & ~(PAGE - 1);
    if (fix_mode == 1) {
        map(page, PAGE, 7);
        put_ret((unsigned char*) page);
    }
    else
        sys6(NR_MPROTECT, page, PAGE, fix_prot, 0, 0, 0);
}

static void install(void) {
    struct ksigaction a = {on_segv, SA_SIGINFO | SA_RESTORER, restore_rt, 0};
    sys6(NR_SIGACTION, SIGSEGV, (long) &a, 0, 8, 0, 0);
}

static void reset(long prot, long mode, volatile unsigned char* peek) {
    hits = fcode = faddr = fbyte = 0;
    fix_prot = prot, fix_mode = mode, peek_at = peek;
}

/* #region stores */

/* a store to a read-only page faults at its address with SEGV_ACCERR and
 * changes nothing; once the handler gives write back, the same store goes
 * through */
static void store_ro(void) {
    map(DATA, PAGE, 3);
    for (int i = 0; i < 32; i++) ((volatile unsigned char*) DATA)[i] = 0x11;
    sys6(NR_MPROTECT, DATA, PAGE, PROT_R, 0, 0, 0);
    reset(3, 0, (volatile unsigned char*) DATA + 8);
    *(volatile unsigned char*) (DATA + 8) = 0x22;
    line(
        "store-ro", hits, fcode, faddr - DATA, fbyte,
        ((volatile unsigned char*) DATA)[8]
    );
    sys6(NR_MPROTECT, DATA, PAGE, PROT_R, 0, 0, 0);
    reset(3, 0, (volatile unsigned char*) DATA + 16);
    *(volatile long*) (DATA + 16) = 0x4443424144434241L;
    line(
        "store-ro-8", hits, fcode, faddr - DATA, fbyte,
        ((volatile unsigned char*) DATA)[23]
    );
}

#if defined(ARCH_X86)
/* a store across the end of a writable page into a read-only one faults at the
 * first byte of the second page, and the part on the first page is not written
 */
static void store_split(void) {
    map(DATA, 2 * PAGE, 3);
    for (int i = 0; i < 8; i++)
        ((volatile unsigned char*) DATA)[PAGE - 8 + i] = 0x11;
    sys6(NR_MPROTECT, DATA + PAGE, PAGE, PROT_R, 0, 0, 0);
    reset(3, 0, (volatile unsigned char*) DATA + PAGE - 4);
    *(volatile long*) (DATA + PAGE - 4) = 0x4443424144434241L;
    line(
        "store-split", hits, fcode, faddr - DATA - PAGE, fbyte,
        ((volatile unsigned char*) DATA)[PAGE - 4]
    );
}
#endif

/* a loop that has stored to a page many times loses write access in the middle
 * of the run: the next store faults, once, and the loop goes on when the
 * handler gives it back */
static void warm_w(void) {
    map(DATA, PAGE, 3);
    for (int k = 0; k < 8; k++) ((volatile long*) DATA)[k] = 0;
    reset(3, 0, 0);
    long sum = 0;
    for (long i = 0; i < N; i++) {
        if (i == AT) sys6(NR_MPROTECT, DATA, PAGE, PROT_R, 0, 0, 0);
        ((volatile long*) DATA)[i & 7] = i;
        sum += ((volatile long*) DATA)[i & 7];
    }
    line("warm-w", hits, fcode, faddr - DATA, sum, ((volatile long*) DATA)[7]);
}

/* the same for reads: the page becomes execute-only, which x86-64 Linux backs
 * with a protection key (a read faults with SEGV_PKUERR, 4) and AArch64 on a
 * core without EPAN reads as it did */
static void warm_xo(void) {
    map(DATA, PAGE, 3);
    for (int k = 0; k < 8; k++) ((volatile long*) DATA)[k] = k + 1;
    reset(3, 0, 0);
    long sum = 0;
    for (long i = 0; i < N; i++) {
        if (i == AT) sys6(NR_MPROTECT, DATA, PAGE, PROT_X, 0, 0, 0);
        sum += ((volatile long*) DATA)[i & 7];
    }
    line("warm-xo", hits, fcode, hits ? faddr - DATA : 0, sum, 0);
}

/* #endregion */

/* #region fetches */

static void fetch_nx(void) {
    map(CODE, PAGE, 3);
    put_fn((unsigned char*) CODE, 7);
    sync_code((void*) CODE);
    int (*fn)(void) = (int (*)(void)) CODE;
    reset(7, 0, 0);
    long r = fn();
    line("fetch-nx", hits, fcode, faddr - CODE, r, 0);
    /* read-only is no better */
    sys6(NR_MPROTECT, CODE, PAGE, PROT_R, 0, 0, 0);
    reset(7, 0, 0);
    r = fn();
    line("fetch-ro", hits, fcode, faddr - CODE, r, 0);
    /* a page with no access at all */
    sys6(NR_MPROTECT, CODE, PAGE, 0, 0, 0, 0);
    reset(7, 0, 0);
    r = fn();
    line("fetch-none", hits, fcode, faddr - CODE, r, 0);
}

/* code called where nothing is mapped faults at the address with SEGV_MAPERR */
static void fetch_hole(void) {
    int (*fn)(void) = (int (*)(void)) HOLE;
    reset(7, 1, 0);
    fn();
    line("fetch-hole", hits, fcode, faddr - HOLE, 0, 0);
}

/* a stack is not executable */
static void fetch_stack(void) {
    unsigned char buf[2 * PAGE] __attribute__((aligned(16)));
    unsigned char* p = buf + PAGE;
    p = (unsigned char*) ((long) p & ~(PAGE - 1));
    put_ret(p);
    reset(7, 0, 0);
    ((void (*)(void)) p)();
    line("fetch-stack", hits, fcode, faddr - (long) p, 0, 0);
}

/* a loop that has called a function many times loses the execute bit mid-run */
static void warm_x(void) {
    map(CODE, PAGE, 7);
    put_fn((unsigned char*) CODE, 3);
    sync_code((void*) CODE);
    int (*fn)(void) = (int (*)(void)) CODE;
    reset(7, 0, 0);
    long sum = 0;
    for (long i = 0; i < N; i++) {
        if (i == AT) sys6(NR_MPROTECT, CODE, PAGE, 3, 0, 0, 0);
        sum += fn();
    }
    line("warm-x", hits, fcode, faddr - CODE, sum, 0);
}

/* #endregion */

/* #region system calls */

/* read() into a buffer the page does not let the kernel write fails with
 * EFAULT and leaves it alone; write() from one it does not let the kernel read
 * does too; both go through once the page allows */
static int pipe_fd[2];

static void feed(void) {
    sys6(NR_WRITE, pipe_fd[1], (long) "0123456789abcdef", 16, 0, 0, 0);
}

/* what is left in the pipe after a read and a write that may have failed */
static void drain(long r, long w) {
    char t[64];
    long left = (r < 0 ? 16 : 0) + (w > 0 ? w : 0);
    while (left > 0) {
        long got = sys6(NR_READ, pipe_fd[0], (long) t, left, 0, 0, 0);
        if (got <= 0) break;
        left -= got;
    }
}

static void io_case(const char* name, long prot) {
    map(DATA, PAGE, 3);
    for (int i = 0; i < 32; i++) ((volatile unsigned char*) DATA)[i] = 0x55;
    sys6(NR_MPROTECT, DATA, PAGE, prot, 0, 0, 0);
    feed();
    long r = sys6(NR_READ, pipe_fd[0], DATA + 8, 16, 0, 0, 0);
    long w = sys6(NR_WRITE, pipe_fd[1], DATA + 8, 4, 0, 0, 0);
    sys6(NR_MPROTECT, DATA, PAGE, 3, 0, 0, 0);
    drain(r, w);
    line(name, r, w, ((volatile unsigned char*) DATA)[8], 0, 0);
}

static void io(void) {
    sys6(NR_PIPE2, (long) pipe_fd, 0, 0, 0, 0, 0);
    io_case("io-r", PROT_R);
    io_case("io-w", PROT_W);
    io_case("io-x", PROT_X);
    io_case("io-rw", PROT_R | PROT_W);
    io_case("io-rx", PROT_R | PROT_X);
    io_case("io-none", 0);
}

/* #endregion */

/* #region code written to */

/* the function at CODE returns v; a plain store, a store through another
 * address expression, a read() and a second thread each rewrite it with no
 * mprotect anywhere, and the next call returns the new value */
static int call_code(void) {
    int (*volatile f)(void) = (int (*)(void)) CODE;
    return f();
}

static void smc_store(void) {
    map(CODE, PAGE, 7);
    put_fn((unsigned char*) CODE, 1);
    sync_code((void*) CODE);
    long sum = 0, want = 0;
    for (int i = 0; i < N; i++) {
        int v = i % 5 + 1;
        patch((unsigned char*) CODE, v);
        sum += call_code();
        want += v;
    }
    line("smc-store", sum, want, 0, 0, 0);
}

static unsigned char* volatile alias_ptr;

static void smc_alias(void) {
    map(CODE, PAGE, 7);
    put_fn((unsigned char*) CODE, 1);
    sync_code((void*) CODE);
    alias_ptr = (unsigned char*) CODE;
    volatile long zero = 0;
    long sum = 0, want = 0;
    for (int i = 0; i < N; i++) {
        int v = i % 7 + 1;
        patch_alias(&alias_ptr, zero, v);
        sum += call_code();
        want += v;
    }
    line("smc-alias", sum, want, 0, 0, 0);
}

static void smc_read(void) {
    map(CODE, PAGE, 7);
    put_fn((unsigned char*) CODE, 1);
    sync_code((void*) CODE);
    int p[2];
    sys6(NR_PIPE2, (long) p, 0, 0, 0, 0, 0);
    long sum = 0, want = 0, bad = 0;
    for (int i = 0; i < 300; i++) {
        int v = i % 9 + 1;
        unsigned char b[4];
        patch_word(v, b);
        sys6(NR_WRITE, p[1], (long) b, PATCH_BYTES, 0, 0, 0);
        bad += sys6(NR_READ, p[0], CODE + PATCH_AT, PATCH_BYTES, 0, 0, 0) !=
               PATCH_BYTES;
        sync_code((void*) CODE);
        sum += call_code();
        want += v;
    }
    line("smc-read", sum, want, bad, 0, 0);
}

/* a store that patches an instruction later in its own block: the one after it
 * runs the new bytes */
static void smc_own(void) {
    long sum = 0, want = 0;
    for (int i = 0; i < N; i++) {
        int v = i % 11 + 1;
        sum += smc_self(v);
        want += v;
    }
    line("smc-self", sum, want, 0, 0, 0);
}

static volatile int go, ack;
static char tstack[16384] __attribute__((aligned(16)));

static void tbody(void) {
    while (!go) sys6(NR_FUTEX, (long) &go, 128, 0, 0, 0, 0);
    patch((unsigned char*) CODE, 9);
    ack = 1;
    sys6(NR_FUTEX, (long) &ack, 129, 1, 0, 0, 0);
}

/* another thread stores into the code this one runs, while this one waits */
static void smc_thread(void) {
    map(CODE, PAGE, 7);
    put_fn((unsigned char*) CODE, 4);
    sync_code((void*) CODE);
    thread_start(tbody, tstack + sizeof tstack);
    long sum = 0, want = 0;
    for (long i = 0; i < 300; i++) {
        if (i == 100) {
            go = 1;
            sys6(NR_FUTEX, (long) &go, 129, 1, 0, 0, 0);
            while (!ack) sys6(NR_FUTEX, (long) &ack, 128, 0, 0, 0, 0);
        }
        sum += call_code();
        want += i < 100 ? 4 : 9;
    }
    line("smc-thread", sum, want, 0, 0, 0);
}

/* data in the page of code, written in every iteration, is not code: the loop
 * decodes nothing after its first pass (run.sh counts the blocks at two
 * lengths) */
static void smc_data(long n) {
    map(CODE, PAGE, 7);
    put_fn((unsigned char*) CODE, 6);
    sync_code((void*) CODE);
    volatile long* d = (volatile long*) (CODE + 1024);
    long sum = 0;
    for (long i = 0; i < n; i++) {
        d[i & 31] = i;
        ((volatile unsigned char*) (CODE + 2048))[i & 255] = (unsigned char) i;
        sum += call_code() + d[i & 31] - i;
    }
    line("smc-data", sum, n * 6, 0, 0, 0);
}

/* the JIT shape: new code in every iteration, run once */
static void smc_jit(long n) {
    map(CODE, PAGE, 7);
    long sum = 0, want = 0;
    for (long i = 0; i < n; i++) {
        int v = (int) (i % 200) + 1;
        put_fn((unsigned char*) CODE, v);
        sync_code((void*) CODE);
        sum += call_code();
        want += v;
    }
    line("smc-jit", sum, want, 0, 0, 0);
}

/* #endregion */

static long atoi_(const char* s) {
    long v = 0;
    while (s && *s >= '0' && *s <= '9') v = v * 10 + (*s++ - '0');
    return v;
}

static int same(const char* a, const char* b) {
    if (!a) return 0;
    while (*a && *a == *b) a++, b++;
    return !*a && !*b;
}

/* a case runs when no argument names one or the argument starts its name */
static int pick(const char* want, const char* name) {
    if (!want) return 1;
    while (*want)
        if (*want++ != *name++) return 0;
    return 1;
}

void rights_main(long* sp) {
    const char* only = sp[0] > 1 ? ((char**) (sp + 1))[1] : 0;
    long n = sp[0] > 2 ? atoi_(((char**) (sp + 1))[2]) : 2000;
    install();
    if (pick(only, "store-ro")) store_ro();
#if defined(ARCH_X86)
    if (pick(only, "store-split")) store_split();
#endif
    if (pick(only, "warm-w")) warm_w();
    if (pick(only, "warm-xo")) warm_xo();
    if (pick(only, "fetch-nx")) fetch_nx();
    if (pick(only, "fetch-hole")) fetch_hole();
    if (pick(only, "fetch-stack")) fetch_stack();
    if (pick(only, "warm-x")) warm_x();
    if (pick(only, "io")) io();
    if (pick(only, "smc-store")) smc_store();
    if (pick(only, "smc-alias")) smc_alias();
    if (pick(only, "smc-read")) smc_read();
#if !defined(NO_SELF)
    if (pick(only, "smc-self")) smc_own();
#endif
    if (pick(only, "smc-thread")) smc_thread();
    if (same(only, "smc-data")) smc_data(n);
    if (same(only, "smc-jit")) smc_jit(n);
    sys6(NR_WRITE, 1, (long) out, used, 0, 0, 0);
    sys6(NR_EXIT, 0, 0, 0, 0, 0, 0);
}
