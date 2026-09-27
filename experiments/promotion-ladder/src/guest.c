/*
 * the promotion ladder's guest: zlib's deflate over generated text, with the
 * arena, memcpy and memset zlib needs and no imports, so wasm3 and V8 run the
 * same module
 */
#include <stddef.h>
#include <stdint.h>

#include "zlib.h"

void* memcpy(void* dst, const void* src, size_t n) {
    uint8_t* d = dst;
    const uint8_t* s = src;
    while (n--) *d++ = *s++;
    return dst;
}

void* memset(void* dst, int c, size_t n) {
    uint8_t* d = dst;
    while (n--) *d++ = (uint8_t) c;
    return dst;
}

int memcmp(const void* a, const void* b, size_t n) {
    const uint8_t *x = a, *y = b;
    for (; n; n--, x++, y++)
        if (*x != *y) return *x - *y;
    return 0;
}

size_t strlen(const char* s) {
    size_t n = 0;
    while (s[n]) n++;
    return n;
}

static uint8_t arena[1 << 20];
static size_t used;

static voidpf zalloc(voidpf opaque, uInt items, uInt size) {
    (void) opaque;
    size_t n = ((size_t) items * size + 15) & ~(size_t) 15;
    if (used + n > sizeof arena) return Z_NULL;
    void* p = arena + used;
    used += n;
    return p;
}

static void zfree(voidpf opaque, voidpf p) {
    (void) opaque;
    (void) p;
}

static uint8_t input[1 << 19];
static uint8_t output[1 << 20];

/* deflates 512 KiB of generated text at level 6, n times; the compressed bytes'
 * Adler-32 */
__attribute__((export_name("run"))) uint32_t run(uint32_t n) {
    static const char* words[] = {"the ",   "quick ", "brown ", "fox ",
                                  "jumps ", "over ",  "lazy ",  "dog ",
                                  "and ",   "runs ",  "away ",  "from ",
                                  "a ",     "cat ",   "who ",   "sleeps "};
    uint32_t x = 2463534242u;
    size_t len = 0;
    while (len < sizeof input - 8) {
        x ^= x << 13;
        x ^= x >> 17;
        x ^= x << 5;
        for (const char* w = words[x & 15]; *w && len < sizeof input; w++)
            input[len++] = (uint8_t) *w;
        if ((x >> 8) % 11 == 0) input[len++] = '\n';
    }
    uint32_t sum = 0;
    for (uint32_t r = 0; r < n; r++) {
        used = 0;
        z_stream s = {0};
        s.zalloc = zalloc;
        s.zfree = zfree;
        if (deflateInit(&s, 6) != Z_OK) return 0;
        s.next_in = input;
        s.avail_in = (uInt) len;
        s.next_out = output;
        s.avail_out = sizeof output;
        if (deflate(&s, Z_FINISH) != Z_STREAM_END) return 1;
        sum += (uint32_t) adler32(1, output, (uInt) s.total_out) +
               (uint32_t) s.total_out;
        deflateEnd(&s);
    }
    return sum;
}
