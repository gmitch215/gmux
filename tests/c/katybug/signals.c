#include <stdint.h>

#if defined(__x86_64__)
    #define NR_WRITE 1
    #define NR_SIGACTION 13
    #define NR_SIGPROCMASK 14
    #define NR_GETPID 39
    #define NR_KILL 62
    #define NR_GETTID 186
    #define NR_TGKILL 234
    #define NR_EXIT 60
    #define NR_MMAP 9
    #define NR_MUNMAP 11
    #define MC 40
    #define MC_FAULTREG (MC + 12 * 8) /* rdx in the kernel's sigcontext */
static long sys6(long n, long a, long b, long c, long d, long e, long f) {
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
        "sig_main\n hlt\n"
        ".globl restore_rt\nrestore_rt:\n mov $15, %eax\n syscall\n");
__attribute__((noinline)) static long faulting_load(const long* p) {
    long v;
    __asm__ volatile("mov (%%rdx), %%rax" : "=a"(v) : "d"(p) : "memory");
    return v;
}
#elif defined(__aarch64__)
    #define NR_WRITE 64
    #define NR_SIGACTION 134
    #define NR_SIGPROCMASK 135
    #define NR_GETPID 172
    #define NR_KILL 129
    #define NR_GETTID 178
    #define NR_TGKILL 131
    #define NR_EXIT 93
    #define NR_MMAP 222
    #define NR_MUNMAP 215
    #define MC 176
    #define MC_FAULTREG                                                        \
        (MC + 8 + 1 * 8) /* x1: after fault_address, regs[1]                   \
                          */
static long sys6(long n, long a, long b, long c, long d, long e, long f) {
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
__asm__(".globl _start\n_start:\n bl sig_main\n"
        ".globl restore_rt\nrestore_rt:\n mov x8, #139\n svc 0\n");
__attribute__((noinline)) static long faulting_load(const long* p) {
    register const long* x1 __asm__("x1") = p;
    register long x0 __asm__("x0");
    __asm__ volatile("ldr x0, [x1]" : "=r"(x0) : "r"(x1) : "memory");
    return x0;
}
#endif
#define sys(n, a, b, c, d) sys6(n, a, b, c, d, 0, 0)

void restore_rt(void);

struct ksigaction {
    void (*handler)(int, void*, void*);
    unsigned long flags;
    void (*restorer)(void);
    unsigned long mask;
};

#define SA_SIGINFO 4
#define SA_RESTORER 0x04000000
#define SIGUSR1 10
#define SIGSEGV 11
#define SIGUSR2 12
#define SIGPIPE 13
#define SIGTERM 15
#define MAP_FIXED_ANON 0x32 /* MAP_PRIVATE | MAP_FIXED | MAP_ANONYMOUS */

static char out[1024];
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
static void line(const char* k, long v) {
    put(k);
    put(" ");
    num(v);
    put("\n");
}

static volatile int usr1, usr2, segv, usr1_signo, usr1_code;
static long good = 42;

static void on_usr1(int s, void* info, void* uc) {
    (void) uc;
    usr1++;
    usr1_signo = s == ((int*) info)[0] ? s : -1;
    usr1_code = ((int*) info)[2];
}

static void on_usr2(int s, void* info, void* uc) {
    (void) s;
    (void) info;
    (void) uc;
    usr2++;
}

static void on_segv(int s, void* info, void* uc) {
    (void) s;
    (void) info;
    segv++;
    *(long*) ((char*) uc + MC_FAULTREG) = (long) &good;
}

static void action(int s, void (*h)(int, void*, void*)) {
    struct ksigaction a = {h, SA_SIGINFO | SA_RESTORER, restore_rt, 0};
    sys(NR_SIGACTION, s, (long) &a, 0, 8);
}

void sig_main(void) {
    /* exec keeps an ignored signal ignored: 1 (SIG_IGN) when started so */
    struct ksigaction inherited;
    sys(NR_SIGACTION, SIGPIPE, 0, (long) &inherited, 8);
    line("pipe at start", (long) inherited.handler);

    long pid = sys(NR_GETPID, 0, 0, 0, 0);
    action(SIGUSR1, on_usr1);
    sys(NR_KILL, pid, SIGUSR1, 0, 0);
    line("usr1", usr1);
    line("usr1 signo", usr1_signo);
    line("usr1 code", usr1_code);

    action(SIGUSR2, on_usr2);
    unsigned long set = 1ul << (SIGUSR2 - 1);
    sys(NR_SIGPROCMASK, 0, (long) &set, 0, 8);
    sys(NR_TGKILL, pid, sys(NR_GETTID, 0, 0, 0, 0), SIGUSR2, 0);
    line("usr2 while blocked", usr2);
    sys(NR_SIGPROCMASK, 1, (long) &set, 0, 8);
    line("usr2 after unblock", usr2);

    action(SIGSEGV, on_segv);
    long v = faulting_load((const long*) 16);
    line("segv", segv);
    line("load after repair", v);

    /* one load site across its page's changes: a fresh mapping over it, then
     * none */
    long* at = (long*) 0x7e0000000000;
    sys6(NR_MMAP, (long) at, 4096, 3, MAP_FIXED_ANON, -1, 0);
    *at = 7;
    long mapped = faulting_load(at);
    sys6(NR_MMAP, (long) at, 4096, 3, MAP_FIXED_ANON, -1, 0);
    long remapped = faulting_load(at);
    sys(NR_MUNMAP, (long) at, 4096, 0, 0);
    long unmapped = faulting_load(at);
    line("mapped", mapped);
    line("remapped", remapped);
    line("unmapped", unmapped);
    line("segv", segv);

    sys(NR_WRITE, 1, (long) out, used, 0);
    sys(NR_KILL, pid, SIGTERM, 0, 0);
    sys(NR_EXIT, 1, 0, 0, 0);
}
