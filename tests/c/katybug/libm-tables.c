#include <stdint.h>
#include <stdio.h>
#include <string.h>

/* one line per table of exp, log and pow: a hash of its values, whichever
 * source defines them (glibc's math_config.h, musl's *_data.h, or the
 * kernel's libm.h, selected by -DFROM_GLIBC, -DFROM_MUSL or -DFROM_KERNEL),
 * so the lines of three builds can be compared */
#if defined(FROM_KERNEL)
    #include "../../../src/gmux/katybug/libm.h"
    #define EXP kb_exp_data
    #define LOG kb_log_data
    #define POW kb_pow_log_data
#else
    #if defined(FROM_GLIBC)
        #include "math_config.h"
    #else
        #include "exp_data.h"
        #include "log_data.h"
        #include "pow_data.h"
    #endif
    #define EXP __exp_data
    #define LOG __log_data
    #define POW __pow_log_data
#endif

static uint64_t fnv(const void* p, size_t n, uint64_t h) {
    const uint8_t* b = p;
    for (size_t i = 0; i < n; i++) h = (h ^ b[i]) * 0x100000001b3ull;
    return h;
}

static void put(uint64_t* h, double v) {
    *h = fnv(&v, sizeof v, *h);
}

#define START 0xcbf29ce484222325ull

int main(void) {
    uint64_t h = START;
    put(&h, EXP.invln2N), put(&h, EXP.shift), put(&h, EXP.negln2hiN);
    put(&h, EXP.negln2loN);
    for (int i = 0; i < 4; i++) put(&h, EXP.poly[i]);
    put(&h, EXP.exp2_shift);
    for (int i = 0; i < 5; i++) put(&h, EXP.exp2_poly[i]);
    printf("exp.consts %016llx\n", (unsigned long long) h);
    h = fnv(EXP.tab, sizeof EXP.tab, START);
    printf("exp.tab %016llx\n", (unsigned long long) h);

    h = START;
    put(&h, LOG.ln2hi), put(&h, LOG.ln2lo);
    for (int i = 0; i < 5; i++) put(&h, LOG.poly[i]);
    for (int i = 0; i < 11; i++) put(&h, LOG.poly1[i]);
    printf("log.consts %016llx\n", (unsigned long long) h);
    h = START;
    for (int i = 0; i < 128; i++)
        put(&h, LOG.tab[i].invc), put(&h, LOG.tab[i].logc);
    printf("log.tab %016llx\n", (unsigned long long) h);
    h = START;
    for (int i = 0; i < 128; i++)
        put(&h, LOG.tab2[i].chi), put(&h, LOG.tab2[i].clo);
    printf("log.tab2 %016llx\n", (unsigned long long) h);

    h = START;
    put(&h, POW.ln2hi), put(&h, POW.ln2lo);
    for (int i = 0; i < 7; i++) put(&h, POW.poly[i]);
    printf("pow.consts %016llx\n", (unsigned long long) h);
    h = START;
    for (int i = 0; i < 128; i++) {
        put(&h, POW.tab[i].invc), put(&h, POW.tab[i].pad);
        put(&h, POW.tab[i].logc), put(&h, POW.tab[i].logctail);
    }
    printf("pow.tab %016llx\n", (unsigned long long) h);
    return 0;
}
