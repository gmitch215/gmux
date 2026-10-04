#define _GNU_SOURCE
#include <fenv.h>
#include <float.h>
#include <math.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

/* libm's exp, log and pow through the dynamic loader's slots, in four modes:
 * gen: the chosen inputs and what this libm returns (libm-vectors.ts merges an
 * x86-64 run and two AArch64 runs into libm-vectors.txt); check <file>
 * <column>: each line's result against the file's; sample <n>: a hash of the
 * results for n pseudo-random inputs per function; refuse: the inputs the
 * kernels leave to the guest; round: the rounding modes. The output must be the
 * same natively and under katybug with its kernels on and off (round: on
 * against off) */

static double (*volatile f_exp)(double) = exp;
static double (*volatile f_log)(double) = log;
static double (*volatile f_pow)(double, double) = pow;

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

static uint64_t seed = 88172645463325252ull;
static uint64_t rnd(void) {
    seed ^= seed << 13, seed ^= seed >> 7, seed ^= seed << 17;
    return seed;
}

static double uni(double lo, double hi) {
    return lo + (hi - lo) * ((double) (rnd() >> 11) / 9007199254740992.0);
}

static double call(int f, double x, double y) {
    return f == 0 ? f_exp(x) : f == 1 ? f_log(x) : f_pow(x, y);
}

static const char* const fname[] = {"exp", "log", "pow"};

/* #region the chosen inputs */
#define CAP 2400
static struct in {
    double x, y;
} list[3][CAP + 1];
static int count[3];

static void add(int f, double x, double y) {
    if (count[f] < CAP) list[f][count[f]++] = (struct in){x, y};
}

static void both(int f, double x, double y) {
    add(f, x, y);
    add(f, -x, y);
}

/* a value, and the ones a step either side of it */
static void around(int f, double x, double y) {
    add(f, x, y);
    add(f, nextafter(x, INFINITY), y);
    add(f, nextafter(x, -INFINITY), y);
}

static void exp_inputs(void) {
    const double sp[] = {0.0,     -0.0,   INFINITY, -INFINITY, NAN,    4.9e-324,
                         DBL_MIN, 1e-300, 1e-17,    1e-16,     5.5e-17};
    for (size_t i = 0; i < sizeof sp / sizeof *sp; i++) both(0, sp[i], 0);
    /* every binade from 2^-60 up: the power, and a step either side */
    for (int k = -60; k <= 10; k++) {
        around(0, ldexp(1.0, k), 0);
        around(0, -ldexp(1.0, k), 0);
    }
    /* the thresholds: 512, 1024, overflow, underflow, the subnormal edge */
    const double th[] = {
        512.0,
        1024.0,
        709.782712893384,
        709.78271289338397,
        -708.3964185322641,
        -745.1332191019411,
        -744.0,
        -740.0,
        700.0,
        -700.0,
        1000.0,
        -1000.0
    };
    for (size_t i = 0; i < sizeof th / sizeof *th; i++) around(0, th[i], 0);
    /* arguments at and next to a multiple of ln2/128 */
    for (int k = -90; k <= 90; k++)
        around(0, k * 0x1.62e42fefa39efp-1 / 128, 0);
    for (int k = -1000; k <= 1000; k += 37)
        around(0, k * 0x1.62e42fefa39efp-1 / 128, 0);
    for (int i = 0; i < 1200; i++) add(0, uni(-745.2, 710.0), 0);
    for (int i = 0; i < 300; i++) add(0, uni(-1, 1), 0);
    while (count[0] < CAP) add(0, dbl(rnd()), 0);
}

static void log_inputs(void) {
    const double sp[] = {
        0.0,  -0.0,     INFINITY, NAN,     1.0,
        -1.0, 4.9e-324, DBL_MIN,  DBL_MAX, 2.2250738585072009e-308
    };
    for (size_t i = 0; i < sizeof sp / sizeof *sp; i++) both(1, sp[i], 0);
    /* every power of two, and the steps either side of those from 2^-64 up */
    for (int k = -1074; k <= 1023; k++) add(1, ldexp(1.0, k), 0);
    for (int k = -64; k <= 64; k++) {
        add(1, nextafter(ldexp(1.0, k), INFINITY), 0);
        add(1, nextafter(ldexp(1.0, k), 0), 0);
    }
    /* the close-to-1 range and its edges */
    around(1, 1.0 - 0x1p-4, 0);
    around(1, 1.0 + 0x1.09p-4, 0);
    around(1, 1.0, 0);
    around(1, 1.0 - 0x1p-53, 0);
    around(1, 0x1.6955p-1, 0);
    for (int i = 0; i < 300; i++) add(1, uni(0.9, 1.1), 0);
    for (int i = 0; i < 400; i++) add(1, uni(0.5, 2.0), 0);
    while (count[1] < CAP) add(1, dbl(rnd() & 0x7fffffffffffffffull), 0);
}

static void pow_inputs(void) {
    const double xs[] = {
        2.0,       3.0,      10.0,          0.5,           0.1,
        1.5,       M_E,      M_PI,          7.25,          1e-10,
        1e10,      1e100,    1e-100,        123456.789,    DBL_MAX,
        DBL_MIN,   4.9e-324, 1.0 + 0x1p-52, 1.0 - 0x1p-53, 0.9999999,
        1.0000001, -2.0,     -3.0,          -0.5,          -1.5,
        -10.0,     -7.0,     1e308,         0.0,           -0.0,
        1.0,       -1.0,     INFINITY,      -INFINITY,     NAN
    };
    double ys[160];
    int ny = 0;
    for (int k = -40; k <= 40; k++) ys[ny++] = k;
    for (int k = -9; k <= 9; k++) ys[ny++] = k + 0.5;
    const double yo[] = {1.0 / 3,  1e-5,      1e-20,  1e5,    -1e5,   700,
                         1023,     1024,      1074,   -1074,  1e300,  -1e300,
                         INFINITY, -INFINITY, NAN,    0.0,    -0.0,   0x1p-64,
                         0x1p-65,  0x1p-66,   0x1p62, 0x1p63, 0x1p53, 0x1p52,
                         308.25,   -307.5,    0.0001, 3.0e-3};
    for (size_t i = 0; i < sizeof yo / sizeof *yo; i++) ys[ny++] = yo[i];
    for (size_t i = 0; i < sizeof xs / sizeof *xs && count[2] < 1800; i++)
        for (int j = 0; j < ny && count[2] < 1800; j += 1 + (int) (i & 1))
            add(2, xs[i], ys[j]);
    /* the powers of two against a few exponents, and results at the edges */
    const double ye[] = {0.5, 1.0, 1.5, 2.0, -1.0, 10.0, -10.0, 0.1, 100.0};
    for (int k = -1074; k <= 1023; k += 53)
        for (size_t j = 0; j < sizeof ye / sizeof *ye; j++)
            add(2, ldexp(1.0, k), ye[j]);
    around(2, 1023.99, 0.0);
    add(2, 2.0, 1023.9999999999999);
    add(2, 2.0, 1024.0);
    add(2, 2.0, -1022.0);
    add(2, 2.0, -1074.0);
    add(2, 2.0, -1075.0);
    add(2, 10.0, 308.25);
    add(2, 10.0, -307.5);
    add(2, 10.0, -323.5);
    /* one statement per draw: the order of a call's arguments is the
     * compiler's */
    while (count[2] < CAP) {
        int k = count[2] % 5;
        double x = uni(k == 4 ? 1e-3 : 0.5, k == 4 ? 1e3 : 4.0);
        double y = uni(-20, 20);
        if (k == 3) x = -x, y = (double) (long) y;
        if (k == 4) y *= 5;
        add(2, x, y);
    }
}
/* #endregion */

static void gen(void) {
    exp_inputs(), log_inputs(), pow_inputs();
    for (int f = 0; f < 3; f++) {
        for (int i = 0; i < count[f]; i++) {
            double x = list[f][i].x, y = list[f][i].y;
            printf("%s %016llx ", fname[f], (unsigned long long) bits(x));
            if (f == 2)
                printf("%016llx ", (unsigned long long) bits(y));
            else
                printf("- ");
            printf("%016llx\n", (unsigned long long) bits(call(f, x, y)));
        }
        fprintf(stderr, "%s %d inputs\n", fname[f], count[f]);
    }
}

static int check(const char* path, int col) {
    FILE* fp = fopen(path, "r");
    if (!fp) return perror(path), 2;
    char line[256], fn[8], a[32], b[32], c[3][32];
    long n[3] = {0}, bad[3] = {0};
    while (fgets(line, sizeof line, fp)) {
        if (line[0] == '#') continue;
        if (sscanf(
                line, "%7s %31s %31s %31s %31s %31s", fn, a, b, c[0], c[1], c[2]
            ) != 6)
            return fprintf(stderr, "bad line: %s", line), 2;
        int f = !strcmp(fn, "exp") ? 0 : !strcmp(fn, "log") ? 1 : 2;
        double x = dbl(strtoull(a, 0, 16));
        double y = f == 2 ? dbl(strtoull(b, 0, 16)) : 0;
        uint64_t want = strtoull(c[col - 4], 0, 16), got = bits(call(f, x, y));
        n[f]++;
        if (got != want) {
            if (bad[f]++ < 5)
                printf(
                    "%s %s %s: got %016llx want %016llx\n", fn, a, b,
                    (unsigned long long) got, (unsigned long long) want
                );
        }
    }
    for (int f = 0; f < 3; f++)
        printf("vectors %s %ld inputs %ld differing\n", fname[f], n[f], bad[f]);
    return bad[0] || bad[1] || bad[2];
}

static void sample(long n) {
    for (int f = 0; f < 3; f++) {
        uint64_t h = 1469598103934665603ull, hf = h;
        for (long i = 0; i < n; i++) {
            double x, y;
            switch (rnd() % 4) {
                case 0: x = uni(-745.2, 710); break;
                case 1: x = uni(0.5, 2); break;
                case 2: x = dbl(rnd() & 0x7fffffffffffffffull); break;
                default: x = dbl(rnd()); break;
            }
            if (f == 2 && x < 0 && rnd() % 8) x = -x;
            y = rnd() % 3 == 0 ? (double) ((long) (rnd() % 400) - 200)
                               : uni(-30, 30);
            feclearexcept(FE_ALL_EXCEPT);
            uint64_t r = bits(call(f, x, y));
            h = (h ^ r) * 1099511628211ull;
            hf = (hf ^ (uint64_t) fetestexcept(FE_ALL_EXCEPT)) *
                 1099511628211ull;
        }
        printf(
            "sample %s %ld hash %016llx", fname[f], n, (unsigned long long) h
        );
#ifdef __aarch64__
        printf(" flags %016llx", (unsigned long long) hf);
#endif
        printf("\n");
    }
}

/* one line per input the kernels leave to the guest */
static void refuse(void) {
    static const double xs[] = {0.0,      -0.0,   INFINITY, -INFINITY, NAN,
                                1e-300,   1e-17,  710.0,    -746.0,    -740.0,
                                4.9e-324, 1.0,    -1.0,     -2.5,      2.5,
                                1000.0,   DBL_MIN};
    static const double ys[] = {0.0, -0.0,  1.0,     0.5,      -0.5,
                                3.0, -3.0,  2.5,     INFINITY, -INFINITY,
                                NAN, 1e300, 0x1p-70, 1024.0,   -1075.0};
    for (size_t i = 0; i < sizeof xs / sizeof *xs; i++) {
        printf(
            "refuse exp %016llx %016llx\n", (unsigned long long) bits(xs[i]),
            (unsigned long long) bits(f_exp(xs[i]))
        );
        printf(
            "refuse log %016llx %016llx\n", (unsigned long long) bits(xs[i]),
            (unsigned long long) bits(f_log(xs[i]))
        );
        for (size_t j = 0; j < sizeof ys / sizeof *ys; j++)
            printf(
                "refuse pow %016llx %016llx %016llx\n",
                (unsigned long long) bits(xs[i]),
                (unsigned long long) bits(ys[j]),
                (unsigned long long) bits(f_pow(xs[i], ys[j]))
            );
    }
}

/* a rounding mode other than nearest, on inputs the kernels run in the
 * default mode: katybug rounds to nearest whatever the register holds, so
 * only kernels on against off can be compared, and every call is refused */
static void round_modes(void) {
    static const int modes[] = {FE_UPWARD, FE_DOWNWARD, FE_TOWARDZERO};
    for (size_t m = 0; m < 3; m++) {
        fesetround(modes[m]);
        printf(
            "mode %zu exp %016llx log %016llx pow %016llx\n", m,
            (unsigned long long) bits(f_exp(1.5)),
            (unsigned long long) bits(f_log(2.5)),
            (unsigned long long) bits(f_pow(2.5, 3.5))
        );
        fesetround(FE_TONEAREST);
    }
}

int main(int argc, char** argv) {
    if (argc > 1 && !strcmp(argv[1], "gen")) return gen(), 0;
    if (argc > 3 && !strcmp(argv[1], "check"))
        return check(argv[2], atoi(argv[3]));
    if (argc > 2 && !strcmp(argv[1], "sample")) return sample(atol(argv[2])), 0;
    if (argc > 1 && !strcmp(argv[1], "refuse")) return refuse(), 0;
    if (argc > 1 && !strcmp(argv[1], "round")) return round_modes(), 0;
    fprintf(
        stderr,
        "usage: libm gen | check <file> <4|5|6> | sample <n> | refuse | round\n"
    );
    return 2;
}
