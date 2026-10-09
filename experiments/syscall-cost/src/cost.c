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
#include <sys/wait.h>
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

static int made(const char* path, int mode, const char* text) {
    int fd = open(path, O_WRONLY | O_CREAT | O_TRUNC, mode);
    if (fd < 0 || write(fd, text, strlen(text)) < 0) return -1;
    return close(fd);
}

/* a child that returns from vfork, runs `what` and exits; the parent waits */
static long spawn(long n, const char* what) {
    char* argv[] = {(char*) what, NULL};
    char* envp[] = {NULL};
    long sink = 0;
    for (long i = 0; i < n; i++) {
        int st;
        pid_t pid = vfork();
        if (pid == 0) {
            if (what) execve(what, argv, envp);
            _exit(0);
        }
        sink += waitpid(pid, &st, 0) == pid;
    }
    return sink;
}

/* cost <n> spawn: the process-start calls, n/20 of each (a spawn is about 300
 * us) */
static int spawns(long n) {
    long m = n / 20 > 200 ? n / 20 : 200;
    char* envp[] = {NULL};
    char* argv[] = {"x", NULL};
    long sink = 0;
    if (made("/tmp/noexec", 0644, "x\n") || made("/tmp/junk", 0755, "junk\n"))
        return 1;

    mark("loop", m);
    for (long i = 0; i < m; i++) sink += i;
    mark("end", sink & 1);

    mark("execve-enoent", m);
    for (long i = 0; i < m; i++) sink += execve("/bin/nosuch", argv, envp);
    mark("end", sink & 1);

    mark("execve-eacces-file", m);
    for (long i = 0; i < m; i++) sink += execve("/tmp/noexec", argv, envp);
    mark("end", sink & 1);

    mark("execve-eacces-dir", m);
    for (long i = 0; i < m; i++) sink += execve("/bin", argv, envp);
    mark("end", sink & 1);

    mark("execve-enoexec", m);
    for (long i = 0; i < m; i++) sink += execve("/tmp/junk", argv, envp);
    mark("end", sink & 1);

    mark("vfork-exit", m);
    sink += spawn(m, NULL);
    mark("end", sink & 1);

    mark("vfork-exec-true", m);
    sink += spawn(m, "/bin/true");
    mark("end", sink & 1);

    printf("cost done\n");
    return 0;
}

int main(int argc, char** argv) {
    long n = argc > 1 ? atol(argv[1]) : 20000;
    if (argc > 2 && !strcmp(argv[2], "getdents")) return dirs(n);
    if (argc > 2 && !strcmp(argv[2], "spawn")) return spawns(n);
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

    mark("mmap-munmap", n);
    for (long i = 0; i < n; i++) {
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
