#include <stdint.h>

#if defined(__x86_64__)
    #define NR_WRITE 1
    #define NR_CLOSE 3
    #define NR_GETDENTS 217
    #define NR_EXIT 60
    #define NR_FCNTL 72
    #define NR_GETRLIMIT 97
    #define NR_SETRLIMIT 160
    #define NR_DUP3 292
    #define O_DIR 0x10000
    #define OPEN(path, flags) sys6(2, (long) (path), (flags), 0)
    #define NR_FORK 57
    #define NR_WAIT4 61
static long sys4(long n, long a, long b, long c, long d) {
    long r;
    register long r10 __asm__("r10") = d;
    __asm__ volatile("syscall"
                     : "=a"(r)
                     : "a"(n), "D"(a), "S"(b), "d"(c), "r"(r10)
                     : "rcx", "r11", "memory");
    return r;
}
__asm__(".globl _start\n_start:\n xor %rbp, %rbp\n and $-16, %rsp\n call "
        "fds_main\n hlt\n");
#elif defined(__aarch64__)
    #define NR_WRITE 64
    #define NR_CLOSE 57
    #define NR_GETDENTS 61
    #define NR_EXIT 93
    #define NR_FCNTL 25
    #define NR_GETRLIMIT 163
    #define NR_SETRLIMIT 164
    #define NR_DUP3 24
    #define O_DIR 0x4000
    #define OPEN(path, flags) sys6(56, -100, (long) (path), (flags))
    #define NR_FORK 220
    #define NR_WAIT4 260
static long sys4(long n, long a, long b, long c, long d) {
    register long x0 __asm__("x0") = a;
    register long x1 __asm__("x1") = b;
    register long x2 __asm__("x2") = c;
    register long x3 __asm__("x3") = d;
    register long x8 __asm__("x8") = n;
    __asm__ volatile("svc 0"
                     : "+r"(x0)
                     : "r"(x1), "r"(x2), "r"(x3), "r"(x8)
                     : "memory");
    return x0;
}
__asm__(".globl _start\n_start:\n bl fds_main\n");
#endif

static long sys6(long n, long a, long b, long c) {
    return sys4(n, a, b, c, 0);
}

#define RLIMIT_NOFILE 7
#define F_DUPFD 0
#define F_GETFD 1
#define F_DUPFD_CLOEXEC 1030

/* descriptor numbers are the guest's own: the lowest free one comes back, and
 * katybug's copy of stderr and its directory handles take none of them */

static int failed;

static void say(const char* s) {
    long n = 0;
    while (s[n]) n++;
    sys6(NR_WRITE, 1, (long) s, n);
}

static void report(const char* name, int ok) {
    say(name);
    say(ok ? " ok\n" : " FAIL\n");
    failed |= !ok;
}

void fds_main(void) {
    static char buf[4096];
    long d = OPEN("/", O_DIR);
    long got = sys6(NR_GETDENTS, d, (long) buf, sizeof buf);
    long n = OPEN("/dev/null", 0);
    report("dents", d >= 3 && got > 0 && n == d + 1);
    sys6(NR_CLOSE, n, 0, 0);
    sys6(NR_CLOSE, d, 0, 0);
    long again = OPEN("/dev/null", 0);
    report("reuse", again == d);
    sys6(NR_CLOSE, again, 0, 0);
    sys6(NR_CLOSE, 2, 0, 0);
    long two = OPEN("/dev/null", 0);
    report("stderr", two == 2);
    sys6(NR_CLOSE, two, 0, 0);

    /* the range the guest may use ends below katybug's own descriptors,
     * whatever the host's limit is */
    unsigned long lim[2] = {0, 0};
    sys6(NR_GETRLIMIT, RLIMIT_NOFILE, (long) lim, 0);
    long top = (long) lim[0];
    report("limit", top > 8 && top <= 1000 && lim[1] <= 1000);

    long null = OPEN("/dev/null", 0);
    long past = OPEN("/dev/null", 0);
    long ends = lim[0] < 1100 ? (long) lim[0] : 1100;
    long stray = 0;
    report("close-1000", sys6(NR_CLOSE, 1000, 0, 0) == -9);
    for (long fd = 3; fd < ends + 4; fd++) {
        if (fd == null || fd == past) continue;
        stray += sys6(NR_CLOSE, fd, 0, 0) != -9 && fd >= top;
    }
    report("close-range", stray == 0);
    report("close-limit", sys6(NR_CLOSE, top, 0, 0) == -9);

    sys6(NR_CLOSE, past, 0, 0);
    report("dup-below", sys6(NR_DUP3, null, top - 1, 0) == top - 1);
    report("dup-limit", sys6(NR_DUP3, null, top, 0) == -9);
    report("dup-1000", sys6(NR_DUP3, null, 1000, 0) == -9);
    report("dup-from-limit", sys6(NR_DUP3, top, 5, 0) == -9);
    sys6(NR_CLOSE, top - 1, 0, 0);
    report("dupfd-below", sys6(NR_FCNTL, null, F_DUPFD, top - 1) == top - 1);
    report("dupfd-limit", sys6(NR_FCNTL, null, F_DUPFD, top) == -22);
    report("dupfd-1000", sys6(NR_FCNTL, null, F_DUPFD_CLOEXEC, 1000) == -22);
    report("fcntl-limit", sys6(NR_FCNTL, top, F_GETFD, 0) == -9);
    sys6(NR_CLOSE, top - 1, 0, 0);

    /* setrlimit is the guest's own view: it can lower it, not lift it, and
     * katybug's descriptors stay put */
    unsigned long low[2] = {16, lim[1]};
    unsigned long up[2] = {2000, 2000};
    report(
        "setrlimit-low", sys6(NR_SETRLIMIT, RLIMIT_NOFILE, (long) low, 0) == 0
    );
    unsigned long back[2] = {0, 0};
    sys6(NR_GETRLIMIT, RLIMIT_NOFILE, (long) back, 0);
    report("setrlimit-read", back[0] == 16 && back[1] == lim[1]);
    report(
        "setrlimit-up", sys6(NR_SETRLIMIT, RLIMIT_NOFILE, (long) up, 0) == -1
    );
    static char names[4096];
    long root = OPEN("/", O_DIR);
    report(
        "dents-after",
        root >= 3 && sys6(NR_GETDENTS, root, (long) names, sizeof names) > 0
    );
    sys6(NR_CLOSE, root, 0, 0);

    /* a forked child (katybug re-executed, under KATYBUG_FORK=exec) keeps the
     * same range and its own descriptors */
    long pid = sys4(NR_FORK, 17, 0, 0, 0);
    if (pid == 0) {
        unsigned long kid[2] = {0, 0};
        sys6(NR_GETRLIMIT, RLIMIT_NOFILE, (long) kid, 0);
        long dir = OPEN("/", O_DIR);
        long ok = kid[1] <= 1000 && sys6(NR_CLOSE, 1000, 0, 0) == -9 &&
                  sys6(NR_DUP3, dir, 1000, 0) == -9 &&
                  sys6(NR_GETDENTS, dir, (long) names, sizeof names) > 0;
        sys6(NR_EXIT, !ok, 0, 0);
    }
    int status = -1;
    sys4(NR_WAIT4, pid, (long) &status, 0, 0);
    report("fork-child", pid > 0 && status == 0);
    sys6(NR_EXIT, failed, 0, 0);
    for (;;) {
    }
}
