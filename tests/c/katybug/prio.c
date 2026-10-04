#include <stdint.h>

#if defined(__x86_64__)
    #define NR_WRITE 1
    #define NR_EXIT 60
    #define NR_GETEUID 107
    #define NR_GETPID 39
    #define NR_GETPRIORITY 140
    #define NR_SETPRIORITY 141
    #define NR_MKNODAT 259
    #define NR_UNLINKAT 263
    #define MKNOD(path, mode, dev)                                             \
        sysn(133, (long) (path), (mode), (dev), 0, 0, 0)
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
        "prio_main\n hlt\n");
#elif defined(__aarch64__)
    #define NR_WRITE 64
    #define NR_EXIT 93
    #define NR_GETEUID 175
    #define NR_GETPID 172
    #define NR_GETPRIORITY 141
    #define NR_SETPRIORITY 140
    #define NR_MKNODAT 33
    #define NR_UNLINKAT 35
    #define MKNOD(path, mode, dev)                                             \
        sysn(NR_MKNODAT, AT_FDCWD, (long) (path), (mode), (dev), 0, 0)
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
__asm__(".globl _start\n_start:\n bl prio_main\n");
#endif

#define AT_FDCWD (-100)
#define S_IFIFO 010000
#define S_IFCHR 020000
#define PRIO_PROCESS 0

#define ENOENT 2
#define ESRCH 3
#define EPERM 1
#define EACCES 13
#define EFAULT 14
#define EEXIST 17
#define EINVAL 22

static int failed;

static void say(const char* s) {
    long n = 0;
    while (s[n]) n++;
    sysn(NR_WRITE, 1, (long) s, n, 0, 0, 0);
}

static void report(const char* name, int ok) {
    say(name);
    say(ok ? " ok\n" : " FAIL\n");
    failed |= !ok;
}

static long mknodat(long dir, const char* path, long mode, long dev) {
    return sysn(NR_MKNODAT, dir, (long) path, mode, dev, 0, 0);
}

static void unlink(const char* path) {
    sysn(NR_UNLINKAT, AT_FDCWD, (long) path, 0, 0, 0, 0);
}

static long getprio(long which, long who) {
    return sysn(NR_GETPRIORITY, which, who, 0, 0, 0, 0);
}

static long setprio(long which, long who, long prio) {
    return sysn(NR_SETPRIORITY, which, who, prio, 0, 0, 0);
}

/* errors are -errno: what the kernel returns, the same on native Linux */
void prio_main(void) {
    static const char fifo[] = "/tmp/katybug-prio-fifo";
    static const char fifo2[] = "/tmp/katybug-prio-fifo2";
    long root = sysn(NR_GETEUID, 0, 0, 0, 0, 0, 0) == 0;
    unlink(fifo);
    unlink(fifo2);

    report("mknod", MKNOD(fifo, S_IFIFO | 0600, 0) == 0);
    report("mknod-exists", MKNOD(fifo, S_IFIFO | 0600, 0) == -EEXIST);
    report(
        "mknodat-exists", mknodat(AT_FDCWD, fifo, S_IFIFO | 0600, 0) == -EEXIST
    );
    report("mknodat", mknodat(AT_FDCWD, fifo2, S_IFIFO | 0600, 0) == 0);
    report(
        "mknod-missing-dir",
        MKNOD("/no-such-dir/f", S_IFIFO | 0600, 0) == -ENOENT
    );
    report("mknod-fault", MKNOD(0, S_IFIFO | 0600, 0) == -EFAULT);
    report("mknod-type", MKNOD("/tmp/katybug-prio-bad", 0170000, 0) == -EINVAL);
    /* a device node needs privilege; as root it is made, and removed */
    long dev = MKNOD("/tmp/katybug-prio-dev", S_IFCHR | 0600, 1 * 256 + 3);
    report("mknod-device", root ? dev == 0 : dev == -EPERM);
    unlink("/tmp/katybug-prio-dev");
    unlink(fifo);
    unlink(fifo2);

    /* the kernel's value is 20 - nice */
    long was = getprio(PRIO_PROCESS, 0);
    report("getpriority", was >= 1 && was <= 40);
    report("setpriority", setprio(PRIO_PROCESS, 0, 20 - was + 1) == 0);
    report("getpriority-raised", getprio(PRIO_PROCESS, 0) == was - 1);
    long lower = setprio(PRIO_PROCESS, 0, 20 - was);
    /* root without CAP_SYS_NICE (a container's) is refused too */
    report("setpriority-lower", lower == -EACCES || (root && lower == 0));
    report("getpriority-which", getprio(9, 0) == -EINVAL);
    report("setpriority-which", setprio(9, 0, 0) == -EINVAL);
    report("getpriority-missing", getprio(PRIO_PROCESS, 0x7ffffff0) == -ESRCH);
    report(
        "setpriority-missing", setprio(PRIO_PROCESS, 0x7ffffff0, 0) == -ESRCH
    );
    /* another user's process: init, unless this is init (a container's) */
    if (!root && sysn(NR_GETPID, 0, 0, 0, 0, 0, 0) != 1)
        report("setpriority-other", setprio(PRIO_PROCESS, 1, 5) == -EPERM);
    else
        say("setpriority-other ok\n");
    sysn(NR_EXIT, failed, 0, 0, 0, 0, 0);
    for (;;) {
    }
}
