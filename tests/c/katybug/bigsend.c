#include <stdint.h>

#if defined(__x86_64__)
    #define NR_READ 0
    #define NR_WRITE 1
    #define NR_CLOSE 3
    #define NR_SENDTO 44
    #define NR_SENDMSG 46
    #define NR_SOCKETPAIR 53
    #define NR_WAIT4 61
    #define NR_EXIT 60
    #define FORK() sys6(57, 0, 0, 0, 0, 0, 0)
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
        "bigsend_main\n hlt\n");
#elif defined(__aarch64__)
    #define NR_READ 63
    #define NR_WRITE 64
    #define NR_CLOSE 57
    #define NR_SENDTO 206
    #define NR_SENDMSG 211
    #define NR_SOCKETPAIR 199
    #define NR_WAIT4 260
    #define NR_EXIT 93
    #define FORK() sys6(220, 17, 0, 0, 0, 0, 0)
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
__asm__(".globl _start\n_start:\n bl bigsend_main\n");
#endif

/* one send of 17 MiB into a socket that a forked reader drains: more than 256
 * pieces of 64 KiB, so it takes more than one host call and all of it must go
 * out before the send returns */
#define N (17ul << 20)

static uint8_t buf[N];
static int failed;

static void say(const char* s) {
    long n = 0;
    while (s[n]) n++;
    sys6(NR_WRITE, 1, (long) s, n, 0, 0, 0);
}

static void report(const char* name, int ok) {
    say(name);
    say(ok ? " ok\n" : " FAIL\n");
    failed |= !ok;
}

static void run(const char* name, int msg) {
    int sv[2];
    if (sys6(NR_SOCKETPAIR, 1, 1, 0, (long) sv, 0, 0) < 0) {
        report(name, 0);
        return;
    }
    long pid = FORK();
    if (pid == 0) {
        sys6(NR_CLOSE, sv[0], 0, 0, 0, 0, 0);
        unsigned long got = 0;
        long r;
        while ((r = sys6(NR_READ, sv[1], (long) buf, N, 0, 0, 0)) > 0)
            got += (unsigned long) r;
        sys6(NR_EXIT, got != N, 0, 0, 0, 0, 0);
    }
    sys6(NR_CLOSE, sv[1], 0, 0, 0, 0, 0);
    for (unsigned long i = 0; i < N; i += 4096) buf[i] = (uint8_t) (i >> 12);
    long sent;
    if (msg) {
        struct {
            void* name;
            uint32_t namelen, pad;
            void* iov;
            uint64_t iovlen;
            void* ctl;
            uint64_t ctllen;
            uint32_t flags, pad2;
        } hdr = {0, 0, 0, 0, 0, 0, 0, 0, 0};
        struct {
            void* base;
            uint64_t len;
        } iov = {buf, N};
        hdr.iov = &iov;
        hdr.iovlen = 1;
        sent = sys6(NR_SENDMSG, sv[0], (long) &hdr, 0, 0, 0, 0);
    }
    else
        sent = sys6(NR_SENDTO, sv[0], (long) buf, N, 0, 0, 0);
    sys6(NR_CLOSE, sv[0], 0, 0, 0, 0, 0);
    int st = -1;
    sys6(NR_WAIT4, pid, (long) &st, 0, 0, 0, 0);
    report(name, sent == (long) N && st == 0);
}

void bigsend_main(void) {
    run("sendto", 0);
    run("sendmsg", 1);
    sys6(NR_EXIT, failed, 0, 0, 0, 0, 0);
    for (;;) {
    }
}
