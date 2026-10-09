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

/* what a vfork child's execve did: its errno, 0 when it ran and exited 0, 200 +
 * the signal when killed */
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

static int made(const char* path, int mode, const char* text, size_t size) {
    int fd = open(path, O_WRONLY | O_CREAT | O_TRUNC, mode);
    if (fd < 0) return -1;
    if (write(fd, text, size) != (ssize_t) size) return -1;
    if (fchmod(fd, mode) || close(fd)) return -1;
    return 0;
}

static int copied(const char* from, const char* to, long flip) {
    static char buf[1 << 20];
    int in = open(from, O_RDONLY);
    ssize_t n = in < 0 ? -1 : read(in, buf, sizeof buf);
    if (in >= 0) close(in);
    if (n < 0 || n == (ssize_t) sizeof buf) return -1;
    if (flip != -1) buf[flip == -2 ? n / 2 : flip] = (char) 0xff;
    return made(to, 0755, buf, n);
}

static long free_pages(void) {
    char line[128];
    long kb = -1;
    FILE* f = fopen("/proc/meminfo", "r");
    while (f && fgets(line, sizeof line, f))
        if (sscanf(line, "MemFree: %ld kB", &kb) == 1) break;
    if (f) fclose(f);
    return kb / 4;
}

static void expect(const char* name, int got, int want) {
    printf("%s -> %d\n", name, got);
    CHECK(name, got == want);
}

int main(int argc, char** argv) {
    static char tall[5000], big[140000];
    char* bigv[] = {"x", big, NULL};
    int st, ok = 1;
    pid_t pid;

    if (argc > 1 && !strcmp(argv[1], "child")) return 0;
    memset(tall, 'a', sizeof tall - 1);
    tall[0] = '/';
    memset(big, 'b', sizeof big - 1);
    ok &= !made("/tmp/noexec", 0644, "x\n", 2);
    ok &= !made("/tmp/shebang", 0755, "#!/nonexistent/interp\n", 22);
    ok &= !made("/tmp/junk", 0755, "junk\n", 5);
    ok &= !copied("/bin/execfail", "/tmp/unknown", -2);
    ok &= !copied("/bin/execfail", "/tmp/busy", -1);
    CHECK("the files the cases need exist", ok);
    int writer = open("/tmp/busy", O_WRONLY);

    expect("missing file", spawn("/bin/nosuch", NULL), ENOENT);
    expect("missing directory", spawn("/nosuchdir/x", NULL), ENOENT);
    expect("a file as a directory", spawn("/bin/busybox/x", NULL), ENOTDIR);
    expect("a directory", spawn("/bin", NULL), EACCES);
    expect("no execute permission", spawn("/tmp/noexec", NULL), EACCES);
    expect(
        "shebang to a missing interpreter", spawn("/tmp/shebang", NULL), ENOENT
    );
    expect("not a program", spawn("/tmp/junk", NULL), ENOEXEC);
    expect("a path of 4999 bytes", spawn(tall, NULL), ENAMETOOLONG);
    expect("busy for writing", spawn("/tmp/busy", "child"), ETXTBSY);
    close(writer);
    expect("closed again", spawn("/tmp/busy", "child"), 0);
    expect(
        "the host refuses it", spawn("/tmp/unknown", "child"), 200 + SIGSEGV
    );

    {
        int fails = 0;
        pid = vfork();
        if (pid == 0) {
            execve("/bin/true", bigv, env);
            _exit(errno);
        }
        waitpid(pid, &st, 0);
        fails = WEXITSTATUS(st);
        expect("an argument of 139999 bytes", fails, E2BIG);
    }
    if (access("/bin/hello-x86", X_OK) == 0)
        expect("x86-64 through katybug", spawn("/bin/hello-x86", NULL), 0);
    expect("a program after all of them", spawn("/bin/true", NULL), 0);

    long before = free_pages();
    int wrong = 0;
    for (int i = 0; i < 300; i++) {
        wrong += spawn("/bin/nosuch", NULL) != ENOENT;
        wrong += spawn("/tmp/noexec", NULL) != EACCES;
        wrong += spawn("/tmp/junk", NULL) != ENOEXEC;
        wrong += spawn("/tmp/unknown", "child") != 200 + SIGSEGV;
    }
    long lost = before - free_pages();
    printf(
        "300 rounds of four failures: %d wrong, %ld pages lost\n", wrong, lost
    );
    CHECK("every failure fails the same way every time", wrong == 0);
    CHECK("the failures leave no pages behind", lost < 400);
    return 0;
}
