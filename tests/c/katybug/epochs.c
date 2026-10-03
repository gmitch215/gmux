#include <stdint.h>

#if defined(__x86_64__)
    #define NR_READ 0
    #define NR_WRITE 1
    #define NR_MMAP 9
    #define NR_MPROTECT 10
    #define NR_MUNMAP 11
    #define NR_SIGACTION 13
    #define NR_SIGPROCMASK 14
    #define NR_GETPID 39
    #define NR_SETITIMER 38
    #define NR_KILL 62
    #define NR_EXIT 60
    #define NR_DUP3 292
    #define NR_PIPE2 293
/* one stub for every call, as libc has: the block after its syscall is shared
 */
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
__asm__(".globl _start\n_start:\n xor %rbp, %rbp\n and $-16, %rsp\n call "
        "epochs_main\n hlt\n"
        ".globl restore_rt\nrestore_rt:\n mov $15, %eax\n syscall\n");
/* eax = 8 * v by a loop of its own, so the code is several blocks that run
 * on through links: mov ecx, 8; xor eax, eax; L: add eax, v; dec ecx; jnz L;
 * ret */
static void put_code(unsigned char* p, int v) {
    static const unsigned char c[17] = {0xb9, 8,    0,    0,    0,   0x31,
                                        0xc0, 0x05, 0,    0,    0,   0,
                                        0xff, 0xc9, 0x75, 0xf7, 0xc3};
    for (int i = 0; i < 17; i++) p[i] = c[i];
    p[8] = (unsigned char) v;
}
/* smc_loop(other), c from 300 down to 1: patch the immediate of the mov at X
 * with c / 25, mprotect other (its execute bit goes off when c % 25 is 0 and
 * on again after), run X and add its immediate to a sum, which is returned.
 * Most passes leave the code generation alone, so the block that ends in the
 * syscall and its link to X stay current; the passes that change it must run
 * the new X */
__asm__(".text\n.globl smc_loop\nsmc_loop:\n"
        " push %r12\n mov %rdi, %r12\n xor %r9d, %r9d\n mov $300, %r8d\n"
        "1: mov %r8d, %eax\n xor %edx, %edx\n mov $25, %ecx\n div %ecx\n"
        " mov %al, 3f+2(%rip)\n cmp $1, %edx\n sbb %edx, %edx\n and $4, %edx\n"
        " mov $7, %ecx\n sub %edx, %ecx\n mov %ecx, %edx\n"
        " mov $10, %eax\n mov %r12, %rdi\n mov $4096, %esi\n syscall\n"
        "3: mov $0, %r10d\n add %r10d, %r9d\n dec %r8d\n jnz 1b\n"
        " mov %r9d, %eax\n pop %r12\n ret\n");
static void sync_code(void* p) {
    (void) p;
}
#elif defined(__aarch64__)
    #define NR_READ 63
    #define NR_WRITE 64
    #define NR_MMAP 222
    #define NR_MPROTECT 226
    #define NR_MUNMAP 215
    #define NR_SIGACTION 134
    #define NR_SIGPROCMASK 135
    #define NR_GETPID 172
    #define NR_SETITIMER 103
    #define NR_KILL 129
    #define NR_EXIT 93
    #define NR_DUP3 24
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
__asm__(".globl _start\n_start:\n bl epochs_main\n"
        ".globl restore_rt\nrestore_rt:\n mov x8, #139\n svc 0\n");
/* w0 = 8 * v by a loop of its own: mov w1, #8; mov w0, #0; L: add w0, w0, #v;
 * subs w1, w1, #1; b.ne L; ret */
static void put_code(unsigned char* p, int v) {
    unsigned w[6] = {0x52800101u, 0x52800000u, 0x11000000u | (unsigned) v << 10,
                     0x71000421u, 0x54ffffc1u, 0xd65f03c0u};
    for (int i = 0; i < 24; i++)
        p[i] = (unsigned char) (w[i / 4] >> (8 * (i % 4)));
}
/* smc_loop as on x86: the patched instruction is movz w13, #(c / 25) */
__asm__(".text\n.globl smc_loop\nsmc_loop:\n"
        " mov x12, x0\n mov w9, #0\n mov w10, #300\n mov w15, #25\n"
        "1: udiv w14, w10, w15\n msub w16, w14, w15, w10\n"
        " movz w17, #0x5280, lsl #16\n orr w17, w17, w14, lsl #5\n"
        " add w17, w17, #13\n adr x11, 3f\n str w17, [x11]\n"
        " dc cvau, x11\n dsb ish\n ic ivau, x11\n dsb ish\n isb\n"
        " cmp w16, #0\n mov x2, #7\n mov x3, #3\n csel x2, x3, x2, eq\n"
        " mov x8, #226\n mov x0, x12\n mov x1, #4096\n svc 0\n"
        "3: movz w13, #0\n add w9, w9, w13\n subs w10, w10, #1\n b.ne 1b\n"
        " mov w0, w9\n ret\n");
static void sync_code(void* p) {
    __asm__ volatile(
        "dc cvau, %0\n dsb ish\n ic ivau, %0\n dsb ish\n isb" ::"r"(p)
        : "memory"
    );
}
#endif

void restore_rt(void);

struct ksigaction {
    void (*handler)(int, void*, void*);
    unsigned long flags;
    void (*restorer)(void);
    unsigned long mask;
};

#define SA_SIGINFO 4
#define SA_RESTORER 0x04000000
#define SIGSEGV 11
#define SIGUSR1 10
#define SIGUSR2 12
#define SIGALRM 14
#define MAP_FIXED_ANON 0x32 /* MAP_PRIVATE | MAP_FIXED | MAP_ANONYMOUS */

/* each loop runs far past the 64 block runs that make a trace, and changes
 * what the trace assumed once at AT or every few iterations */
#define N 3000
#define AT 1500
#define DATA_AT 0x7e0000000000ul
#define CODE_AT 0x7e0000200000ul
#define DATA ((volatile long*) DATA_AT)

static void report(const char* name, int ok) {
    const char* s = ok ? " ok\n" : " FAIL\n";
    int n = 0;
    while (name[n]) n++;
    sys6(NR_WRITE, 1, (long) name, n, 0, 0, 0);
    sys6(NR_WRITE, 1, (long) s, ok ? 4 : 6, 0, 0, 0);
}

static void map_zero(unsigned long at) {
    sys6(NR_MMAP, (long) at, 4096, 3, MAP_FIXED_ANON, -1, 0);
}

static void action(int s, void (*h)(int, void*, void*)) {
    struct ksigaction a = {h, SA_SIGINFO | SA_RESTORER, restore_rt, 0};
    sys6(NR_SIGACTION, s, (long) &a, 0, 8, 0, 0);
}

static volatile long segv_mode, segv_hits, usr_hits, usr_sent, usr_bad, usr_at,
    cur, alarmed;

static void on_segv(int s, void* info, void* uc) {
    (void) s;
    (void) info;
    (void) uc;
    segv_hits++;
    if (segv_mode == 0)
        sys6(NR_MPROTECT, DATA_AT, 4096, 3, 0, 0, 0);
    else
        map_zero(DATA_AT);
}

static void on_usr(int s, void* info, void* uc) {
    (void) s;
    (void) info;
    (void) uc;
    usr_hits++;
    usr_at = cur;
    if (usr_hits != usr_sent) usr_bad++;
}

static void on_alarm(int s, void* info, void* uc) {
    (void) s;
    (void) info;
    (void) uc;
    alarmed = 1;
}

/* #region mapping generation */

/* a fresh mapping over the page one load site reads, once */
static void map_remap(void) {
    map_zero(DATA_AT);
    for (int k = 0; k < 8; k++) DATA[k] = 1;
    long sum = 0;
    for (int i = 0; i < N; i++) {
        if (i == AT) map_zero(DATA_AT);
        sum += DATA[i & 7];
    }
    report("map-remap", sum == AT);
}

/* every few iterations: remap, then a store, a load of what it stored and a
 * load of a slot that must read zero in the new page */
static void map_churn(void) {
    map_zero(DATA_AT);
    long sum = 0, bad = 0;
    for (int i = 0; i < N; i++) {
        if (i % 7 == 0) {
            map_zero(DATA_AT);
            bad += DATA[(i + 3) & 7] != 0;
        }
        DATA[i & 7] = 1;
        sum += DATA[i & 7];
    }
    report("map-churn", sum == N && bad == 0);
}

/* the page loses its access mid-loop; the handler gives it back and the load
 * runs again */
static void map_protect(void) {
    map_zero(DATA_AT);
    for (int k = 0; k < 8; k++) DATA[k] = 1;
    segv_mode = 0, segv_hits = 0;
    action(SIGSEGV, on_segv);
    long sum = 0;
    for (int i = 0; i < N; i++) {
        if (i == AT) sys6(NR_MPROTECT, DATA_AT, 4096, 0, 0, 0, 0);
        sum += DATA[i & 7];
    }
    report("map-protect", sum == N && segv_hits == 1);
}

/* the page is gone mid-loop; the handler maps a new zero one */
static void map_unmap(void) {
    map_zero(DATA_AT);
    for (int k = 0; k < 8; k++) DATA[k] = 1;
    segv_mode = 1, segv_hits = 0;
    action(SIGSEGV, on_segv);
    long sum = 0;
    for (int i = 0; i < N; i++) {
        if (i == AT) sys6(NR_MUNMAP, DATA_AT, 4096, 0, 0, 0, 0);
        sum += DATA[i & 7];
    }
    report("map-unmap", sum == AT && segv_hits == 1);
}

/* #endregion */

/* #region signal state */

/* a handler installed mid-loop, then a signal sent to this process: it runs
 * before the next instruction after the call */
static void sig_install(void) {
    long pid = sys6(NR_GETPID, 0, 0, 0, 0, 0, 0);
    usr_hits = usr_sent = usr_bad = usr_at = 0;
    for (long i = 0; i < N; i++) {
        cur = i;
        if (i == 1000) action(SIGUSR1, on_usr);
        if (i == 1001) {
            usr_sent++;
            sys6(NR_KILL, pid, SIGUSR1, 0, 0, 0, 0);
        }
    }
    report("sig-install", usr_hits == 1 && usr_at == 1001 && usr_bad == 0);
}

/* a signal pending behind the mask is let through mid-loop by sigprocmask */
static void sig_unmask(void) {
    long pid = sys6(NR_GETPID, 0, 0, 0, 0, 0, 0);
    unsigned long set = 1ul << (SIGUSR2 - 1);
    usr_hits = usr_sent = usr_bad = usr_at = 0;
    action(SIGUSR2, on_usr);
    sys6(NR_SIGPROCMASK, 0, (long) &set, 0, 8, 0, 0);
    long early = -1;
    for (long i = 0; i < N; i++) {
        cur = i;
        if (i == 500) {
            usr_sent++;
            sys6(NR_KILL, pid, SIGUSR2, 0, 0, 0, 0);
        }
        if (i == 1999) early = usr_hits;
        if (i == 2000) sys6(NR_SIGPROCMASK, 1, (long) &set, 0, 8, 0, 0);
    }
    report("sig-unmask", early == 0 && usr_hits == 1 && usr_at == 2000);
}

/* a signal every few iterations, each handled before the loop goes on */
static void sig_churn(void) {
    long pid = sys6(NR_GETPID, 0, 0, 0, 0, 0, 0);
    usr_hits = usr_sent = usr_bad = usr_at = 0;
    action(SIGUSR1, on_usr);
    for (long i = 0; i < N; i++) {
        cur = i;
        if (i % 11 == 0) {
            usr_sent++;
            sys6(NR_KILL, pid, SIGUSR1, 0, 0, 0, 0);
        }
    }
    report(
        "sig-churn", usr_hits == usr_sent && usr_bad == 0 && usr_sent == 273
    );
}

/* a timer signal reaches a loop that makes no calls at all */
static void sig_async(void) {
    alarmed = 0;
    action(SIGALRM, on_alarm);
    long t[4] = {0, 0, 0, 5000};
    sys6(NR_SETITIMER, 0, (long) t, 0, 0, 0, 0);
    volatile long spin = 0;
    long i;
    for (i = 0; i < 150000000 && !alarmed; i++) spin += i;
    report("sig-async", alarmed == 1 && i < 150000000);
}

/* #endregion */

/* #region code generation */

/* mapped code, called in a loop, rewritten once through a protection flip */
static void code_flip(void) {
    unsigned char* code = (unsigned char*) CODE_AT;
    int (*fn)(void) = (int (*)(void))(uintptr_t) code;
    sys6(NR_MMAP, CODE_AT, 4096, 7, MAP_FIXED_ANON, -1, 0);
    put_code(code, 1);
    sync_code(code);
    long sum = 0;
    for (int i = 0; i < N; i++) {
        if (i == AT) {
            sys6(NR_MPROTECT, CODE_AT, 4096, 3, 0, 0, 0);
            put_code(code, 2);
            sys6(NR_MPROTECT, CODE_AT, 4096, 7, 0, 0, 0);
            sync_code(code);
        }
        sum += fn();
    }
    report("code-flip", sum == 8 * (AT * 1 + (N - AT) * 2));
}

/* the same, every few iterations, and each a different result */
static void code_churn(void) {
    unsigned char* code = (unsigned char*) CODE_AT;
    int (*fn)(void) = (int (*)(void))(uintptr_t) code;
    sys6(NR_MMAP, CODE_AT, 4096, 7, MAP_FIXED_ANON, -1, 0);
    put_code(code, 1);
    sync_code(code);
    long sum = 0, want = 0;
    int v = 1;
    for (int i = 0; i < N; i++) {
        if (i % 13 == 0) {
            v = v % 5 + 1;
            sys6(NR_MPROTECT, CODE_AT, 4096, 3, 0, 0, 0);
            put_code(code, v);
            sys6(NR_MPROTECT, CODE_AT, 4096, 7, 0, 0, 0);
            sync_code(code);
        }
        sum += fn();
        want += 8 * v;
    }
    report("code-churn", sum == want);
}

/* other code mapped over the old, every few iterations */
static void code_remap(void) {
    unsigned char* code = (unsigned char*) CODE_AT;
    int (*fn)(void) = (int (*)(void))(uintptr_t) code;
    long sum = 0, want = 0;
    int v = 1;
    sys6(NR_MMAP, CODE_AT, 4096, 7, MAP_FIXED_ANON, -1, 0);
    put_code(code, v);
    sync_code(code);
    for (int i = 0; i < N; i++) {
        if (i % 17 == 0) {
            v = v % 5 + 1;
            sys6(NR_MMAP, CODE_AT, 4096, 7, MAP_FIXED_ANON, -1, 0);
            put_code(code, v);
            sync_code(code);
        }
        sum += fn();
        want += 8 * v;
    }
    report("code-remap", sum == want);
}

/* the code that follows a syscall is rewritten just before it, and the syscall
 * changes code generation: what runs after it is the new code */
int smc_loop(unsigned long other);
static void code_smc(void) {
    unsigned long other = CODE_AT + 0x10000;
    sys6(NR_MMAP, (long) other, 4096, 7, MAP_FIXED_ANON, -1, 0);
    long want = 0;
    for (long c = 300; c > 0; c--) want += c / 25;
    report("code-smc", smc_loop(other) == (int) want);
}

/* #endregion */

/* #region descriptor identity */

#define FD 100

/* the descriptor a loop reads is replaced by another once */
static void fd_dup(void) {
    static char buf[2][N];
    int p[2][2];
    for (int k = 0; k < 2; k++) {
        sys6(NR_PIPE2, (long) p[k], 0, 0, 0, 0, 0);
        for (int i = 0; i < N; i++) buf[k][i] = (char) ('a' + k);
        sys6(NR_WRITE, p[k][1], (long) buf[k], N, 0, 0, 0);
    }
    sys6(NR_DUP3, p[0][0], FD, 0, 0, 0, 0);
    long as = 0, bs = 0;
    for (int i = 0; i < 2000; i++) {
        if (i == 1000) sys6(NR_DUP3, p[1][0], FD, 0, 0, 0, 0);
        char c = 0;
        sys6(NR_READ, FD, (long) &c, 1, 0, 0, 0);
        as += c == 'a', bs += c == 'b';
    }
    report("fd-dup", as == 1000 && bs == 1000);
}

/* every few iterations, each read from the one the descriptor names now */
static void fd_churn(void) {
    static char buf[2][N];
    int p[2][2];
    for (int k = 0; k < 2; k++) {
        sys6(NR_PIPE2, (long) p[k], 0, 0, 0, 0, 0);
        for (int i = 0; i < N; i++) buf[k][i] = (char) ('a' + k);
        sys6(NR_WRITE, p[k][1], (long) buf[k], N, 0, 0, 0);
    }
    int which = 0;
    sys6(NR_DUP3, p[0][0], FD, 0, 0, 0, 0);
    long bad = 0;
    for (int i = 0; i < 2000; i++) {
        if (i % 7 == 0) {
            which = !which;
            sys6(NR_DUP3, p[which][0], FD, 0, 0, 0, 0);
        }
        char c = 0;
        sys6(NR_READ, FD, (long) &c, 1, 0, 0, 0);
        bad += c != 'a' + which;
    }
    report("fd-churn", bad == 0);
}

/* #endregion */

void epochs_main(void) {
    map_remap();
    map_churn();
    map_protect();
    map_unmap();
    sig_install();
    sig_unmask();
    sig_churn();
    sig_async();
    code_flip();
    code_churn();
    code_remap();
    code_smc();
    fd_dup();
    fd_churn();
    sys6(NR_EXIT, 0, 0, 0, 0, 0, 0);
}
