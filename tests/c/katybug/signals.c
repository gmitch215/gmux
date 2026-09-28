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
    #define NR_READ 0
    #define NR_PIPE2 293
    #define NR_SETITIMER 38
    #define NR_MPROTECT 10
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
/* mov eax, v; ret */
static void put_ret(unsigned char* p, int v) {
    p[0] = 0xb8, p[1] = (unsigned char) v, p[2] = p[3] = p[4] = 0, p[5] = 0xc3;
}
    /* cmp 3 with 5, then a signal to this process: CF SF, not PF ZF OF */
    #define FRAME_FLAGS(uc) (*(long*) ((char*) (uc) + MC + 17 * 8) & 0x8c5)
    #define FRAME_WANT 0x81
static void cmp_then_signal(long pid, int s) {
    long r;
    __asm__ volatile("mov $3, %%ebx\n cmp $5, %%rbx\n syscall"
                     : "=a"(r)
                     : "a"(NR_KILL), "D"(pid), "S"((long) s)
                     : "rbx", "rcx", "r11", "memory", "cc");
}
static void sync_code(void* p) {
    (void) p;
}
/* xmm8 in the fxsave area the frame's fpregs points at */
static long* vec_slot(void* uc) {
    char* fp = *(char**) ((char*) uc + MC + 23 * 8);
    return fp ? (long*) (fp + 160 + 16 * 8) : 0;
}
static void vec_clobber(void) {
    __asm__ volatile("pxor %%xmm8, %%xmm8" ::: "memory");
}
/* v in xmm8 across a signal to this process */
__attribute__((noinline)) static long vec_across(long v, long pid, int s) {
    long r;
    __asm__ volatile("movq %[v], %%xmm8\n syscall\n movq %%xmm8, %[v]"
                     : [v] "+r"(v), "=a"(r)
                     : "a"(NR_KILL), "D"(pid), "S"((long) s)
                     : "rcx", "r11", "memory");
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
    #define NR_READ 63
    #define NR_PIPE2 59
    #define NR_SETITIMER 103
    #define NR_MPROTECT 226
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
/* cmp 3 with 5, then a signal to this process: N, not Z C V */
    #define FRAME_FLAGS(uc)                                                    \
        (*(unsigned long*) ((char*) (uc) + MC + 8 + 8 * 33) & 0xf0000000ul)
    #define FRAME_WANT 0x80000000ul
static void cmp_then_signal(long pid, int s) {
    register long x0 __asm__("x0") = pid;
    register long x1 __asm__("x1") = s;
    register long x8 __asm__("x8") = NR_KILL;
    __asm__ volatile("mov x9, #3\n cmp x9, #5\n svc 0"
                     : "+r"(x0)
                     : "r"(x1), "r"(x8)
                     : "x9", "memory", "cc");
}
/* mov w0, #v; ret */
static void put_ret(unsigned char* p, int v) {
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
/* v16 in the fpsimd_context record at the start of __reserved (after pstate) */
static long* vec_slot(void* uc) {
    char* rec = (char*) uc + MC + 288;
    return *(unsigned*) rec == 0x46508001 ? (long*) (rec + 16 + 16 * 16) : 0;
}
static void vec_clobber(void) {
    __asm__ volatile(".arch_extension fp\n.arch_extension simd\nmovi d16, #0" ::
                         : "memory");
}
/* v in v16 across a signal to this process */
__attribute__((noinline)) static long vec_across(long v, long pid, int s) {
    register long x0 __asm__("x0") = pid;
    register long x1 __asm__("x1") = s;
    register long x2 __asm__("x2") = v;
    register long x8 __asm__("x8") = NR_KILL;
    __asm__ volatile(".arch_extension fp\n.arch_extension simd\n"
                     "fmov d16, x2\n svc 0\n fmov x2, d16"
                     : "+r"(x2), "+r"(x0)
                     : "r"(x1), "r"(x8)
                     : "memory");
    return x2;
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
#define SA_RESTART 0x10000000
#define SIGALRM 14
#define SIGUSR1 10
#define SIGSEGV 11
#define SIGUSR2 12
#define SIGPIPE 13
#define SIGTERM 15
#define MAP_FIXED_ANON 0x32 /* MAP_PRIVATE | MAP_FIXED | MAP_ANONYMOUS */
#define MAP_ANON 0x22

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

/* the frame's flags are the compare's */
static volatile long frame_flags_ok = -1;
static void on_flags(int s, void* info, void* uc) {
    (void) s;
    (void) info;
    frame_flags_ok = FRAME_FLAGS(uc) == FRAME_WANT;
}

/* the frame holds the interrupted vector register, and sigreturn loads the
 * frame's copy back; the live register is clobbered here */
static volatile long vec_saved;
static void on_vec(int s, void* info, void* uc) {
    (void) s;
    (void) info;
    long* slot = vec_slot(uc);
    vec_saved = slot ? *slot : -1;
    if (slot) *slot += 1;
    vec_clobber();
}

static void action_flags(int s, void (*h)(int, void*, void*), unsigned long f) {
    struct ksigaction a = {h, SA_SIGINFO | SA_RESTORER | f, restore_rt, 0};
    sys(NR_SIGACTION, s, (long) &a, 0, 8);
}

static void action(int s, void (*h)(int, void*, void*)) {
    action_flags(s, h, 0);
}

/* a handler that runs while read blocks, and feeds it */
static int alarm_pipe[2];
static volatile int alarms;
static void on_alarm(int s, void* info, void* uc) {
    (void) s;
    (void) info;
    (void) uc;
    alarms++;
    sys(NR_WRITE, alarm_pipe[1], (long) "x", 1, 0);
}

/* a blocking read across SIGALRM in 50 ms: its return value */
static long read_across_alarm(unsigned long flags) {
    action_flags(SIGALRM, on_alarm, flags);
    sys(NR_PIPE2, (long) alarm_pipe, 0, 0, 0);
    long t[4] = {0, 0, 0, 50000};
    sys(NR_SETITIMER, 0, (long) t, 0, 0);
    char c;
    return sys(NR_READ, alarm_pipe[0], (long) &c, 1, 0);
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

    /* mappings freed out of order give their slots back */
    long cycled = 0;
    for (int i = 0; i < 3000; i++) {
        long a = sys6(NR_MMAP, 0, 65536, 3, MAP_ANON, -1, 0);
        long b = sys6(NR_MMAP, 0, 65536, 3, MAP_ANON, -1, 0);
        if (a < 0 || b < 0) break;
        *(long*) a = i;
        sys(NR_MUNMAP, a, 65536, 0, 0);
        sys(NR_MUNMAP, b, 65536, 0, 0);
        cycled++;
    }
    line("cycled", cycled);

    /* a hole punched in, and a page protected, in the middle of one mapping */
    long* three = (long*) sys6(NR_MMAP, 0, 3 * 4096, 3, MAP_ANON, -1, 0);
    three[0] = 1, three[512] = 2, three[1024] = 3;
    sys(NR_MUNMAP, (long) (three + 512), 4096, 0, 0);
    line("sides kept", faulting_load(three) + faulting_load(three + 1024));
    line("middle gone", faulting_load(three + 512));
    sys6(NR_MMAP, (long) (three + 512), 4096, 3, MAP_FIXED_ANON, -1, 0);
    three[512] = 5;
    sys(NR_MPROTECT, (long) (three + 512), 4096, 0, 0);
    line("protected", faulting_load(three + 512));
    sys(NR_MPROTECT, (long) (three + 512), 4096, 1, 0);
    line("readable again", faulting_load(three + 512));
    line("segv", segv);

    /* code run, unmapped, and other code mapped in its place runs as itself */
    unsigned char* code = (unsigned char*) 0x7e0000200000;
    int (*fn)(void) = (int (*)(void))(uintptr_t) code;
    sys6(NR_MMAP, (long) code, 4096, 7, MAP_FIXED_ANON, -1, 0);
    put_ret(code, 42);
    sync_code(code);
    long first = fn();
    sys(NR_MUNMAP, (long) code, 4096, 0, 0);
    sys6(NR_MMAP, (long) code, 4096, 7, MAP_FIXED_ANON, -1, 0);
    put_ret(code, 7);
    sync_code(code);
    line("code", first);
    line("code remapped", fn());

    action(SIGUSR1, on_flags);
    cmp_then_signal(pid, SIGUSR1);
    line("flags in frame", frame_flags_ok);

    action(SIGUSR1, on_vec);
    long vec = vec_across(0x12345678, pid, SIGUSR1);
    line("vector saved", vec_saved == 0x12345678);
    line("vector restored", vec == 0x12345679);

    /* SA_RESTART re-runs the read after the handler; without it read fails
     * with EINTR (-4) */
    line("read restarted", read_across_alarm(SA_RESTART));
    line("read interrupted", read_across_alarm(0));
    line("alarms", alarms);

    sys(NR_WRITE, 1, (long) out, used, 0);
    sys(NR_KILL, pid, SIGTERM, 0, 0);
    sys(NR_EXIT, 1, 0, 0, 0);
}
