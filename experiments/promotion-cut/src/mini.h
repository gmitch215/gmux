/*
 * the libc a compression guest needs and nothing else: an arena malloc that
 * run() resets each iteration, byte-loop memory routines (built with
 * -fno-builtin -mno-bulk-memory so wasm3 and the native side's rebasing both
 * stay simple), and the same generated text the promotion ladder deflates
 */
#include <stddef.h>
#include <stdint.h>

void* memcpy(void* dst, const void* src, size_t n) {
    uint8_t* d = dst;
    const uint8_t* s = src;
    while (n--) *d++ = *s++;
    return dst;
}

void* memmove(void* dst, const void* src, size_t n) {
    uint8_t* d = dst;
    const uint8_t* s = src;
    if (d < s)
        while (n--) *d++ = *s++;
    else
        while (n--) d[n] = s[n];
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

static uint8_t arena[ARENA];
static size_t used;

void* malloc(size_t n) {
    n = (n + 15) & ~(size_t) 15;
    if (used + n > sizeof arena) return 0;
    void* p = arena + used;
    used += n;
    return p;
}

void* calloc(size_t a, size_t b) {
    void* p = malloc(a * b);
    if (p) memset(p, 0, a * b);
    return p;
}

void free(void* p) {
    (void) p;
}

static size_t fill_text(uint8_t* buf, size_t cap) {
    static const char* words[] = {"the ",   "quick ", "brown ", "fox ",
                                  "jumps ", "over ",  "lazy ",  "dog ",
                                  "and ",   "runs ",  "away ",  "from ",
                                  "a ",     "cat ",   "who ",   "sleeps "};
    uint32_t x = 2463534242u;
    size_t len = 0;
    while (len < cap - 8) {
        x ^= x << 13;
        x ^= x >> 17;
        x ^= x << 5;
        for (const char* w = words[x & 15]; *w && len < cap; w++)
            buf[len++] = (uint8_t) *w;
        if ((x >> 8) % 11 == 0) buf[len++] = '\n';
    }
    return len;
}
