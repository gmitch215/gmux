// control flow a checkpoint must carry. Each phase parks in a syscall at its
// deepest point, so experiments/evacuation/scripts/control-flow.ts can
// checkpoint it mid-flight; the restored run must print what an uninterrupted
// run prints
#include <dlfcn.h>
#include <setjmp.h>
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <time.h>

static void park(void) {
    struct timespec ts = {0, 30 * 1000 * 1000};
    nanosleep(&ts, 0);
}

// a park the host cannot miss: the program blocks on a line the harness types
// after the checkpoint (it may see a phase begin only after a timed park has
// ended)
static void wait_line(int phase) {
    printf("phase %d park\n", phase);
    fflush(stdout);
    char line[16];
    if (!fgets(line, sizeof line, stdin)) line[0] = 0;
}

static unsigned recurse(int n, unsigned acc) {
    volatile unsigned mine[4] = {acc, acc ^ n, acc + n, acc * 3};
    if (n == 0) {
        park();
        return mine[1];
    }
    return recurse(n - 1, acc * 31 + n) + mine[2] - mine[3];
}

typedef unsigned (*step_fn)(int, unsigned);
static unsigned step_a(int n, unsigned x);
static unsigned step_b(int n, unsigned x);
static step_fn steps[2] = {step_a, step_b};
static unsigned step_a(int n, unsigned x) {
    if (!n) {
        park();
        return x;
    }
    return steps[n & 1](n - 1, x * 7 + 1) ^ n;
}
static unsigned step_b(int n, unsigned x) {
    if (!n) {
        park();
        return x;
    }
    return steps[(n >> 1) & 1](n - 1, x + 13) * 3;
}

static jmp_buf back;
static unsigned jumped(int n, unsigned x) {
    volatile unsigned keep = x * 5;
    if (n == 0) {
        park();
        longjmp(back, (int) (keep & 0xffff) | 1);
    }
    return jumped(n - 1, x + n) + keep;
}

static int compared;
static int cmp(const void* a, const void* b) {
    if (++compared == 100) park();
    return *(const int*) a - *(const int*) b;
}

// a frame run twice (re-entered from its start instead of resumed) counts twice
static unsigned calls;

static unsigned pointer_target(unsigned x) {
    unsigned mine = x * 11 + calls++;
    wait_line(6);
    return mine;
}

// the side module (tests/c/side/callback.c) imports it
__attribute__((used, visibility("default"))) unsigned control_flow_hook(
    unsigned x
) {
    volatile unsigned mine = x + 7 + calls++;
    wait_line(7);
    return mine;
}

static volatile unsigned handled;
static void handler(int s) {
    volatile unsigned inside = s * 1000;
    park();
    handled = recurse(5, inside);
}

int main(void) {
    printf("phase 1 begin\n");
    fflush(stdout);
    printf("phase 1 recursion %u\n", recurse(40, 1));
    printf("phase 2 begin\n");
    fflush(stdout);
    printf("phase 2 indirect %u\n", steps[0](30, 3));
    printf("phase 3 begin\n");
    fflush(stdout);
    volatile unsigned before = 42;
    int j = setjmp(back);
    if (!j) jumped(20, 9);
    printf("phase 3 longjmp %d %u\n", j, before);
    printf("phase 4 begin\n");
    fflush(stdout);
    int values[300];
    for (int i = 0; i < 300; i++) values[i] = (i * 7919) % 1009;
    qsort(values, 300, sizeof *values, cmp);
    unsigned sum = 0;
    for (int i = 0; i < 300; i++) sum = sum * 3 + values[i];
    printf("phase 4 qsort %u\n", sum);
    printf("phase 5 begin\n");
    fflush(stdout);
    signal(SIGUSR1, handler);
    raise(SIGUSR1);
    printf("phase 5 signal %u\n", handled);
    void* lib = dlopen("/lib/libcallback.so", RTLD_NOW);
    if (!lib) {
        printf("phase 6 dlopen failed: %s\n", dlerror());
        return 1;
    }
    unsigned (*through_pointer)(unsigned (*)(unsigned), unsigned) =
        dlsym(lib, "through_pointer");
    unsigned (*through_import)(unsigned) = dlsym(lib, "through_import");
    printf("phase 6 begin\n");
    fflush(stdout);
    printf(
        "phase 6 side module pointer %u\n", through_pointer(pointer_target, 5)
    );
    printf("phase 7 begin\n");
    fflush(stdout);
    printf("phase 7 side module import %u\n", through_import(9));
    printf("control flow done\n");
    return 0;
}
