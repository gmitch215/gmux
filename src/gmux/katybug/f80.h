#ifndef F80_H
#define F80_H

#include <stdint.h>

/** the x87 80-bit extended format: an explicit integer bit in sig, sign and
 * 15-bit exponent in se */
typedef struct {
    uint64_t sig;
    uint16_t se;
} f80;

int f80_isnan(f80 a);
int f80_isinf(f80 a);
int f80_iszero(f80 a);
/* rc is the x87 rounding control: 0 nearest, 1 down, 2 up, 3 toward zero */
f80 f80_add(f80 a, f80 b, int negate_b, int rc);
f80 f80_mul(f80 a, f80 b, int rc);
f80 f80_div(f80 a, f80 b, int rc, int* zerodiv);
f80 f80_sqrt(f80 a, int rc);
int f80_cmp(f80 a, f80 b);
f80 f80_from_i64(int64_t v);
int64_t f80_to_i64(f80 a, int rc, int bits, int* overflow);
/* IEEE binary formats: 23/8 for float, 52/11 for double */
f80 f80_from_bits(uint64_t bits, int fbits, int ebits);
uint64_t f80_to_bits(f80 a, int fbits, int ebits, int rc);
f80 f80_round_int(f80 a, int rc);
f80 f80_scale(f80 a, f80 b, int rc);
extern int f80_c1;
f80 f80_rem(f80 a, f80 b, int nearest, int* q);

#endif
