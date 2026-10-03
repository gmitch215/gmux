#include <math.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

/* libm gen <n> <out>: exp, log, pow, sin and cos of n pseudo-random inputs
 * each, results as raw bits; libm cmp <a> <b>: how many results of each
 * function differ between two such files */

enum
{
    FUNCS = 5
};
static const char* const names[FUNCS] = {"exp", "log", "pow", "sin", "cos"};

static uint64_t s = 88172645463325252ull;
static double rnd(void) {
    s ^= s << 13, s ^= s >> 7, s ^= s << 17;
    return (double) (s >> 11) / 9007199254740992.0;
}

int main(int argc, char** argv) {
    if (argc == 4 && !strcmp(argv[1], "gen")) {
        size_t n = strtoull(argv[2], 0, 0);
        FILE* f = fopen(argv[3], "wb");
        for (int k = 0; k < FUNCS; k++)
            for (size_t i = 0; i < n; i++) {
                double x, r;
                switch (k) {
                    case 0:
                        x = (rnd() - 0.5) * 1400;
                        r = exp(x);
                        break;
                    case 1:
                        x = ldexp(1 + rnd(), (int) (rnd() * 2000) - 1000);
                        r = log(x);
                        break;
                    case 2:
                        x = rnd() * 100, r = pow(x, (rnd() - 0.5) * 100);
                        break;
                    case 3:
                        x = (rnd() - 0.5) * 2e5;
                        r = sin(x);
                        break;
                    default: x = (rnd() - 0.5) * 2e5; r = cos(x);
                }
                fwrite(&r, 8, 1, f);
            }
        fclose(f);
        return 0;
    }
    if (argc == 4 && !strcmp(argv[1], "cmp")) {
        FILE *a = fopen(argv[2], "rb"), *b = fopen(argv[3], "rb");
        uint64_t x, y, total[FUNCS] = {0}, diff[FUNCS] = {0},
                       first[FUNCS] = {0};
        size_t i = 0;
        fseek(a, 0, SEEK_END);
        size_t n = (size_t) ftell(a) / 8 / FUNCS;
        rewind(a);
        for (int k = 0; k < FUNCS; k++)
            for (i = 0; i < n; i++) {
                if (fread(&x, 8, 1, a) != 1 || fread(&y, 8, 1, b) != 1)
                    return 2;
                total[k]++;
                if (x != y && !diff[k]++) first[k] = i;
            }
        for (int k = 0; k < FUNCS; k++)
            printf(
                "%s: %llu of %llu differ (first at %llu)\n", names[k],
                (unsigned long long) diff[k], (unsigned long long) total[k],
                (unsigned long long) first[k]
            );
        return 0;
    }
    fprintf(stderr, "usage: libm gen <n> <out> | libm cmp <a> <b>\n");
    return 2;
}
