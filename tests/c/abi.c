// a program without the stack abi word (/bin/abi-old, abi with its gmux.abi
// section cut out by run.ts) fails its exec with EPROTO and the caller goes on;
// refusals leave no mapping behind
#define _GNU_SOURCE
#include <errno.h>
#include <stdio.h>
#include <string.h>
#include <sys/wait.h>
#include <unistd.h>
#define CHECK(name, ok) printf("%s %s\n", (ok) ? "PASS" : "FAIL", name)
#define ROUNDS 200

// the child's exit code, or 90 when its exec failed with EPROTO and 91 for any
// other error
static int run(char* path, char* arg) {
    int st;
    char* env[] = {NULL};
    pid_t pid = vfork();
    if (pid == 0) {
        char* argv[] = {path, arg, NULL};
        execve(path, argv, env);
        _exit(errno == EPROTO ? 90 : 91);
    }
    waitpid(pid, &st, 0);
    return WEXITSTATUS(st);
}

int main(int argc, char** argv) {
    if (argc > 1 && !strcmp(argv[1], "child")) return 0;
    CHECK("a program with the word runs", run("/bin/abi", "child") == 0);
    CHECK(
        "a program without it fails with EPROTO",
        run("/bin/abi-old", "child") == 90
    );
    CHECK("busybox runs", run("/bin/busybox", "true") == 0);
    int refused = 0, ran = 0;
    for (int i = 0; i < ROUNDS; i++) {
        refused += run("/bin/abi-old", "child") == 90;
        ran += run("/bin/abi", "child") == 0;
    }
    printf("refused %d of %d, ran %d of %d\n", refused, ROUNDS, ran, ROUNDS);
    CHECK("every refusal fails with EPROTO", refused == ROUNDS);
    CHECK("every exec after a refusal runs", ran == ROUNDS);
    return 0;
}
