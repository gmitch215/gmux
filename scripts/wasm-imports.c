/* prints the field name of every import (or, with --exports, every function
 * export) of a wasm module, one per line; cc-strict builds it with the host cc,
 * since the toolchain image has no interpreter gmux can count on */
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

static unsigned char* b;
static size_t len;

static size_t leb(size_t* i) {
    size_t v = 0;
    int shift = 0;
    unsigned char byte;
    do {
        if (*i >= len) exit(1);
        byte = b[(*i)++];
        v |= (size_t) (byte & 0x7f) << shift;
        shift += 7;
    } while (byte & 0x80);
    return v;
}

/* a name: printed when `print`, skipped otherwise */
static void name(size_t* i, int print) {
    size_t n = leb(i);
    if (*i + n > len) exit(1);
    if (print) printf("%.*s\n", (int) n, (const char*) b + *i);
    *i += n;
}

int main(int argc, char** argv) {
    int exports = argc > 2 && !strcmp(argv[1], "--exports");
    FILE* f = fopen(argv[argc - 1], "rb");
    if (argc < 2 || !f) return 2;
    fseek(f, 0, SEEK_END);
    len = (size_t) ftell(f);
    fseek(f, 0, SEEK_SET);
    b = malloc(len ? len : 1);
    if (fread(b, 1, len, f) != len || len < 8 || memcmp(b, "\0asm", 4)) {
        fprintf(stderr, "not wasm\n");
        return 1;
    }
    for (size_t i = 8; i < len;) {
        unsigned char id = b[i++];
        size_t size = leb(&i), end = i + size;
        if (id == 2 && !exports) {
            for (size_t n = leb(&i); n--;) {
                name(&i, 0);
                name(&i, 1);
                unsigned char kind = b[i++];
                if (kind == 0)
                    leb(&i);
                else if (kind == 1 || kind == 2) {
                    if (kind == 1) i++;
                    size_t flags = leb(&i);
                    leb(&i);
                    if (flags & 1) leb(&i);
                }
                else if (kind == 3)
                    i += 2;
                else if (kind == 4) {
                    i++;
                    leb(&i);
                }
            }
        }
        if (id == 7 && exports) {
            for (size_t n = leb(&i); n--;) {
                size_t at = i;
                name(&i, 0);
                unsigned char kind = b[i++];
                leb(&i);
                if (kind == 0) {
                    size_t again = at;
                    name(&again, 1);
                }
            }
        }
        i = end;
    }
    return 0;
}
