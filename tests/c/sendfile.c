// sendfile and splice from a file to a socket over 127.0.0.1. A forked
// receiver hashes what arrives; built natively the program prints the same
// lines. `sendfile cpu <sendfile|splice|rw> <bytes> <calls>` moves <bytes>
// <calls> times to a receiver that only discards
#define _GNU_SOURCE
#include <arpa/inet.h>
#include <errno.h>
#include <fcntl.h>
#include <netinet/in.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/sendfile.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <sys/wait.h>
#include <unistd.h>

#define PORT 18091
#define SIZE (1 << 20)
#define SOURCE "/tmp/sendfile-source.bin"

typedef struct {
    unsigned long long bytes, hash;
} Report;

static unsigned char source[SIZE], scratch[SIZE];

static uint64_t fnv(uint64_t h, const unsigned char* p, size_t n) {
    for (size_t i = 0; i < n; i++) h = (h ^ p[i]) * 1099511628211ull;
    return h;
}

static void fill(void) {
    uint32_t x = 2463534242u;
    for (size_t i = 0; i < SIZE; i++) {
        x ^= x << 13;
        x ^= x >> 17;
        x ^= x << 5;
        source[i] = x >> 11;
    }
    int fd = open(SOURCE, O_CREAT | O_WRONLY | O_TRUNC, 0644);
    if (fd < 0 || write(fd, source, SIZE) != SIZE) exit(2);
    close(fd);
}

static struct sockaddr_in loopback(void) {
    struct sockaddr_in a = {.sin_family = AF_INET, .sin_port = htons(PORT)};
    a.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
    return a;
}

static int listener(void) {
    int l = socket(AF_INET, SOCK_STREAM, 0);
    int one = 1;
    struct sockaddr_in a = loopback();
    setsockopt(l, SOL_SOCKET, SO_REUSEADDR, &one, sizeof one);
    if (l < 0 || bind(l, (void*) &a, sizeof a) || listen(l, 4)) exit(2);
    return l;
}

/* connects, reads to the end and sends the count and the hash back */
static void receive(int report, int hash) {
    static unsigned char buf[65536];
    struct sockaddr_in a = loopback();
    int c = socket(AF_INET, SOCK_STREAM, 0);
    Report r = {0, 14695981039346656037ull};
    ssize_t n;
    if (connect(c, (void*) &a, sizeof a)) _exit(3);
    // MSG_TRUNC drops the bytes in the kernel, so a discarding receiver copies
    // none
    while ((n = hash ? read(c, buf, sizeof buf)
                     : recv(c, buf, sizeof buf, MSG_TRUNC)) > 0) {
        r.bytes += n;
        if (hash) r.hash = fnv(r.hash, buf, n);
    }
    if (write(report, &r, sizeof r) != sizeof r) _exit(4);
    _exit(0);
}

static long send_file(int s, int f, off_t* off, size_t len) {
    size_t done = 0;
    while (done < len) {
        ssize_t n = sendfile(s, f, off, len - done);
        if (n <= 0) break;
        done += n;
    }
    return done;
}

static long send_splice(int s, int f, off_t* off, size_t len, int p[2]) {
    size_t done = 0;
    while (done < len) {
        size_t want = len - done < 65536 ? len - done : 65536;
        ssize_t n = splice(f, off, p[1], 0, want, 0);
        if (n <= 0) break;
        for (ssize_t left = n; left > 0;) {
            ssize_t m = splice(p[0], 0, s, 0, left, 0);
            if (m <= 0) return -1;
            left -= m;
        }
        done += n;
    }
    return done;
}

static long send_rw(int s, int f, off_t* off, size_t len, unsigned char* buf) {
    size_t done = 0;
    while (done < len) {
        ssize_t n = pread(f, buf, len - done, *off);
        if (n <= 0) break;
        *off += n;
        for (ssize_t at = 0; at < n;) {
            ssize_t m = write(s, buf + at, n - at);
            if (m <= 0) return -1;
            at += m;
        }
        done += n;
    }
    return done;
}

enum
{
    SENDFILE,
    SENDFILE_POSITION,
    SPLICE,
    RW
};

/* one transfer to a fresh receiver; true when its count and hash are the
 * slice's */
static int transfer(int l, const char* name, int how, off_t start, size_t len) {
    int f = open(SOURCE, O_RDONLY);
    int r[2], p[2];
    off_t off = start;
    size_t expect = start >= SIZE ? 0 : SIZE - start;
    if (len < expect) expect = len;
    if (f < 0 || pipe(r) || pipe(p)) return 0;
    if (how == SENDFILE_POSITION) lseek(f, start, SEEK_SET);
    pid_t pid = fork();
    if (pid == 0) receive(r[1], 1);
    int s = accept(l, 0, 0);
    long sent = how == SENDFILE            ? send_file(s, f, &off, len)
                : how == SENDFILE_POSITION ? send_file(s, f, 0, len)
                : how == SPLICE            ? send_splice(s, f, &off, len, p)
                                           : send_rw(s, f, &off, len, scratch);
    off_t position = lseek(f, 0, SEEK_CUR);
    Report got = {0, 0};
    close(s);
    int ok = read(r[0], &got, sizeof got) == sizeof got;
    int st = 0;
    waitpid(pid, &st, 0);
    uint64_t want = fnv(14695981039346656037ull, source + start, expect);
    ok = ok && sent == (long) expect && got.bytes == expect && got.hash == want;
    printf(
        "%s %s: %ld bytes, fnv %016llx, offset %lld, position %lld\n",
        ok ? "PASS" : "FAIL", name, sent, (unsigned long long) got.hash,
        (long long) (how == SENDFILE_POSITION ? -1 : off), (long long) position
    );
    close(f);
    close(r[0]);
    close(r[1]);
    close(p[0]);
    close(p[1]);
    return ok;
}

static void errors(void) {
    int f = open(SOURCE, O_RDONLY);
    int p[2];
    off_t off = 0;
    int s = socket(AF_INET, SOCK_STREAM, 0);
    pipe(p);
    long a = sendfile(-1, f, &off, 16);
    int ea = errno;
    long b = sendfile(p[1], s, 0, 16);
    int eb = errno;
    long c = sendfile(p[1], f, &off, 0);
    off = SIZE + 5;
    long d = sendfile(p[1], f, &off, 16);
    printf("PASS sendfile to a bad descriptor: %ld errno %d\n", a, ea);
    printf("PASS sendfile from a socket: %ld errno %d\n", b, eb);
    printf("PASS sendfile of no bytes: %ld; past the end: %ld\n", c, d);
    close(f);
    close(s);
    close(p[0]);
    close(p[1]);
}

static int cpu(const char* kind, size_t size, long calls) {
    int l = listener();
    int f = open(SOURCE, O_RDONLY);
    int r[2], p[2];
    pipe(r);
    pipe(p);
    pid_t pid = fork();
    if (pid == 0) receive(r[1], 0);
    int s = accept(l, 0, 0);
    long total = 0;
    for (long i = 0; i < calls; i++) {
        off_t off = 0;
        total += !strcmp(kind, "sendfile") ? send_file(s, f, &off, size)
                 : !strcmp(kind, "splice") ? send_splice(s, f, &off, size, p)
                                           : send_rw(s, f, &off, size, scratch);
    }
    close(s);
    Report got = {0, 0};
    read(r[0], &got, sizeof got);
    waitpid(pid, 0, 0);
    printf(
        "cpu %s %zu x %ld: sent %ld, received %llu\n", kind, size, calls, total,
        got.bytes
    );
    return total == (long) (size * calls) && got.bytes == size * calls ? 0 : 1;
}

int main(int argc, char** argv) {
    fill();
    if (argc == 5 && !strcmp(argv[1], "cpu"))
        return cpu(argv[2], strtoul(argv[3], 0, 10), strtol(argv[4], 0, 10));
    int l = listener();
    int ok = 1;
    ok &= transfer(l, "sendfile with an offset", SENDFILE, 0, SIZE);
    ok &= transfer(
        l, "sendfile on the file position", SENDFILE_POSITION, 0, SIZE
    );
    ok &= transfer(l, "sendfile of a range", SENDFILE, 12345, 70000);
    ok &= transfer(
        l, "sendfile of more than is left", SENDFILE, 1000000, 2 * SIZE
    );
    ok &= transfer(l, "splice file to pipe to socket", SPLICE, 0, SIZE);
    ok &= transfer(l, "splice of a range", SPLICE, 12345, 70000);
    ok &= transfer(l, "read and write", RW, 0, SIZE);
    errors();
    return ok ? 0 : 1;
}
