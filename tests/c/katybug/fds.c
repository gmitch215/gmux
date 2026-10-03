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
    #define NR_READ 0
    #define NR_FSTAT 5
    #define NR_LSEEK 8
    #define NR_MMAP 9
    #define NR_IOCTL 16
    #define NR_PREAD 17
    #define NR_PWRITE 18
    #define NR_READV 19
    #define NR_WRITEV 20
    #define NR_DUP 32
    #define NR_SOCKET 41
    #define NR_CONNECT 42
    #define NR_ACCEPT 43
    #define NR_BIND 49
    #define NR_LISTEN 50
    #define NR_GETSOCKNAME 51
    #define NR_SOCKETPAIR 53
    #define NR_ACCEPT4 288
    #define NR_PIPE2 293
    #define NR_EVENTFD 290
    #define NR_EPOLL 291
    #define NR_TIMERFD 283
    #define NR_INOTIFY 294
    #define POLL(fds, n) sys6(7, (long) (fds), (n), 0)
    #define SELECT(n, r) sysn(23, (n), (long) (r), 0, 0, 0, 0)
static long sysn(long n, long a, long b, long c, long d, long e, long f) {
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
    #define NR_READ 63
    #define NR_FSTAT 80
    #define NR_LSEEK 62
    #define NR_MMAP 222
    #define NR_IOCTL 29
    #define NR_PREAD 67
    #define NR_PWRITE 68
    #define NR_READV 65
    #define NR_WRITEV 66
    #define NR_DUP 23
    #define NR_SOCKET 198
    #define NR_CONNECT 203
    #define NR_ACCEPT 202
    #define NR_BIND 200
    #define NR_LISTEN 201
    #define NR_GETSOCKNAME 204
    #define NR_SOCKETPAIR 199
    #define NR_ACCEPT4 242
    #define NR_PIPE2 59
    #define NR_EVENTFD 19
    #define NR_EPOLL 20
    #define NR_TIMERFD 85
    #define NR_INOTIFY 26
    #define POLL(fds, n) sysn(73, (long) (fds), (n), (long) &zero_ts, 0, 0, 0)
    #define SELECT(n, r) sysn(72, (n), (long) (r), 0, 0, 0, 0)
static long zero_ts[2];
static long sysn(long n, long a, long b, long c, long d, long e, long f) {
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
__asm__(".globl _start\n_start:\n bl fds_main\n");
#endif

static long sys4(long n, long a, long b, long c, long d) {
    return sysn(n, a, b, c, d, 0, 0);
}

static long sys6(long n, long a, long b, long c) {
    return sysn(n, a, b, c, 0, 0, 0);
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

static long held[1100];
static long nheld;

/* opens until the table is full; the failure, with the highest number that
 * opened in *last */
static long fill(long* last) {
    long r;
    *last = -1;
    while ((r = OPEN("/dev/null", 0)) >= 0 && nheld < 1100) {
        held[nheld++] = r;
        if (r > *last) *last = r;
    }
    return r;
}

static void drain(void) {
    while (nheld) sys6(NR_CLOSE, held[--nheld], 0, 0);
}

/* implemented or not, a call that makes a descriptor makes none past the limit
 */
static int refused_or_missing(long r) {
    return r == -24 || r == -38;
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

    /* two connections wait on a listener, then the table fills: every call
     * that makes a descriptor is refused with EMFILE */
    unsigned char sa[16] = {2, 0, 0, 0, 127, 0, 0, 1};
    int salen = 16;
    long ls = sys6(NR_SOCKET, 2, 1, 0);
    sys6(NR_BIND, ls, (long) sa, 16);
    sys6(NR_LISTEN, ls, 4, 0);
    sys6(NR_GETSOCKNAME, ls, (long) sa, (long) &salen);
    long c1 = sys6(NR_SOCKET, 2, 1, 0);
    long c2 = sys6(NR_SOCKET, 2, 1, 0);
    sys6(NR_CONNECT, c1, (long) sa, 16);
    sys6(NR_CONNECT, c2, (long) sa, 16);
    long last;
    report("open-emfile", fill(&last) == -24 && last == top - 1);
    int pair[2];
    report("socket-emfile", sys6(NR_SOCKET, 2, 1, 0) == -24);
    report(
        "socketpair-emfile", sys4(NR_SOCKETPAIR, 1, 1, 0, (long) pair) == -24
    );
    report("pipe-emfile", sys6(NR_PIPE2, (long) pair, 0, 0) == -24);
    report("dup-emfile", sys6(NR_DUP, null, 0, 0) == -24);
    report("dupfd-emfile", sys6(NR_FCNTL, null, F_DUPFD, 3) == -24);
    report("accept-emfile", sys6(NR_ACCEPT, ls, 0, 0) == -24);
    report("accept4-emfile", sys4(NR_ACCEPT4, ls, 0, 0, 0) == -24);
    report("eventfd-emfile", refused_or_missing(sys6(NR_EVENTFD, 0, 0, 0)));
    report("epoll-emfile", refused_or_missing(sys6(NR_EPOLL, 0, 0, 0)));
    report("timerfd-emfile", refused_or_missing(sys6(NR_TIMERFD, 1, 0, 0)));
    report("inotify-emfile", refused_or_missing(sys6(NR_INOTIFY, 0, 0, 0)));
    drain();
    long after = sys6(NR_SOCKET, 2, 1, 0);
    report("socket-after", after > 2 && after < top);
    sys6(NR_CLOSE, after, 0, 0);

    /* a descriptor at or past the base is not the guest's: read, write and the
     * rest answer EBADF instead of reaching katybug's log */
    static long iov[2];
    static long st[32];
    static unsigned long ones[16];
    iov[0] = (long) buf;
    iov[1] = 16;
    ones[1000 / 64] = 1ul << (1000 % 64);
    int pfd[2] = {1000, 1};
    report("ebadf-read", sys6(NR_READ, 1000, (long) buf, 16) == -9);
    report("ebadf-write", sys6(NR_WRITE, 1000, (long) buf, 16) == -9);
    report("ebadf-pread", sys4(NR_PREAD, 1000, (long) buf, 16, 0) == -9);
    report("ebadf-pwrite", sys4(NR_PWRITE, 1000, (long) buf, 16, 0) == -9);
    report("ebadf-readv", sys6(NR_READV, 1000, (long) iov, 1) == -9);
    report("ebadf-writev", sys6(NR_WRITEV, 1000, (long) iov, 1) == -9);
    report("ebadf-fstat", sys6(NR_FSTAT, 1000, (long) st, 0) == -9);
    report("ebadf-ioctl", sys6(NR_IOCTL, 1000, 0x5413, (long) buf) == -9);
    report("ebadf-lseek", sys6(NR_LSEEK, 1000, 0, 0) == -9);
    report("ebadf-mmap", sysn(NR_MMAP, 0, 4096, 1, 2, 1000, 0) == -9);
    report(
        "ebadf-poll", POLL(pfd, 1) == 1 && ((unsigned short*) pfd)[3] == 0x20
    );
    report("ebadf-select", SELECT(1001, ones) == -9);

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
    report("limit-open", fill(&last) == -24 && last == 15);
    drain();
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
        long kidlast;
        long ok = kid[0] == 16 && fill(&kidlast) == -24 && kidlast == 15;
        drain();
        ok = ok && kid[1] <= 1000 && sys6(NR_CLOSE, 1000, 0, 0) == -9 &&
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
