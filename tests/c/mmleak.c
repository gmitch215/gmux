#define _GNU_SOURCE
#include <errno.h>
#include <fcntl.h>
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <sys/wait.h>
#include <unistd.h>
#define CHECK(name, ok) printf("%s %s\n", (ok) ? "PASS" : "FAIL", name)

static char* env[] = {NULL};

/* what a vfork child's execve did: 0 when the program ran and exited 0, 200 +
 * the signal when it was killed */
static int spawn(const char* path, char* arg) {
    int st;
    char* argv[] = {(char*) path, arg, NULL};
    pid_t pid = vfork();
    if (pid == 0) {
        execve(path, argv, env);
        _exit(errno);
    }
    waitpid(pid, &st, 0);
    if (WIFSIGNALED(st)) return 200 + WTERMSIG(st);
    return WEXITSTATUS(st);
}

/* a copy of this program with one byte flipped: the host holds no build of it
 */
static int unknown(const char* to) {
    static char buf[1 << 20];
    int in = open("/bin/mmleak", O_RDONLY);
    ssize_t n = in < 0 ? -1 : read(in, buf, sizeof buf);
    if (in >= 0) close(in);
    if (n <= 0 || n == (ssize_t) sizeof buf) return -1;
    buf[n / 2] = (char) 0xff;
    int out = open(to, O_WRONLY | O_CREAT | O_TRUNC, 0755);
    if (out < 0 || write(out, buf, n) != n) return -1;
    fchmod(out, 0755);
    return close(out);
}

/* the value of a "Key: value" line of a /proc file, or -1 */
static long field(const char* path, const char* key) {
    char line[256];
    long v = -1;
    size_t k = strlen(key);
    FILE* f = fopen(path, "r");
    while (f && fgets(line, sizeof line, f))
        if (!strncmp(line, key, k) && line[k] == ':') {
            v = atol(line + k + 1);
            break;
        }
    if (f) fclose(f);
    return v;
}

/* active objects of a slab cache: its line of /proc/slabinfo, or -1 */
static long slab(const char* name) {
    char line[256];
    long v = -1;
    size_t k = strlen(name);
    FILE* f = fopen("/proc/slabinfo", "r");
    while (f && fgets(line, sizeof line, f))
        if (!strncmp(line, name, k) && line[k] == ' ') {
            v = atol(line + k + 1);
            break;
        }
    if (f) fclose(f);
    return v;
}

/* free pages by order, summed */
static long buddy(void) {
    char line[256];
    long pages = 0;
    FILE* f = fopen("/proc/buddyinfo", "r");
    while (f && fgets(line, sizeof line, f)) {
        char* p = strstr(line, "Normal");
        if (!p) continue;
        p += 6;
        for (int order = 0; order < 11; order++) {
            char* end;
            long n = strtol(p, &end, 10);
            if (end == p) break;
            pages += n << order;
            p = end;
        }
    }
    if (f) fclose(f);
    return pages;
}

int main(int argc, char** argv) {
    if (argc > 1 && !strcmp(argv[1], "child")) return 0;
    int rounds = argc > 1 ? atoi(argv[1]) : 1000, bad = 0;
    pid_t pid;
    int st;
    CHECK("the unknown program exists", !unknown("/tmp/unknown"));
    for (int r = 1; r <= rounds; r++) {
        /* the exec the cost is about: a vfork child that execs and exits */
        if (spawn("/bin/true", NULL)) bad++;
        /* a fork child that never execs */
        if (r % 10 == 0) {
            pid = fork();
            if (pid == 0) _exit(0);
            waitpid(pid, &st, 0);
            if (!WIFEXITED(st)) bad++;
        }
        /* an exec that fails after the mm swap */
        if (r % 20 == 0 && spawn("/tmp/unknown", "child") != 200 + SIGSEGV)
            bad++;
        /* a program that holds its mm until its exit */
        if (r % 50 == 0 && spawn("/bin/mmleak", "child")) bad++;
        if (r % 100 == 0)
            printf(
                "SAMPLE %d memfree %ld percpu %ld buddy %ld mm %ld vma %ld\n",
                r, field("/proc/meminfo", "MemFree") / 4,
                field("/proc/meminfo", "Percpu"), buddy(), slab("mm_struct"),
                slab("vm_area_struct")
            );
    }
    CHECK("every round did what it should", !bad);
    return 0;
}
