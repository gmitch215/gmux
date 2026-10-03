// fork through the host, for a libc without the musl patch that does it in
// _Fork: the host captures this program's frames, forks the task and resumes
// them in both (src/worker/machine/machine.ts). A program built without
// resumable frames gets ENOSYS
#include <errno.h>
#include <signal.h>
#include <unistd.h>

long __gmux_fork(void);

pid_t fork(void) {
    sigset_t all, old;
    sigfillset(&all);
    sigprocmask(SIG_BLOCK, &all, &old);
    long ret = __gmux_fork();
    sigprocmask(SIG_SETMASK, &old, 0);
    if (ret < 0) {
        errno = -ret;
        return -1;
    }
    return ret;
}
