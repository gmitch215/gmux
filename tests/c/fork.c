// fork in a program built with resumable frames (tests/c/run.ts builds it with
// experiments/evacuation/scripts/evacuate.ts --resume). The child gets a
// copy of the parent's memory and the parent's frames, which resume in both
#include <arpa/inet.h>
#include <errno.h>
#include <fcntl.h>
#include <netinet/in.h>
#include <stdio.h>
#include <string.h>
#include <sys/mman.h>
#include <sys/mount.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <sys/syscall.h>
#include <sys/uio.h>
#include <sys/wait.h>
#include <unistd.h>
#define CHECK(name, ok) printf("%s %s\n", (ok) ? "PASS" : "FAIL", name)

static int counter = 1;
static pid_t deep_child;

/* forks at the bottom; each frame adds its own local on the way back */
static int deep(int n) {
    int here = n * 3;
    if (n == 0) {
        pid_t p = fork();
        if (p > 0) deep_child = p;
        return p == 0 ? 1000 : 0;
    }
    return deep(n - 1) + here;
}

static int status_of(pid_t p) {
    int st = -1;
    waitpid(p, &st, 0);
    return WIFEXITED(st) ? WEXITSTATUS(st)
                         : 128 + (WIFSIGNALED(st) ? WTERMSIG(st) : 0);
}

/* accepts three connections, each served by a forked child that echoes a line
 * upper-cased */
static int serve(int listener) {
    for (int i = 0; i < 3; i++) {
        int c = accept(listener, 0, 0);
        if (c < 0) return 1;
        pid_t p = fork();
        if (p == 0) {
            char line[64] = {0};
            ssize_t n = read(c, line, sizeof line - 1);
            for (ssize_t j = 0; j < n; j++)
                if (line[j] >= 'a' && line[j] <= 'z') line[j] -= 32;
            write(c, line, n);
            _exit(0);
        }
        close(c);
        if (p < 0 || status_of(p) != 0) return 2;
    }
    return 0;
}

enum
{
    HELD = 4000,
    CYCLES = 150
};

static char* map_file(const char* stem, int i) {
    char path[48];
    snprintf(path, sizeof path, "/tmp/%s-%d", stem, i);
    int fd = open(path, O_CREAT | O_RDWR | O_TRUNC, 0666);
    char* p = MAP_FAILED;
    if (fd >= 0 && !ftruncate(fd, 4096))
        p = mmap(0, 4096, PROT_READ | PROT_WRITE, MAP_SHARED, fd, 0);
    if (fd >= 0) close(fd);
    return p;
}

/* `fork hold`: maps 4,000 files shared, says so, and waits for stdin to close,
 * which leaves the machine about a hundred region ids */
static int hold(void) {
    for (int i = 0; i < HELD; i++)
        if (map_file("fork-held", i) == MAP_FAILED) return 2;
    write(1, "r", 1);
    char c;
    while (read(0, &c, 1) > 0);
    return 0;
}

/* a shared mapping's region id is free again once its holders have dropped it,
 * even when a fork child holds a copy of the mapping longer than the parent:
 * more cycles than ids left would run out */
static int ids_after_fork(void) {
    int up[2], down[2];
    if (pipe(up) || pipe(down)) return 0;
    pid_t holder = fork();
    if (holder == 0) {
        close(down[1]);
        close(up[0]);
        dup2(down[0], 0);
        dup2(up[1], 1);
        execl("/bin/fork", "fork", "hold", (char*) 0);
        _exit(127);
    }
    char c = 0;
    int ok = read(up[0], &c, 1) == 1;
    for (int i = 0; ok && i < CYCLES; i++) {
        char* p = map_file("fork-spare", i);
        int gate[2];
        ok = p != MAP_FAILED && !pipe(gate);
        if (!ok) break;
        pid_t child = fork();
        if (child == 0) {
            close(gate[1]);
            char b;
            while (read(gate[0], &b, 1) > 0);
            _exit(0);
        }
        munmap(p, 4096);
        close(gate[1]);
        close(gate[0]);
        ok = status_of(child) == 0;
    }
    close(down[1]);
    ok = status_of(holder) == 0 && ok;
    return ok;
}

/* a fork child's memory is its own: it starts with the parent's bytes of a
 * shared mapping and its stores to it stay with it */
static int shared_across_fork(void) {
    volatile char* p = mmap(
        0, 4096, PROT_READ | PROT_WRITE, MAP_SHARED | MAP_ANONYMOUS, -1, 0
    );
    if (p == MAP_FAILED) return 0;
    p[0] = 'p';
    pid_t child = fork();
    if (child == 0) {
        int saw = p[0] == 'p';
        p[0] = 'c';
        _exit(saw && p[0] == 'c' ? 0 : 1);
    }
    int ok = child > 0 && status_of(child) == 0 && p[0] == 'p';
    munmap((char*) p, 4096);
    return ok;
}

#ifdef __wasm__
static unsigned long memory_end(void) {
    return (unsigned long) __builtin_wasm_memory_size(0) * 65536;
}
#else
/* the first byte past a mapping that ends a run of unmapped pages */
static unsigned long memory_end(void) {
    char* p = mmap(
        0, 8192, PROT_READ | PROT_WRITE, MAP_PRIVATE | MAP_ANONYMOUS, -1, 0
    );
    munmap(p + 4096, 4096);
    return (unsigned long) p + 4096;
}
#endif

static long raw_sendmsg(int fd, struct msghdr* m) {
    return syscall(SYS_sendmsg, fd, m, 0);
}

/* -1 with errno, or the count */
#define ERRNO_IS(call, want) ((call) == -1 && errno == (want))

/* what a fork child's syscalls do with a buffer that ends at the end of its
 * memory, which Linux refuses at the page after a mapping: EFAULT for a
 * string, an iovec array, an iovec entry or a control buffer that runs out.
 * `fork native` runs the same checks on a Linux host. */
static void refusals(void) {
    char* end = (char*) memory_end();
    struct stat st;
    char odd[32] = {0};
    strcpy(odd + 1, "/tmp/../tmp");
    CHECK("a path at an odd address is read", stat(odd + 1, &st) == 0);

    memset(end - 16, 'x', 15);
    end[-1] = 0;
    CHECK(
        "a path whose NUL is the last byte is read",
        ERRNO_IS(stat(end - 16, &st), ENOENT)
    );
    end[-1] = 'x';
    CHECK(
        "a path with no NUL before the end is EFAULT",
        ERRNO_IS(stat(end - 16, &st), EFAULT)
    );

    static char longpath[6000];
    memset(longpath, 'a', sizeof longpath - 1);
    CHECK(
        "a path of 5999 bytes is ENAMETOOLONG",
        ERRNO_IS(stat(longpath, &st), ENAMETOOLONG)
    );
    CHECK(
        "a string argument with no NUL before the end is EFAULT",
        ERRNO_IS(mount(0, "/", end - 16, 0, 0), EFAULT)
    );
    CHECK(
        "a string argument of 5999 bytes is EINVAL",
        ERRNO_IS(mount(0, "/", longpath, 0, 0), EINVAL)
    );
    char* argv[] = {"busybox", end - 16, 0};
    CHECK(
        "an exec argument with no NUL before the end is EFAULT",
        ERRNO_IS(execv("/bin/busybox", argv), EFAULT)
    );

    int fds[2];
    if (pipe(fds)) return;
    fcntl(fds[0], F_SETFL, O_NONBLOCK);
    fcntl(fds[1], F_SETFL, O_NONBLOCK);
    struct iovec two[2] = {{"abcd", 4}, {end, 4}};
    CHECK(
        "writev with a later entry outside is EFAULT",
        ERRNO_IS(writev(fds[1], two, 2), EFAULT)
    );
    struct iovec bad = {end, 4};
    CHECK(
        "writev of an entry outside is EFAULT",
        ERRNO_IS(writev(fds[1], &bad, 1), EFAULT)
    );
    char sink[8];
    read(fds[0], sink, sizeof sink);
    write(fds[1], "wxyz", 4);
    CHECK(
        "readv into an entry outside is EFAULT",
        ERRNO_IS(readv(fds[0], &bad, 1), EFAULT)
    );

    struct iovec* array = (struct iovec*) (end - sizeof(struct iovec));
    array[0].iov_base = sink;
    array[0].iov_len = (size_t) -1;
    CHECK(
        "a negative length before the end of the array is EINVAL, not EFAULT",
        ERRNO_IS(writev(fds[1], array, 2), EINVAL)
    );
    CHECK(
        "an iovec array past the end is EFAULT",
        ERRNO_IS(writev(fds[1], (void*) end, 1), EFAULT)
    );

    int sv[2];
    socketpair(AF_UNIX, SOCK_DGRAM, 0, sv);
    struct iovec one = {"data", 4};
    char control[16] __attribute__((aligned(8))) = {0};
    struct msghdr m = {.msg_iov = &one, .msg_iovlen = 1};
    CHECK(
        "sendmsg of a datagram returns its length", raw_sendmsg(sv[0], &m) == 4
    );
    m.msg_control = control;
    m.msg_controllen = 4;
    CHECK(
        "sendmsg with a control buffer shorter than a header passes",
        raw_sendmsg(sv[0], &m) == 4
    );
    m.msg_controllen = 0x80000000u;
    CHECK(
        "sendmsg with a control length over INT_MAX is ENOBUFS",
        ERRNO_IS(raw_sendmsg(sv[0], &m), ENOBUFS)
    );
    m.msg_controllen = sizeof control;
    ((struct cmsghdr*) control)->cmsg_len = 4;
    CHECK(
        "sendmsg with a control header shorter than itself is EINVAL",
        ERRNO_IS(raw_sendmsg(sv[0], &m), EINVAL)
    );
    m.msg_control = end;
    CHECK(
        "sendmsg with a control buffer outside is EFAULT",
        ERRNO_IS(raw_sendmsg(sv[0], &m), EFAULT)
    );
    m.msg_control = 0;
    m.msg_controllen = 0;
    m.msg_iovlen = 1025;
    CHECK(
        "sendmsg with 1025 iovec entries is EMSGSIZE",
        ERRNO_IS(raw_sendmsg(sv[0], &m), EMSGSIZE)
    );
    m.msg_iovlen = 1;
    m.msg_iov = (void*) end;
    CHECK(
        "sendmsg with its iovec outside is EFAULT",
        ERRNO_IS(raw_sendmsg(sv[0], &m), EFAULT)
    );
    fflush(stdout);
}

/* the refusals above, in a fork child */
static int refusals_in_child(void) {
    fflush(stdout);
    pid_t p = fork();
    if (p == 0) {
        refusals();
        _exit(0);
    }
    return p > 0 && status_of(p) == 0;
}

int main(int argc, char** argv) {
    if (argc == 2 && !strcmp(argv[1], "hold")) return hold();
#ifndef __wasm__
    if (argc == 2 && !strcmp(argv[1], "native")) {
        refusals();
        return 0;
    }
#endif
    int local = 10;
    pid_t p = fork();
    if (p < 0) {
        printf("FAIL fork: %s\n", strerror(errno));
        return 1;
    }
    if (p == 0) {
        counter = 2;
        local = 20;
        _exit(counter + local);
    }
    CHECK(
        "fork child has its own copy",
        status_of(p) == 22 && counter == 1 && local == 10
    );

    int fds[2];
    pipe(fds);
    p = fork();
    if (p == 0) {
        close(fds[0]);
        write(fds[1], "from the child", 15);
        _exit(0);
    }
    close(fds[1]);
    char buf[32] = {0};
    read(fds[0], buf, sizeof buf);
    CHECK("fork pipe", status_of(p) == 0 && !strcmp(buf, "from the child"));

    int v = deep(40);
    if (v > 3000) _exit(v == 1000 + 2460 ? 55 : 1);
    CHECK(
        "fork deep in the stack, frames resumed in both",
        v == 2460 && status_of(deep_child) == 55
    );

    p = fork();
    if (p == 0) {
        execl("/bin/busybox", "echo", "exec from a fork child", (char*) 0);
        _exit(127);
    }
    CHECK("fork then exec", status_of(p) == 0);

    int listener = socket(AF_INET, SOCK_STREAM, 0);
    struct sockaddr_in a = {
        .sin_family = AF_INET,
        .sin_port = htons(18090),
        .sin_addr.s_addr = htonl(INADDR_LOOPBACK)
    };
    int one = 1;
    setsockopt(listener, SOL_SOCKET, SO_REUSEADDR, &one, sizeof one);
    if (bind(listener, (void*) &a, sizeof a) || listen(listener, 4)) {
        printf("FAIL listen: %s\n", strerror(errno));
        return 1;
    }
    pid_t server = fork();
    if (server == 0) _exit(serve(listener));
    close(listener);
    int echoed = 0;
    const char* words[] = {"one", "two", "three"};
    const char* upper[] = {"ONE", "TWO", "THREE"};
    for (int i = 0; i < 3; i++) {
        int c = socket(AF_INET, SOCK_STREAM, 0);
        char reply[16] = {0};
        if (connect(c, (void*) &a, sizeof a) == 0 &&
            write(c, words[i], strlen(words[i])) > 0 &&
            read(c, reply, sizeof reply - 1) > 0 && !strcmp(reply, upper[i]))
            echoed++;
        close(c);
    }
    CHECK("forking server", echoed == 3 && status_of(server) == 0);
    CHECK(
        "a region id is free again after a fork child outlives the mapping's "
        "holder",
        ids_after_fork()
    );
    CHECK(
        "a fork child's stores to a shared mapping stay in its own memory",
        shared_across_fork()
    );
    if (!refusals_in_child()) printf("FAIL refusals did not finish\n");
    return 0;
}
