// `calls <call> <n>`: n of one syscall in a fork child (its own memory, so each
// buffer the kernel reaches is a host crossing), bracketed by @@<call>a@@ and
// @@<call>b@@ for the host to read the crossing counters at. Calls: getpid,
// stat, statsh (own.c's path), statodd (an odd address), open, writev, readv,
// read
#include <fcntl.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <sys/uio.h>
#include <sys/wait.h>
#include <unistd.h>

static void mark(const char* call, char end) {
    printf("@@%s%c@@\n", call, end);
    fflush(stdout);
}

static int run(const char* call, int n) {
    struct stat st;
    static char buf[64];
    int fds[2];
    if (pipe(fds)) return 1;
    struct iovec two[2] = {{buf, 4}, {buf + 8, 4}};
    static char odd[32];
    strcpy(odd + 1, "/bin/busybox");
    long sink = 0;
    mark(call, 'a');
    for (int i = 0; i < n; i++) {
        if (!strcmp(call, "getpid"))
            sink += getpid();
        else if (!strcmp(call, "stat"))
            sink += stat("/bin/busybox", &st);
        else if (!strcmp(call, "statsh"))
            sink += stat("/bin/sh", &st);
        else if (!strcmp(call, "statodd"))
            sink += stat(odd + 1, &st);
        else if (!strcmp(call, "open"))
            close(open("/bin/busybox", O_RDONLY));
        else if (!strcmp(call, "writev")) {
            sink += writev(fds[1], two, 2);
            sink += read(fds[0], buf, 8);
        }
        else if (!strcmp(call, "readv")) {
            sink += write(fds[1], buf, 8);
            sink += readv(fds[0], two, 2);
        }
        else if (!strcmp(call, "read")) {
            sink += write(fds[1], buf, 8);
            sink += read(fds[0], buf, 8);
        }
        else
            return 2;
    }
    mark(call, 'b');
    return sink == -12345;
}

int main(int argc, char** argv) {
    if (argc != 3) {
        fprintf(stderr, "usage: calls <call> <n>\n");
        return 2;
    }
    pid_t pid = fork();
    if (pid == 0) {
        // the first pass warms the host's and the kernel's compiled code; the
        // host reads the second
        int n = atoi(argv[2]);
        run(argv[1], n);
        _exit(run(argv[1], n));
    }
    int status = -1;
    waitpid(pid, &status, 0);
    return WIFEXITED(status) ? WEXITSTATUS(status) : 1;
}
