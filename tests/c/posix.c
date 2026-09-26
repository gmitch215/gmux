#define _GNU_SOURCE
#include <arpa/inet.h>
#include <errno.h>
#include <fcntl.h>
#include <netinet/in.h>
#include <signal.h>
#include <stdio.h>
#include <string.h>
#include <sys/epoll.h>
#include <sys/eventfd.h>
#include <sys/file.h>
#include <sys/inotify.h>
#include <sys/mman.h>
#include <sys/signalfd.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <sys/syscall.h>
#include <sys/timerfd.h>
#include <unistd.h>
#define CHECK(name, ok) printf("%s %s\n", (ok) ? "PASS" : "FAIL", name)
#ifndef SYS_mlock2
    #define SYS_mlock2 284
#endif

/* the syscalls the kernel does not build, each for its reason in
 * TECHNICAL_REPORT.md */
static const int refused[] = {
    18,  42,  60,  89,  104, 105, 106, 217, 218, 219, 224, 225, 226,
    235, 236, 237, 238, 239, 241, 262, 263, 270, 271, 273, 277, 280,
    282, 288, 289, 290, 293, 294, 425, 426, 427, 440, 443, 444, 445,
    446, 450, 451, 453, 459, 460, 461, 462, 471, 234,
};

/* the memory calls a machine without an MMU answers (kernel patch 0019), and
 * mmap's file modes */
static void memory(void) {
    long pg = sysconf(_SC_PAGESIZE);
    int f = open("/tmp/mapped", O_CREAT | O_RDWR | O_TRUNC, 0644);
    char buf[8] = {0};
    ftruncate(f, pg);
    pwrite(f, "file", 4, 0);
    char* s = mmap(0, pg, PROT_READ | PROT_WRITE, MAP_SHARED, f, 0);
    int ok = s != MAP_FAILED;
    if (ok) memcpy(s, "shrd", 4);
    CHECK(
        "mmap shared file, msync", ok && msync(s, pg, MS_SYNC) == 0 &&
                                       pread(f, buf, 4, 0) == 4 &&
                                       !memcmp(buf, "shrd", 4)
    );
    char* p = mmap(0, pg, PROT_READ | PROT_WRITE, MAP_PRIVATE, f, 0);
    ok = p != MAP_FAILED;
    if (ok) memcpy(p, "priv", 4);
    CHECK(
        "mmap private file keeps its writes", ok && pread(f, buf, 4, 0) == 4 &&
                                                  !memcmp(buf, "shrd", 4) &&
                                                  !memcmp(p, "priv", 4)
    );
    CHECK(
        "madvise DONTNEED reads a private file range again",
        ok && madvise(p, pg, MADV_DONTNEED) == 0 && !memcmp(p, "shrd", 4)
    );
    char* a = mmap(
        0, 2 * pg, PROT_READ | PROT_WRITE, MAP_PRIVATE | MAP_ANONYMOUS, -1, 0
    );
    unsigned char vec[2] = {0};
    ok = a != MAP_FAILED;
    if (ok) memset(a, 7, 2 * pg);
    CHECK(
        "madvise DONTNEED zeroes anonymous memory",
        ok && madvise(a, pg, MADV_DONTNEED) == 0 && a[0] == 0 &&
            a[pg - 1] == 0 && a[pg] == 7
    );
    CHECK(
        "madvise FREE and advice", ok && madvise(a, pg, MADV_FREE) == 0 &&
                                       madvise(a, pg, MADV_WILLNEED) == 0 &&
                                       madvise(s, pg, MADV_FREE) < 0 &&
                                       errno == EINVAL
    );
    a[0] = 1;
    CHECK("mincore", ok && mincore(a, 2 * pg, vec) == 0 && vec[0] && vec[1]);
    CHECK(
        "mlock, munlock, mlock2", ok && mlock(a + 1, 10) == 0 &&
                                      munlock(a, pg) == 0 &&
                                      syscall(SYS_mlock2, a, pg, 1) == 0
    );
    CHECK(
        "mlockall, munlockall", mlockall(MCL_CURRENT) == 0 &&
                                    munlockall() == 0 &&
                                    mlockall(MCL_ONFAULT) < 0 && errno == EINVAL
    );
    CHECK(
        "memory calls refuse an unmapped range",
        ok && munmap(a, 2 * pg) == 0 && mlock(a, pg) < 0 && errno == ENOMEM &&
            mincore(a, pg, vec) < 0 && errno == ENOMEM
    );
    int m = memfd_create("probe", 0);
    memset(buf, 0, sizeof buf);
    CHECK(
        "memfd_create", m >= 0 && write(m, "memfd", 5) == 5 &&
                            pread(m, buf, 5, 0) == 5 && !memcmp(buf, "memfd", 5)
    );
}

/* locks, nonblocking I/O, half-close, signalfd */
static void io(void) {
    int f1 = open("/tmp/locked", O_CREAT | O_RDWR, 0644);
    int f2 = open("/tmp/locked", O_RDWR);
    struct flock l = {.l_type = F_WRLCK, .l_whence = SEEK_SET, .l_len = 10};
    int held = fcntl(f1, F_SETLK, &l) == 0;
    struct flock o = {.l_type = F_WRLCK, .l_whence = SEEK_SET, .l_len = 10};
    CHECK(
        "fcntl record lock against an OFD lock",
        held && fcntl(f2, F_OFD_SETLK, &o) < 0 && errno == EAGAIN
    );
    int p[2];
    char c[4];
    pipe2(p, O_NONBLOCK);
    CHECK(
        "nonblocking pipe", read(p[0], c, 1) < 0 && errno == EAGAIN &&
                                write(p[1], "n", 1) == 1 &&
                                read(p[0], c, 1) == 1
    );
    int sv[2];
    socketpair(AF_UNIX, SOCK_STREAM, 0, sv);
    memset(c, 0, sizeof c);
    CHECK(
        "half-close", shutdown(sv[0], SHUT_WR) == 0 && read(sv[1], c, 4) == 0 &&
                          write(sv[1], "bck", 3) == 3 &&
                          read(sv[0], c, 3) == 3 && !strcmp(c, "bck")
    );
    sigset_t set;
    sigemptyset(&set);
    sigaddset(&set, SIGUSR1);
    sigprocmask(SIG_BLOCK, &set, 0);
    int sfd = signalfd(-1, &set, 0);
    struct signalfd_siginfo si = {0};
    raise(SIGUSR1);
    CHECK(
        "signalfd", sfd >= 0 && read(sfd, &si, sizeof si) == sizeof si &&
                        si.ssi_signo == SIGUSR1
    );
    char names[256] = "";
    for (unsigned i = 0; i < sizeof refused / sizeof *refused; i++)
        if (syscall(refused[i], 0, 0, 0, 0, 0, 0) != -1 || errno != ENOSYS)
            snprintf(
                names + strlen(names), sizeof names - strlen(names), " %d",
                refused[i]
            );
    CHECK("refused syscalls return ENOSYS", !names[0]);
    if (names[0]) printf("answered:%s\n", names);
}

int main(void) {
    int sv[2];
    char b[16] = {0};
    CHECK(
        "socketpair", socketpair(AF_UNIX, SOCK_STREAM, 0, sv) == 0 &&
                          write(sv[0], "hi", 2) == 2 &&
                          read(sv[1], b, 2) == 2 && !strcmp(b, "hi")
    );
    int l = socket(AF_INET, SOCK_STREAM, 0);
    struct sockaddr_in a = {
        .sin_family = AF_INET,
        .sin_port = htons(8080),
        .sin_addr.s_addr = htonl(INADDR_LOOPBACK)
    };
    int ok = l >= 0 && bind(l, (void*) &a, sizeof a) == 0 && listen(l, 4) == 0;
    int c = socket(AF_INET, SOCK_STREAM, 0);
    ok = ok && connect(c, (void*) &a, sizeof a) == 0;
    int s = ok ? accept(l, 0, 0) : -1;
    memset(b, 0, sizeof b);
    CHECK(
        "tcp loopback", ok && s >= 0 && write(c, "tcp", 3) == 3 &&
                            read(s, b, 3) == 3 && !strcmp(b, "tcp")
    );
    int f = open("/lua-tests/lock", O_CREAT | O_RDWR, 0644);
    CHECK("flock", f >= 0 && flock(f, LOCK_EX) == 0 && flock(f, LOCK_UN) == 0);
    int e = eventfd(0, 0);
    unsigned long long v = 5, w = 0;
    CHECK(
        "eventfd",
        e >= 0 && write(e, &v, 8) == 8 && read(e, &w, 8) == 8 && w == 5
    );
    int p[2];
    pipe(p);
    int ep = epoll_create1(0);
    struct epoll_event ev = {.events = EPOLLIN, .data.fd = p[0]}, out;
    epoll_ctl(ep, EPOLL_CTL_ADD, p[0], &ev);
    write(p[1], "x", 1);
    CHECK(
        "epoll",
        ep >= 0 && epoll_wait(ep, &out, 1, 1000) == 1 && out.data.fd == p[0]
    );
    int t = timerfd_create(CLOCK_MONOTONIC, 0);
    struct itimerspec its = {.it_value = {0, 20000000}};
    unsigned long long n = 0;
    CHECK(
        "timerfd", t >= 0 && timerfd_settime(t, 0, &its, 0) == 0 &&
                       read(t, &n, 8) == 8 && n == 1
    );
    int in = inotify_init1(0);
    CHECK(
        "inotify",
        in >= 0 && inotify_add_watch(in, "/lua-tests", IN_CREATE) >= 0
    );
    struct stat st;
    int nul = open("/dev/null", O_WRONLY);
    CHECK(
        "/dev/null", nul >= 0 && write(nul, "x", 1) == 1 &&
                         stat("/dev/null", &st) == 0 && S_ISCHR(st.st_mode) &&
                         st.st_size == 0
    );
    char z[4] = {1, 1, 1, 1};
    int zero = open("/dev/zero", O_RDONLY);
    CHECK(
        "/dev/zero",
        zero >= 0 && read(zero, z, 4) == 4 && !z[0] && !z[1] && !z[2] && !z[3]
    );
    /* the tcp pair half-closed: end of file one way, data the other */
    memset(b, 0, sizeof b);
    int nb = fcntl(l, F_SETFL, O_NONBLOCK) == 0 && accept(l, 0, 0) < 0 &&
             errno == EAGAIN;
    CHECK(
        "tcp nonblocking accept, half-close",
        nb && shutdown(c, SHUT_WR) == 0 && read(s, b, 3) == 0 &&
            write(s, "ok", 2) == 2 && read(c, b, 2) == 2 && !strcmp(b, "ok")
    );
    memory();
    io();
    return 0;
}
