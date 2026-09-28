#include <arpa/inet.h>
#include <dirent.h>
#include <errno.h>
#include <fcntl.h>
#include <netdb.h>
#include <netinet/in.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <unistd.h>
#define CHECK(name, ok) printf("%s %s\n", (ok) ? "PASS" : "FAIL", name)

/* guest root against the authorities outside the machine (SECURITY.md): the
 * host plants values only it holds (tests/c/run.ts); root can read all of the
 * machine's memory, so none of them may be in it */
extern char** environ;

/* the strings looked for are kept shifted by one and compared a byte at a
 * time, so no copy of them is ever in memory for the scan to find */
static int at(const volatile char* p, const char* rot) {
    for (; *rot; rot++, p++)
        if (*p != (char) (*rot - 1)) return 0;
    return 1;
}

/* matches in [1, bytes) of the linear memory */
static int scan(const char* rot, size_t bytes, int show) {
    /* from address 1: address 0 is null to the compiler */
    const volatile char* m = (const volatile char*) (uintptr_t) 1;
    size_t n = strlen(rot);
    int hits = 0;
    for (size_t a = 0; a + 1 + n <= bytes; a++)
        if (at(m + a, rot)) {
            if (show) {
                printf("found at %p:", (const void*) (m + a));
                for (size_t k = 0; k < n + 24 && a + 1 + k < bytes; k++) {
                    char c = m[a + k];
                    putchar(c >= 32 && c < 127 ? c : '.');
                }
                putchar('\n');
            }
            hits++;
        }
    return hits;
}

static int has(const char* path, const char* rot) {
    static char buf[65536];
    int fd = open(path, O_RDONLY);
    if (fd < 0) return 0;
    ssize_t n = read(fd, buf, sizeof buf - 1);
    close(fd);
    for (ssize_t i = 0; i + (ssize_t) strlen(rot) <= n; i++)
        if (at(buf + i, rot)) return 1;
    return 0;
}

static int refused(int family, const char* addr, int port, int* err) {
    int s = socket(family, SOCK_STREAM, 0);
    if (s < 0) return *err = errno, 1;
    int r;
    if (family == AF_INET) {
        struct sockaddr_in in = {
            .sin_family = AF_INET, .sin_port = htons(port)
        };
        inet_pton(AF_INET, addr, &in.sin_addr);
        r = connect(s, (struct sockaddr*) &in, sizeof in);
    }
    else {
        struct sockaddr_in6 in = {
            .sin6_family = AF_INET6, .sin6_port = htons(port)
        };
        inet_pton(AF_INET6, addr, &in.sin6_addr);
        r = connect(s, (struct sockaddr*) &in, sizeof in);
    }
    *err = errno;
    close(s);
    return r < 0;
}

int main(void) {
    /* rootfstype=ramfs and GMUX-HOST-ONLY */
    const char *cmdline = "sppugtuzqf>sbngt", *needle = "HNVY.IPTU.POMZ";
    CHECK("runs as root", geteuid() == 0);

    /* memory: the kernel's command line is found, so the scan reaches the
     * kernel; the host's values are not */
    size_t bytes = __builtin_wasm_memory_size(0) * 65536;
    int control = scan(cmdline, bytes, 0);
    int hits = scan(needle, bytes, 1);
    printf(
        "memory %zu bytes: kernel command line %d times, host-only values %d "
        "times\n",
        bytes, control, hits
    );
    CHECK("reads the kernel's memory", control > 0);
    CHECK(
        "finds no host-only value in the machine's memory",
        control > 0 && hits == 0
    );

    /* the environment is the guest's own */
    int env = 0;
    for (char** e = environ; *e; e++)
        for (const char* c = *e; *c; c++) env += at(c, needle);
    CHECK(
        "no host-only value in its environment or init's",
        !env && !has("/proc/1/environ", needle) &&
            !has("/proc/self/environ", needle)
    );

    /* no device reaches memory, storage or a network outside */
    struct stat st;
    CHECK(
        "no /dev/mem, /dev/kmem or /dev/port", stat("/dev/mem", &st) &&
                                                   stat("/dev/kmem", &st) &&
                                                   stat("/dev/port", &st)
    );
    CHECK("no /dev/net/tun", stat("/dev/net/tun", &st) != 0);
    int blocks = 0;
    DIR* d = opendir("/sys/class/block");
    for (struct dirent* e; d && (e = readdir(d));)
        blocks += e->d_name[0] != '.';
    if (d) closedir(d);
    CHECK("no block device", blocks == 0);
    /* loopback (772) and IP tunnels over it (768, 769, 776, 778, 823) only */
    int foreign = 0, devices = 0;
    d = opendir("/sys/class/net");
    for (struct dirent* e; d && (e = readdir(d));) {
        if (e->d_name[0] == '.') continue;
        char path[300], t[16] = {0};
        snprintf(path, sizeof path, "/sys/class/net/%s/type", e->d_name);
        int fd = open(path, O_RDONLY);
        if (fd >= 0) read(fd, t, sizeof t - 1), close(fd);
        int type = atoi(t);
        devices++;
        if (type != 772 && type != 768 && type != 769 && type != 776 &&
            type != 778 && type != 823) {
            printf("device %s type %d\n", e->d_name, type);
            foreign++;
        }
    }
    if (d) closedir(d);
    printf("network devices %d, with a link out %d\n", devices, foreign);
    CHECK(
        "no network device with a link out of the machine",
        devices > 0 && !foreign
    );

    /* the Cloudflare API, by address and by name */
    int e4, e6;
    int r4 = refused(AF_INET, "104.16.132.229", 443, &e4);
    int r6 = refused(AF_INET6, "2606:4700::6810:84e5", 443, &e6);
    printf(
        "connect api.cloudflare.com v4: %s, v6: %s\n", strerror(e4),
        strerror(e6)
    );
    CHECK("no connection to the Cloudflare API", r4 && r6);
    struct addrinfo* ai = 0;
    int g = getaddrinfo("api.cloudflare.com", "443", 0, &ai);
    if (!g) freeaddrinfo(ai);
    printf(
        "resolve api.cloudflare.com: %s\n", g ? gai_strerror(g) : "resolved"
    );
    CHECK("no name resolution out of the machine", g != 0);
    return 0;
}
