#include <signal.h>
#include <stdio.h>
#include <string.h>
#include <sys/wait.h>
#include <unistd.h>
#define CHECK(name, ok) printf("%s %s\n", (ok) ? "PASS" : "FAIL", name)

/* the frame's address escapes here, so the compiler keeps all of it */
__attribute__((noinline)) static int touch(volatile char* frame, int size) {
    frame[size - 1] = 0;
    return frame[0] = 1;
}

/* a kilobyte of stack a level */
static int deep(int n) {
    volatile char frame[1024];
    int one = touch(frame, sizeof frame);
    return n ? deep(n - 1) + one : 0;
}

/* 64 KiB a level: past a 1 MiB stack in 16 levels, long before the host's own
 * stack runs out */
static int deeper(int n) {
    volatile char frame[65536];
    int one = touch(frame, sizeof frame);
    return n ? deeper(n - 1) + one : 0;
}

int main(int argc, char** argv) {
    if (argc == 2 && !strcmp(argv[1], "overflow")) return deeper(1 << 20);

    CHECK("512 KiB of recursion", deep(512) == 512);

    int st = 0;
    pid_t pid = vfork();
    if (pid == 0) {
        char* args[] = {argv[0], "overflow", NULL};
        execv("/bin/stack", args);
        _exit(127);
    }
    waitpid(pid, &st, 0);
    CHECK(
        "a stack overflow is SIGSEGV",
        WIFSIGNALED(st) && WTERMSIG(st) == SIGSEGV
    );
    return 0;
}
