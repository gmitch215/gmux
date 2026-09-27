#include <errno.h>
#include <signal.h>

/* emscripten's libc has no sigsuspend; Katybug's --wasm path never reaches it
 */
int sigsuspend(const sigset_t* mask) {
    (void) mask;
    errno = EINTR;
    return -1;
}
