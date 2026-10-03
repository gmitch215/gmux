#include <stdio.h>
#include <stdlib.h>
#include <string.h>

/* bench op n iters: iters calls of libc's memcpy (c), an overlapping memmove
 * (m) or memset (s) over n bytes, through the loader's slot, and a checksum so
 * the output says the work was done */

static void* (*volatile cp)(void*, const void*, size_t) = memcpy;
static void* (*volatile mv)(void*, const void*, size_t) = memmove;
static void* (*volatile st)(void*, int, size_t) = memset;

int main(int argc, char** argv) {
    if (argc != 4) {
        fprintf(stderr, "usage: bench c|m|s n iters\n");
        return 2;
    }
    char op = argv[1][0];
    size_t n = strtoull(argv[2], 0, 0), iters = strtoull(argv[3], 0, 0);
    unsigned char* b = malloc(2 * n + 4096);
    for (size_t i = 0; i < 2 * n + 4096; i++) b[i] = (unsigned char) (i * 7);
    unsigned long sum = 0;
    for (size_t i = 0; i < iters; i++) {
        if (op == 'c')
            cp(b + n + 64, b + 16, n);
        else if (op == 'm')
            mv(b + 24, b + 16, n);
        else
            st(b + 16, (int) i, n);
        sum += b[16 + (i % n)] + b[n + 64 + (i & 7)];
        b[16 + (i & 63)] = (unsigned char) sum;
    }
    printf("%lu\n", sum);
    return 0;
}
