#include <errno.h>
#include <sys/syscall.h>
#include <ucontext.h>
#include <unistd.h>

// musl 1.2.5 declares ucontext.h and implements none of it; wasm cannot switch
// stacks in C
int getcontext(ucontext_t* u) {
    errno = ENOSYS;
    return -1;
}

int setcontext(const ucontext_t* u) {
    errno = ENOSYS;
    return -1;
}

int swapcontext(ucontext_t* o, const ucontext_t* u) {
    errno = ENOSYS;
    return -1;
}

void makecontext(ucontext_t* u, void (*f)(void), int n, ...) {
}

// musl 1.2.6 adds it
int renameat2(int od, const char* o, int nd, const char* n, unsigned f) {
    return syscall(SYS_renameat2, od, o, nd, n, f);
}
