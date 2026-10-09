#ifndef KB_LIBM_H
#define KB_LIBM_H

#include <stdint.h>

#define EXP_TABLE_BITS 7
#define EXP_POLY_ORDER 5
#define EXP_USE_TOINT_NARROW 0
#define EXP2_POLY_ORDER 5
#define LOG_TABLE_BITS 7
#define LOG_POLY_ORDER 6
#define LOG_POLY1_ORDER 12
#define POW_LOG_TABLE_BITS 7
#define POW_LOG_POLY_ORDER 8

extern const struct kb_exp_data {
    double invln2N;
    double shift;
    double negln2hiN;
    double negln2loN;
    double poly[4];
    double exp2_shift;
    double exp2_poly[EXP2_POLY_ORDER];
    uint64_t tab[2 * (1 << EXP_TABLE_BITS)];
} kb_exp_data;

extern const struct kb_log_data {
    double ln2hi;
    double ln2lo;
    double poly[LOG_POLY_ORDER - 1];
    double poly1[LOG_POLY1_ORDER - 1];
    struct {
        double invc, logc;
    } tab[1 << LOG_TABLE_BITS];
    struct {
        double chi, clo;
    } tab2[1 << LOG_TABLE_BITS];
} kb_log_data;

extern const struct kb_pow_log_data {
    double ln2hi;
    double ln2lo;
    double poly[POW_LOG_POLY_ORDER - 1];
    struct {
        double invc, pad, logc, logctail;
    } tab[1 << POW_LOG_TABLE_BITS];
} kb_pow_log_data;

/* how the guest's libm was compiled: without a fused multiply-add (x86-64),
 * with one at the sites the source writes as fma (musl on AArch64, built with
 * -ffp-contract=off), and glibc 2.36 on AArch64 (Debian 12), where gcc fused
 * more than that and rounds a tie in the argument reduction away from zero */
enum
{
    KB_LIBM_X86,
    KB_LIBM_MUSL_A64,
    KB_LIBM_GLIBC_A64
};

/* exp, log and pow as glibc and musl compute them in the normal cases. Each
 * returns 1 with the value in *out, or 0 for an input or a result outside
 * them (non-finite, zero, subnormal, a result that would set errno or raise
 * underflow or overflow, an exact tie in the argument reduction except for
 * KB_LIBM_GLIBC_A64), where the caller runs the guest's own code */
int kb_libm_exp(double x, int flavor, double* out);
int kb_libm_log(double x, int flavor, double* out);
int kb_libm_pow(double x, double y, int flavor, double* out);
/* 1 when a*b + c is rounded twice here, as the kernels need */
int kb_libm_ok(void);

#endif
