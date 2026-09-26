// vfork for src/gmux/include/unistd.h. The child runs on the parent's stack as
// the child task until execve or _exit, which the host runs on a stack of its
// own (src/worker/machine/machine.ts); the parent then longjmps back to the
// setjmp in vfork's caller with the child's pid
#include <errno.h>
#include <setjmp.h>
#include <sys/syscall.h>
#include <unistd.h>

pid_t __gmux_vfork(struct __jmp_buf_tag* env);
long __gmux_vfork_exec(
    const char* path, char* const argv[], char* const envp[]
);
long __gmux_vfork_exit(int status);

// a vfork child may vfork again
static jmp_buf slots[8];
static int depth;

struct __jmp_buf_tag* __gmux_vfork_slot(void) {
    return slots[depth < 8 ? depth : 7];
}

pid_t __gmux_vfork_result(int jumped) {
    if (jumped) {
        depth--;
        return jumped;
    }
    if (depth == 8) {
        errno = EAGAIN;
        return -1;
    }
    pid_t r = __gmux_vfork(slots[depth++]);
    if (r < 0) {
        depth--;
        errno = -r;
        return -1;
    }
    return r;
}

int execve(const char* path, char* const argv[], char* const envp[]) {
    if (!depth) return syscall(SYS_execve, path, argv, envp);
    long r = __gmux_vfork_exec(path, argv, envp);
    if (r > 0) longjmp(slots[depth - 1], r);
    errno = -r;
    return -1;
}

_Noreturn void _exit(int status) {
    if (depth) longjmp(slots[depth - 1], __gmux_vfork_exit(status));
    syscall(SYS_exit_group, status);
    for (;;) syscall(SYS_exit, status);
}

_Noreturn void _Exit(int status) {
    _exit(status);
}
