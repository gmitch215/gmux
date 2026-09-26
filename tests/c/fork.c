// fork in a program built with resumable frames (tests/c/run.ts builds it with
// experiments/evacuation/scripts/evacuate.mjs --resume). The child gets a
// copy of the parent's memory and the parent's frames, which resume in both
#include <arpa/inet.h>
#include <errno.h>
#include <netinet/in.h>
#include <stdio.h>
#include <string.h>
#include <sys/socket.h>
#include <sys/wait.h>
#include <unistd.h>
#define CHECK(name, ok) printf("%s %s\n", (ok) ? "PASS" : "FAIL", name)

static int counter = 1;
static pid_t deep_child;

/* forks at the bottom; each frame adds its own local on the way back */
static int deep(int n) {
    int here = n * 3;
    if (n == 0) {
        pid_t p = fork();
        if (p > 0) deep_child = p;
        return p == 0 ? 1000 : 0;
    }
    return deep(n - 1) + here;
}

static int status_of(pid_t p) {
    int st = -1;
    waitpid(p, &st, 0);
    return WIFEXITED(st) ? WEXITSTATUS(st)
                         : 128 + (WIFSIGNALED(st) ? WTERMSIG(st) : 0);
}

/* accepts three connections, each served by a forked child that echoes a line
 * upper-cased */
static int serve(int listener) {
    for (int i = 0; i < 3; i++) {
        int c = accept(listener, 0, 0);
        if (c < 0) return 1;
        pid_t p = fork();
        if (p == 0) {
            char line[64] = {0};
            ssize_t n = read(c, line, sizeof line - 1);
            for (ssize_t j = 0; j < n; j++)
                if (line[j] >= 'a' && line[j] <= 'z') line[j] -= 32;
            write(c, line, n);
            _exit(0);
        }
        close(c);
        if (p < 0 || status_of(p) != 0) return 2;
    }
    return 0;
}

int main(void) {
    int local = 10;
    pid_t p = fork();
    if (p < 0) {
        printf("FAIL fork: %s\n", strerror(errno));
        return 1;
    }
    if (p == 0) {
        counter = 2;
        local = 20;
        _exit(counter + local);
    }
    CHECK(
        "fork child has its own copy",
        status_of(p) == 22 && counter == 1 && local == 10
    );

    int fds[2];
    pipe(fds);
    p = fork();
    if (p == 0) {
        close(fds[0]);
        write(fds[1], "from the child", 15);
        _exit(0);
    }
    close(fds[1]);
    char buf[32] = {0};
    read(fds[0], buf, sizeof buf);
    CHECK("fork pipe", status_of(p) == 0 && !strcmp(buf, "from the child"));

    int v = deep(40);
    if (v > 3000) _exit(v == 1000 + 2460 ? 55 : 1);
    CHECK(
        "fork deep in the stack, frames resumed in both",
        v == 2460 && status_of(deep_child) == 55
    );

    p = fork();
    if (p == 0) {
        execl("/bin/busybox", "echo", "exec from a fork child", (char*) 0);
        _exit(127);
    }
    CHECK("fork then exec", status_of(p) == 0);

    int listener = socket(AF_INET, SOCK_STREAM, 0);
    struct sockaddr_in a = {
        .sin_family = AF_INET,
        .sin_port = htons(18090),
        .sin_addr.s_addr = htonl(INADDR_LOOPBACK)
    };
    int one = 1;
    setsockopt(listener, SOL_SOCKET, SO_REUSEADDR, &one, sizeof one);
    if (bind(listener, (void*) &a, sizeof a) || listen(listener, 4)) {
        printf("FAIL listen: %s\n", strerror(errno));
        return 1;
    }
    pid_t server = fork();
    if (server == 0) _exit(serve(listener));
    close(listener);
    int echoed = 0;
    const char* words[] = {"one", "two", "three"};
    const char* upper[] = {"ONE", "TWO", "THREE"};
    for (int i = 0; i < 3; i++) {
        int c = socket(AF_INET, SOCK_STREAM, 0);
        char reply[16] = {0};
        if (connect(c, (void*) &a, sizeof a) == 0 &&
            write(c, words[i], strlen(words[i])) > 0 &&
            read(c, reply, sizeof reply - 1) > 0 && !strcmp(reply, upper[i]))
            echoed++;
        close(c);
    }
    CHECK("forking server", echoed == 3 && status_of(server) == 0);
    return 0;
}
