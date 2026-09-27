#include <stdio.h>
#include <stdlib.h>

#include "wasm3.h"

/* wasm3-native <module.wasm> <export> <n>: calls export(n) and prints it as
 * katybug --wasm does */
int main(int argc, char** argv) {
    if (argc < 4) {
        fprintf(stderr, "usage: wasm3-native <module.wasm> <export> <n>\n");
        return 2;
    }
    FILE* f = fopen(argv[1], "rb");
    if (!f) return 1;
    fseek(f, 0, SEEK_END);
    long len = ftell(f);
    fseek(f, 0, SEEK_SET);
    uint8_t* bytes = malloc((size_t) len);
    if (!bytes || fread(bytes, 1, (size_t) len, f) != (size_t) len) return 1;
    fclose(f);
    IM3Environment env = m3_NewEnvironment();
    IM3Runtime rt = m3_NewRuntime(env, 8 << 20, NULL);
    IM3Module mod;
    IM3Function fn;
    M3Result err = m3_ParseModule(env, &mod, bytes, (uint32_t) len);
    if (!err) err = m3_LoadModule(rt, mod);
    if (!err) err = m3_FindFunction(&fn, rt, argv[2]);
    uint32_t n = (uint32_t) strtoul(argv[3], NULL, 16), result = 0;
    if (!err) err = m3_CallV(fn, n);
    if (!err) err = m3_GetResultsV(fn, &result);
    if (err) {
        fprintf(stderr, "wasm3-native: %s\n", err);
        return 1;
    }
    printf("%s(%x) = %x\n", argv[2], n, result);
    return 0;
}
