/* zstd 1.5.6 compressing then decompressing generated text at level 6, no
 * imports */
#define ARENA (8u << 20)
#include "mini.h"

#include "zstd.h"

static uint8_t input[1 << 18];
static uint8_t packed[1 << 19];
static uint8_t unpacked[1 << 18];

__attribute__((export_name("run"))) uint32_t run(uint32_t n) {
    size_t len = fill_text(input, sizeof input);
    uint32_t sum = 0;
    for (uint32_t r = 0; r < n; r++) {
        used = 0;
        size_t packed_len = ZSTD_compress(packed, sizeof packed, input, len, 6);
        if (ZSTD_isError(packed_len)) return 0;
        size_t unpacked_len =
            ZSTD_decompress(unpacked, sizeof unpacked, packed, packed_len);
        if (ZSTD_isError(unpacked_len) || unpacked_len != len ||
            memcmp(unpacked, input, len))
            return 2;
        sum += (uint32_t) packed_len;
        for (size_t i = 0; i < packed_len; i += 64) sum = sum * 31 + packed[i];
    }
    return sum;
}
