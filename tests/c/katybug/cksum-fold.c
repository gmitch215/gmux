/* kb_cksum_fast against the slice-by-8 kernel over a table built the way
 * coreutils' cksum.c builds crctab: every length of 0 to 300 groups of 8 bytes
 * from several start values and offsets, and some long buffers; kb_cksum_canon
 * on the table, on one entry changed in each row's first and last place, and on
 * a table whose rows are all the same. Prints the step in use.
 * usage: cksum-fold (exit 0 when every check holds) */
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "../../../src/gmux/katybug/kb.h"

static uint32_t tab[8][256];

static void build(void) {
    uint32_t r[8], gen = 0x04c11db7u;
    r[0] = gen;
    for (int i = 1; i < 8; i++)
        r[i] = r[i - 1] << 1 ^ (r[i - 1] >> 31 ? gen : 0);
    for (int i = 0; i < 256; i++) {
        uint32_t rem = 0;
        for (int b = 0; b < 8; b++)
            if (i >> b & 1) rem ^= r[b];
        tab[0][i] = rem;
    }
    for (int i = 0; i < 256; i++) {
        uint32_t crc = tab[0][i];
        for (int k = 1; k < 8; k++) {
            crc = crc << 8 ^ tab[0][crc >> 24];
            tab[k][i] = crc;
        }
    }
}

static uint32_t byte_at_a_time(uint32_t crc, const uint8_t* p, size_t n) {
    while (n--) crc = crc << 8 ^ tab[0][(crc >> 24 ^ *p++) & 255];
    return crc;
}

int main(void) {
    build();
    int fail = 0;
    size_t big = 5u << 20;
    uint8_t* buf = malloc(big + 64);
    srand(7);
    for (size_t i = 0; i < big + 64; i++) buf[i] = (uint8_t) (rand() >> 7);
    if (!kb_cksum_canon((const uint8_t*) tab))
        puts("FAIL canon table refused"), fail++;
    uint32_t starts[] = {0, 1, 0x80000000u, 0xdeadbeefu, 0xffffffffu};
    for (int s = 0; s < 5; s++)
        for (size_t off = 0; off < 3; off++)
            for (size_t n = 0; n <= 300; n++) {
                const uint8_t* p = buf + off * 5 + 3;
                uint32_t want =
                    kb_cksum_blocks(starts[s], (const uint8_t*) tab, p, n);
                uint32_t got = kb_cksum_fast(starts[s], p, n);
                if (want != got ||
                    want != byte_at_a_time(starts[s], p, n * 8)) {
                    printf(
                        "FAIL length %zu groups start %08x offset %zu: %08x "
                        "%08x\n",
                        n, starts[s], off, want, got
                    );
                    fail++;
                }
            }
    size_t longs[] = {1000, 4096, 8192, 65536, 100003, big / 8 - 1};
    for (int i = 0; i < 6; i++) {
        uint32_t want = kb_cksum_blocks(
            0x12345678, (const uint8_t*) tab, buf + 1, longs[i]
        );
        uint32_t got = kb_cksum_fast(0x12345678, buf + 1, longs[i]);
        if (want != got)
            printf("FAIL long %zu: %08x %08x\n", longs[i], want, got), fail++;
    }
    for (int k = 0; k < 8; k++)
        for (int e = 0; e < 2; e++) {
            int i = e ? 255 : 0;
            tab[k][i] ^= 1;
            if (kb_cksum_canon((const uint8_t*) tab))
                printf("FAIL canon accepted row %d entry %d changed\n", k, i),
                    fail++;
            tab[k][i] ^= 1;
        }
    if (!kb_cksum_canon((const uint8_t*) tab))
        puts("FAIL canon table refused after restore"), fail++;
    for (int k = 1; k < 8; k++) memcpy(tab[k], tab[0], sizeof tab[0]);
    if (kb_cksum_canon((const uint8_t*) tab))
        puts("FAIL canon accepted equal rows"), fail++;
    printf("step %s, %s\n", kb_cksum_path(), fail ? "FAIL" : "ok");
    return fail != 0;
}
