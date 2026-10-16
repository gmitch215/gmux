/* times a guest's run(n) natively: run(2n) less run(n), a number of rounds, as
 * one JSON line */
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>
#include <unistd.h>

extern uint32_t run(uint32_t n);

static double ms(void) {
    struct timespec t;
    clock_gettime(CLOCK_MONOTONIC, &t);
    return (double) t.tv_sec * 1e3 + (double) t.tv_nsec / 1e6;
}

static int cmp(const void* a, const void* b) {
    double x = *(const double*) a, y = *(const double*) b;
    return (x > y) - (x < y);
}

/* no stdio buffers: the zstd guest's arena malloc stands in for libc's, and
 * run() resets it */
int main(int argc, char** argv) {
    if (argc < 4) return 2;
    const char* name = argv[1];
    int rounds = atoi(argv[2]);
    uint32_t n = (uint32_t) atoi(argv[3]);
    if (rounds < 1 || rounds > 64 || n < 1) return 2;
    double diffs[64];
    uint32_t check = run(2);
    for (int i = 0; i < 3; i++) run(n);
    for (int r = 0; r < rounds; r++) {
        double a = ms();
        run(2 * n);
        double b = ms();
        run(n);
        double c = ms();
        diffs[r] = (b - a) - (c - b);
    }
    double sorted[64];
    memcpy(sorted, diffs, sizeof(double) * (size_t) rounds);
    qsort(sorted, (size_t) rounds, sizeof(double), cmp);
    char out[2048];
    int len = snprintf(
        out, sizeof out,
        "{\"variant\":\"%s\",\"checksum\":%u,\"n\":%u,\"ms\":%.4f,\"rounds\":[",
        name, check, n, sorted[rounds / 2]
    );
    for (int r = 0; r < rounds; r++)
        len += snprintf(
            out + len, sizeof out - (size_t) len, "%s%.4f", r ? "," : "",
            diffs[r]
        );
    len += snprintf(out + len, sizeof out - (size_t) len, "]}\n");
    return write(1, out, (size_t) len) == len ? 0 : 1;
}
