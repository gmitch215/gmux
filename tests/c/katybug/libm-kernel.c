#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "../../../src/gmux/katybug/libm.h"

/* the kernels against libm-vectors.txt: every input one runs must give the
 * bits glibc 2.36 returns on x86-64 without FMA (flavor 0) and musl 1.2.5
 * returns on AArch64 (flavor 1); the others are left to the guest */
static uint64_t bits(double d) {
    uint64_t b;
    memcpy(&b, &d, 8);
    return b;
}

static double dbl(uint64_t b) {
    double d;
    memcpy(&d, &b, 8);
    return d;
}

int main(int argc, char** argv) {
    if (argc < 2) return fprintf(stderr, "usage: libm-kernel <vectors>\n"), 2;
    if (!kb_libm_ok())
        return puts("the compiler fused a multiply and an add"), 2;
    FILE* fp = fopen(argv[1], "r");
    if (!fp) return perror(argv[1]), 2;
    char line[256], fn[8], a[32], b[32], c[3][32];
    long n[3] = {0}, ran[3][2] = {{0}}, bad[3][2] = {{0}};
    while (fgets(line, sizeof line, fp)) {
        if (line[0] == '#') continue;
        if (sscanf(
                line, "%7s %31s %31s %31s %31s %31s", fn, a, b, c[0], c[1], c[2]
            ) != 6)
            return fprintf(stderr, "bad line: %s", line), 2;
        int f = !strcmp(fn, "exp") ? 0 : !strcmp(fn, "log") ? 1 : 2;
        double x = dbl(strtoull(a, 0, 16)),
               y = f == 2 ? dbl(strtoull(b, 0, 16)) : 0, r;
        n[f]++;
        for (int fused = 0; fused < 2; fused++) {
            int ok = f == 0   ? kb_libm_exp(x, fused, &r)
                     : f == 1 ? kb_libm_log(x, fused, &r)
                              : kb_libm_pow(x, y, fused, &r);
            if (!ok) continue;
            ran[f][fused]++;
            if (bits(r) != strtoull(c[fused ? 2 : 0], 0, 16) &&
                bad[f][fused]++ < 5)
                printf(
                    "%s %s %s flavor %d: kernel %016llx\n", fn, a, b, fused,
                    (unsigned long long) bits(r)
                );
        }
    }
    static const char* const names[] = {"exp", "log", "pow"};
    int fail = 0;
    for (int f = 0; f < 3; f++) {
        printf(
            "%s %ld inputs: x86-64 kernel ran %ld, %ld differing; AArch64 "
            "kernel ran %ld, %ld differing\n",
            names[f], n[f], ran[f][0], bad[f][0], ran[f][1], bad[f][1]
        );
        fail |= bad[f][0] || bad[f][1] || ran[f][0] < n[f] / 4 ||
                ran[f][1] < n[f] / 4;
    }
    return fail;
}
