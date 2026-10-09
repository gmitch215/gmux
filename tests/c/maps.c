// a nommu mremap shrink or grow keeps the mapping tree's range in step with the
// VMA (/proc/self/maps lists the tree), and 100,000 mmap/munmap pairs do not
// pile up slab memory behind RCU grace periods
#define _GNU_SOURCE
#include <errno.h>
#include <fcntl.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/mman.h>
#include <unistd.h>
#define CHECK(name, ok) printf("%s %s\n", (ok) ? "PASS" : "FAIL", name)
#define PAIRS 100000
#define SLAB_BOUND_KB 16384
#define PAGE 4096

static char text[65536];

// whether a line of /proc/self/maps overlaps [lo, hi); the file is read from
// the start with read (on nommu its position is an address, so never pread)
static int listed(unsigned long lo, unsigned long hi, unsigned long* end) {
    int fd = open("/proc/self/maps", O_RDONLY);
    size_t used = 0;
    ssize_t n;
    while (used < sizeof text - 1 &&
           (n = read(fd, text + used, sizeof text - 1 - used)) > 0)
        used += n;
    close(fd);
    text[used] = 0;
    for (char* line = text; line && *line;
         line = strchr(line, '\n') ? strchr(line, '\n') + 1 : 0) {
        unsigned long a, b;
        if (sscanf(line, "%lx-%lx", &a, &b) == 2 && a < hi && b > lo) {
            if (end) *end = b;
            return 1;
        }
    }
    return 0;
}

static long slab_kb(void) {
    char line[128];
    long kb = -1;
    FILE* f = fopen("/proc/meminfo", "r");
    while (f && fgets(line, sizeof line, f))
        if (sscanf(line, "Slab: %ld", &kb) == 1) break;
    if (f) fclose(f);
    return kb;
}

static char* anon(size_t len) {
    return mmap(
        0, len, PROT_READ | PROT_WRITE, MAP_PRIVATE | MAP_ANONYMOUS, -1, 0
    );
}

int main(void) {
    unsigned long end = 0;
    char* r = anon(4 * PAGE);
    CHECK(
        "an anonymous mapping is listed",
        r != MAP_FAILED &&
            listed((unsigned long) r, (unsigned long) r + 1, &end)
    );

    CHECK("mremap shrinks it", mremap(r, 4 * PAGE, 2 * PAGE, 0) == r);
    end = 0;
    listed((unsigned long) r, (unsigned long) r + 1, &end);
    CHECK(
        "the listed end follows the shrink", end == (unsigned long) r + 2 * PAGE
    );
    CHECK("the shrunk length unmaps", munmap(r, 2 * PAGE) == 0);
    CHECK(
        "no range of the old mapping is listed",
        !listed((unsigned long) r, (unsigned long) r + 4 * PAGE, 0)
    );
    errno = 0;
    CHECK(
        "unmapping the shrunk length again is EINVAL",
        munmap(r, 2 * PAGE) == -1 && errno == EINVAL
    );
    errno = 0;
    CHECK(
        "unmapping the old tail is EINVAL",
        munmap(r + 2 * PAGE, 2 * PAGE) == -1 && errno == EINVAL
    );

    char* g = anon(4 * PAGE);
    CHECK(
        "shrink then grow back returns the same address",
        mremap(g, 4 * PAGE, 2 * PAGE, 0) == g &&
            mremap(g, 2 * PAGE, 4 * PAGE, 0) == g
    );
    end = 0;
    listed((unsigned long) g, (unsigned long) g + 1, &end);
    CHECK(
        "the listed end follows the growth", end == (unsigned long) g + 4 * PAGE
    );
    CHECK("the grown mapping unmaps whole", munmap(g, 4 * PAGE) == 0);
    CHECK(
        "the grown mapping is gone",
        !listed((unsigned long) g, (unsigned long) g + 4 * PAGE, 0)
    );

    long before = slab_kb();
    long sink = 0, failed = 0, peak = 0;
    for (int i = 1; i <= PAIRS; i++) {
        void* p = anon(16 * PAGE);
        if (p == MAP_FAILED) failed++;
        sink += munmap(p, 16 * PAGE);
        if (i % 1000 == 0) {
            long grown = slab_kb() - before;
            if (grown > peak) peak = grown;
        }
    }
    printf(
        "slab grew by at most %ld kB over %d pairs (bound %d kB), %ld mmap "
        "failures\n",
        peak, PAIRS, SLAB_BOUND_KB, failed
    );
    CHECK(
        "100000 mmap/munmap pairs keep slab growth under the bound",
        sink == 0 && failed == 0 && peak < SLAB_BOUND_KB
    );
    return 0;
}
