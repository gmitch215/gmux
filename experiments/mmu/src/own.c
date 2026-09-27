// the same work in the machine's shared memory and in a process's own memory:
// `own fork` runs the phases, then forks and runs them again in the child (a
// fork child gets its own memory); `own drop <path> [args]` runs <path> as uid
// 1000 (its guarded build); `own phases` runs them once. Each phase is
// bracketed by @@<who><phase>a@@ and @@<who><phase>b@@ for the host to time
#include <fcntl.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <sys/wait.h>
#include <unistd.h>

static const char* who = "p";
static volatile uint64_t sink;

static void mark(const char* phase, char end) {
    printf("@@%s%s%c@@\n", who, phase, end);
    fflush(stdout);
}

static int compare(const void* a, const void* b) {
    int x = *(const int*) a, y = *(const int*) b;
    return (x > y) - (x < y);
}

static void phases(void) {
    enum
    {
        WORDS = 1 << 21,
        NODES = 1 << 18,
        BYTES = 1 << 20,
        INTS = 300000
    };
    uint32_t* a = malloc(WORDS * sizeof *a);
    mark("stream", 'a');
    for (int i = 0; i < WORDS; i++) a[i] = i;
    for (int r = 0; r < 40; r++)
        for (int i = 0; i < WORDS; i++) a[i] = a[i] * 3 + 1;
    sink = a[WORDS / 2];
    mark("stream", 'b');
    free(a);

    uint32_t* next = malloc(NODES * sizeof *next);
    mark("chase", 'a');
    for (uint32_t i = 0; i < NODES; i++) next[i] = i;
    uint64_t seed = 88172645463325252ull;
    for (uint32_t i = NODES - 1; i > 0; i--) {
        seed ^= seed << 13, seed ^= seed >> 7, seed ^= seed << 17;
        uint32_t j = seed % (i + 1), t = next[i];
        next[i] = next[j], next[j] = t;
    }
    uint32_t at = 0;
    for (int r = 0; r < 96 * NODES; r++) at = next[at];
    sink = at;
    mark("chase", 'b');
    free(next);

    unsigned char* buf = malloc(BYTES);
    mark("mix", 'a');
    for (int i = 0; i < BYTES; i++) buf[i] = i * 131;
    uint32_t h = 2166136261u;
    for (int r = 0; r < 96; r++)
        for (int i = 0; i < BYTES; i++) h = (h ^ buf[i]) * 16777619u;
    sink = h;
    mark("mix", 'b');
    free(buf);

    int* ints = malloc(INTS * sizeof *ints);
    mark("sort", 'a');
    for (int i = 0; i < INTS; i++) ints[i] = (i * 2654435761u) >> 3;
    qsort(ints, INTS, sizeof *ints, compare);
    sink = ints[INTS / 2];
    mark("sort", 'b');
    free(ints);

    mark("getpid", 'a');
    for (int i = 0; i < 400000; i++) sink += getpid();
    mark("getpid", 'b');

    struct stat st;
    mark("stat", 'a');
    for (int i = 0; i < 100000; i++) sink += stat("/bin/sh", &st);
    mark("stat", 'b');

    static char block[65536];
    int fds[2];
    pipe(fds);
    mark("pipe4k", 'a');
    for (int i = 0; i < 50000; i++) {
        write(fds[1], block, 4096);
        read(fds[0], block, 4096);
    }
    mark("pipe4k", 'b');
    mark("pipe64k", 'a');
    for (int i = 0; i < 10000; i++) {
        // a pipe holds 64 KiB, so this never blocks
        write(fds[1], block, sizeof block);
        for (int got = 0; got < (int) sizeof block;)
            got += read(fds[0], block + got, sizeof block - got);
    }
    mark("pipe64k", 'b');
    close(fds[0]);
    close(fds[1]);
}

int main(int argc, char** argv) {
    if (argc >= 3 && !strcmp(argv[1], "drop")) {
        if (setuid(1000)) return 2;
        execv(argv[2], argv + 2);
        return 127;
    }
    if (argc == 2 && !strcmp(argv[1], "phases")) {
        who = getuid() ? "g" : "p";
        phases();
        return 0;
    }
    if (argc == 2 && !strcmp(argv[1], "fork")) {
        phases();
        pid_t pid = fork();
        if (pid == 0) {
            who = "c";
            phases();
            _exit(0);
        }
        int status = -1;
        waitpid(pid, &status, 0);
        return WIFEXITED(status) ? WEXITSTATUS(status) : 1;
    }
    fprintf(stderr, "usage: own fork | own phases | own drop <path> [args]\n");
    return 2;
}
