// the calls a host-native or vDSO path would serve, each in a loop between two
// markers the host times (experiments/syscall-cost/scripts/cost.ts); the
// machine's own clock is charged per syscall, so it cannot time them
#include <dirent.h>
#include <fcntl.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/mman.h>
#include <sys/stat.h>
#include <sys/syscall.h>
#include <time.h>
#include <unistd.h>

static void mark(const char* what, long n) {
    printf("mark %s %ld\n", what, n);
    fflush(stdout);
}

/* cost <n> getdents: only the directory loop, for a profile of it */
static int dirs(long n) {
    long sink = 0;
    for (long i = 0; i < n; i++) {
        DIR* d = opendir("/bin");
        while (readdir(d)) sink++;
        closedir(d);
    }
    printf("cost done %ld\n", sink);
    return 0;
}

int main(int argc, char** argv) {
    long n = argc > 1 ? atol(argv[1]) : 20000;
    if (argc > 2 && !strcmp(argv[2], "getdents")) return dirs(n);
    static char buf[65536];
    long sink = 0;
    struct stat st;
    struct timespec ts;

    mark("loop", n);
    for (long i = 0; i < n; i++) sink += i;
    mark("end", sink & 1);

    mark("getpid", n);
    for (long i = 0; i < n; i++) sink += syscall(SYS_getpid);
    mark("end", sink & 1);

    mark("clock_gettime", n);
    for (long i = 0; i < n; i++) sink += clock_gettime(CLOCK_MONOTONIC, &ts);
    mark("end", sink & 1);

    mark("stat", n);
    for (long i = 0; i < n; i++) sink += stat("/bin/busybox", &st);
    mark("end", sink & 1);

    mark("open-read-close", n);
    for (long i = 0; i < n; i++) {
        int fd = open("/init", O_RDONLY);
        sink += read(fd, buf, 4096);
        close(fd);
    }
    mark("end", sink & 1);

    // capped: freed vmas wait for an rcu grace period, and ~100000 of them
    // outrun the 58 MiB machine
    long maps = n < 20000 ? n : 20000;
    mark("mmap-munmap", maps);
    for (long i = 0; i < maps; i++) {
        void* p = mmap(
            0, 65536, PROT_READ | PROT_WRITE, MAP_PRIVATE | MAP_ANONYMOUS, -1, 0
        );
        sink += munmap(p, 65536);
    }
    mark("end", sink & 1);

    int zero = open("/dev/zero", O_RDONLY);
    mark("read-64k", n / 10);
    for (long i = 0; i < n / 10; i++) sink += read(zero, buf, sizeof buf);
    mark("end", sink & 1);

    int null = open("/dev/null", O_WRONLY);
    mark("write-64k", n / 10);
    for (long i = 0; i < n / 10; i++) sink += write(null, buf, sizeof buf);
    mark("end", sink & 1);

    mark("getdents", n / 10);
    for (long i = 0; i < n / 10; i++) {
        DIR* d = opendir("/bin");
        while (readdir(d)) sink++;
        closedir(d);
    }
    mark("end", sink & 1);
    printf("cost done\n");
    return 0;
}
