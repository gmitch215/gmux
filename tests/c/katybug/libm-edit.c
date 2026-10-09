#define _GNU_SOURCE
#include <dlfcn.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

/* libm-edit <libm.so.6> <out>: a copy of an AArch64 libm with one bit of each
 * of exp, log and pow changed, the immediate of the first `movi d0, #0` after
 * its entry, which only alters what a call returns on the special inputs that
 * reach it: a build the kernels were not checked against */
int main(int argc, char** argv) {
    if (argc < 3) return fprintf(stderr, "usage: libm-edit <in> <out>\n"), 2;
    FILE* f = fopen(argv[1], "rb");
    if (!f) return perror(argv[1]), 1;
    fseek(f, 0, SEEK_END);
    long size = ftell(f);
    rewind(f);
    uint8_t* b = malloc((size_t) size);
    if (!b || fread(b, 1, (size_t) size, f) != (size_t) size) return 1;
    fclose(f);
    void* h = dlopen(argv[1][0] == '/' ? argv[1] : "libm.so.6", RTLD_NOW);
    if (!h) return fprintf(stderr, "dlopen: %s\n", dlerror()), 1;
    Dl_info di;
    uint64_t phoff, phnum;
    memcpy(&phoff, b + 32, 8);
    phnum = b[56] | b[57] << 8;
    static const char* const names[] = {"exp", "log", "pow"};
    for (int i = 0; i < 3; i++) {
        void* fn = dlsym(h, names[i]);
        if (!fn || !dladdr(fn, &di))
            return fprintf(stderr, "%s?\n", names[i]), 1;
        uint64_t va = (uint64_t) fn - (uint64_t) di.dli_fbase, at = 0;
        for (uint64_t p = 0; p < phnum; p++) {
            uint8_t* ph = b + phoff + p * 56;
            uint32_t type;
            uint64_t off, vaddr, filesz;
            memcpy(&type, ph, 4);
            memcpy(&off, ph + 8, 8);
            memcpy(&vaddr, ph + 16, 8);
            memcpy(&filesz, ph + 32, 8);
            if (type == 1 && va >= vaddr && va < vaddr + filesz)
                at = va - vaddr + off;
        }
        int done = 0;
        for (uint64_t k = at; at && k < at + 1600 && !done; k += 4) {
            uint32_t w;
            memcpy(&w, b + k, 4);
            if (w == 0x2f00e400) b[k + 2] ^= 1, done = 1;
        }
        if (!done) return fprintf(stderr, "%s: no movi d0, #0\n", names[i]), 1;
    }
    FILE* o = fopen(argv[2], "wb");
    if (!o || fwrite(b, 1, (size_t) size, o) != (size_t) size) return 1;
    return fclose(o) != 0;
}
