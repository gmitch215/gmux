/* bzip2 1.0.8 compressing then decompressing generated text, no imports */
#define ARENA (16u << 20)
#include "mini.h"

#include "bzlib.h"

void bz_internal_error(int code) {
    (void) code;
    __builtin_trap();
}

static uint8_t input[1 << 18];
static uint8_t packed[1 << 19];
static uint8_t unpacked[1 << 18];

__attribute__((export_name("run"))) uint32_t run(uint32_t n) {
    size_t len = fill_text(input, sizeof input);
    uint32_t sum = 0;
    for (uint32_t r = 0; r < n; r++) {
        used = 0;
        unsigned packed_len = sizeof packed;
        if (BZ2_bzBuffToBuffCompress(
                (char*) packed, &packed_len, (char*) input, (unsigned) len, 5,
                0, 0
            ) != BZ_OK)
            return 0;
        unsigned unpacked_len = sizeof unpacked;
        if (BZ2_bzBuffToBuffDecompress(
                (char*) unpacked, &unpacked_len, (char*) packed, packed_len, 0,
                0
            ) != BZ_OK)
            return 1;
        if (unpacked_len != len || memcmp(unpacked, input, len)) return 2;
        sum += packed_len;
        for (unsigned i = 0; i < packed_len; i += 64)
            sum = sum * 31 + packed[i];
    }
    return sum;
}
