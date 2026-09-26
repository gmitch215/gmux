#include <pthread.h>
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/wait.h>
#include <unistd.h>
#define CHECK(name, ok) printf("%s %s\n", (ok) ? "PASS" : "FAIL", name)

static volatile int spun;

static void* spin(void* arg) {
    pthread_setcanceltype(PTHREAD_CANCEL_ASYNCHRONOUS, 0);
    spun = 1;
    for (;;) spun++;
    return arg;
}

int main(int argc, char** argv) {
    if (argc == 2 && !strcmp(argv[1], "alarm")) {
        alarm(1);
        for (;;) spun++;
    }
    if (argc == 2 && !strcmp(argv[1], "eat")) {
        /* volatile, or clang drops the unused allocations and the loop */
        static char* volatile last;
        while ((last = malloc(1 << 20))) memset(last, 1, 1 << 20);
        return 0;
    }

    /* a thread that never makes a syscall is still reached by a signal */
    pthread_t t;
    void* res = 0;
    pthread_create(&t, 0, spin, 0);
    while (!spun) sched_yield();
    pthread_cancel(t);
    CHECK(
        "async cancel of a spinning thread",
        pthread_join(t, &res) == 0 && res == PTHREAD_CANCELED
    );

    /* and so is a spinning process, by its alarm's default action */
    int st = 0;
    pid_t pid = vfork();
    if (pid == 0) {
        char* args[] = {argv[0], "alarm", NULL};
        execv("/bin/spin", args);
        _exit(127);
    }
    waitpid(pid, &st, 0);
    CHECK(
        "SIGALRM ends a spinning process",
        WIFSIGNALED(st) && WTERMSIG(st) == SIGALRM
    );

    /* a process that takes all the memory is refused or killed, and the rest
     * of the machine allocates again once it is gone */
    pid = vfork();
    if (pid == 0) {
        char* args[] = {argv[0], "eat", NULL};
        execv("/bin/spin", args);
        _exit(127);
    }
    waitpid(pid, &st, 0);
    char* after = malloc(4 << 20);
    if (after) memset(after, 2, 4 << 20);
    int bounded = ((WIFEXITED(st) && WEXITSTATUS(st) == 0) ||
                   (WIFSIGNALED(st) && WTERMSIG(st) == SIGKILL)) &&
                  after;
    CHECK("memory exhaustion ends only the process", bounded);
    if (!bounded) printf("eater status %#x, after %p\n", st, (void*) after);
    return 0;
}
