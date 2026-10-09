#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>

#include "md5.h"
#include "sha1.h"
#include "sha256.h"
#include "sha512.h"

/* coreutils' own block functions over the same buffer hashbench.c uses, built
 * with the same compiler: the control the kernels' blocks are read against.
 * cksum's loop is static in src/cksum.c, so its inner loop is copied here from
 * cksum_slice8 (coreutils 9.5) */

static uint8_t buf[32768];
static uint32_t crctab[8][256];
static double now(void) {
    struct timespec t;
    clock_gettime(CLOCK_MONOTONIC, &t);
    return t.tv_sec + t.tv_nsec / 1e9;
}
static int cmp(const void* a, const void* b) {
    return (*(const double*) a > *(const double*) b) -
           (*(const double*) a < *(const double*) b);
}

/* the table cksum.c prints when built with -DCRCTAB */
static void fill_crctab(void) {
    uint32_t gen[8];
    gen[0] = (1u << 26) | (1u << 23) | (1u << 22) | (1u << 16) | (1u << 12) |
             (1u << 11) | (1u << 10) | (1u << 8) | (1u << 7) | (1u << 5) |
             (1u << 4) | (1u << 2) | (1u << 1) | 1u;
    for (int i = 1; i < 8; i++)
        gen[i] = (gen[i - 1] << 1) ^ ((gen[i - 1] & 0x80000000u) ? gen[0] : 0);
    for (int m = 0; m < 256; m++) {
        uint32_t rem = 0;
        for (int i = 0; i < 8; i++)
            if (m >> i & 1) rem ^= gen[i];
        crctab[0][m] = rem;
    }
    for (int i = 0; i < 256; i++) {
        uint32_t crc = crctab[0][i];
        for (int k = 1; k < 8; k++) {
            crc = (crc << 8) ^ crctab[0][crc >> 24];
            crctab[k][i] = crc;
        }
    }
}

/* the loop of cksum_slice8 over one buffer */
static uint32_t slice8(uint32_t crc, const uint8_t* p, size_t bytes_read) {
    uint32_t* datap = (uint32_t*) p;
    while (bytes_read >= 8) {
        uint32_t first = *datap++, second = *datap++;
        crc ^= bswap_32(first);
        second = bswap_32(second);
        crc =
            (crctab[7][(crc >> 24) & 0xFF] ^ crctab[6][(crc >> 16) & 0xFF] ^
             crctab[5][(crc >> 8) & 0xFF] ^ crctab[4][(crc) & 0xFF] ^
             crctab[3][(second >> 24) & 0xFF] ^
             crctab[2][(second >> 16) & 0xFF] ^
             crctab[1][(second >> 8) & 0xFF] ^ crctab[0][(second) & 0xFF]);
        bytes_read -= 8;
    }
    return crc;
}

#define NV 5

int main(int argc, char** argv) {
    uint32_t mib = argc > 1 ? atoi(argv[1]) : 256,
             runs = argc > 2 ? atoi(argv[2]) : 5,
             reps = mib * 1048576 / sizeof buf;
    uint32_t x = 12345;
    for (int i = 0; i < (int) sizeof buf; i++)
        buf[i] = (uint8_t) ((x = x * 1664525u + 1013904223u) >> 24);
    fill_crctab();
    double rate[NV][64];
    uint64_t fold[NV];
    for (uint32_t r = 0; r <= runs; r++)
        for (int v = 0; v < NV; v++) {
            struct sha256_ctx c256;
            struct sha1_ctx c1;
            struct md5_ctx cm;
            struct sha512_ctx c512;
            uint32_t crc = 0;
            sha256_init_ctx(&c256), sha1_init_ctx(&c1), md5_init_ctx(&cm);
            sha512_init_ctx(&c512);
            double t = now();
            for (uint32_t i = 0; i < reps; i++) {
                if (v == 0) sha256_process_block(buf, sizeof buf, &c256);
                if (v == 1) sha1_process_block(buf, sizeof buf, &c1);
                if (v == 2) md5_process_block(buf, sizeof buf, &cm);
                if (v == 3) sha512_process_block(buf, sizeof buf, &c512);
                if (v == 4) crc = slice8(crc, buf, sizeof buf);
            }
            t = now() - t;
            if (r) rate[v][r - 1] = mib * 1.048576 / t;
            fold[v] = v == 0   ? c256.state[0] ^ c256.state[7]
                      : v == 1 ? c1.A ^ c1.E
                      : v == 2 ? cm.A ^ cm.D
                      : v == 3 ? c512.state[0] ^ c512.state[7]
                               : crc;
        }
    const char* names[NV] = {"sha256", "sha1", "md5", "sha512", "cksum"};
    for (int v = 0; v < NV; v++) {
        qsort(rate[v], runs, sizeof **rate, cmp);
        printf(
            "gnulib %s\t%.1f\t%.1f-%.1f\t%08x\n", names[v], rate[v][runs / 2],
            rate[v][0], rate[v][runs - 1], (unsigned) fold[v]
        );
    }
    return 0;
}
