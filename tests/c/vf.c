#include <errno.h>
#include <stdio.h>
#include <sys/wait.h>
#include <unistd.h>
int main(void) {
    int st;
    char* env[] = {NULL};
    pid_t pid = vfork();
    if (pid == 0) {
        char* argv[] = {"echo", "from-exec", NULL};
        execve("/bin/echo", argv, env);
        _exit(127);
    }
    waitpid(pid, &st, 0);
    printf("child %d exited %d\n", pid > 0, WEXITSTATUS(st));
    pid = vfork();
    if (pid == 0) _exit(7);
    waitpid(pid, &st, 0);
    printf("second exited %d\n", WEXITSTATUS(st));
    pid = vfork();
    if (pid == 0) {
        char* argv[] = {"x", NULL};
        execve("/nonexistent", argv, env);
        _exit(errno == ENOENT ? 9 : 1);
    }
    waitpid(pid, &st, 0);
    printf("third exited %d\n", WEXITSTATUS(st));
    return 0;
}
