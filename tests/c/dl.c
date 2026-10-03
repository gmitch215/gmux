// zlib as a side module through dlopen/dlsym; built natively against the
// same zlib (a shared library path as argv[1]) it prints the same first lines.
// In gmux, shared objects the exec registry does not hold are refused
#include <dlfcn.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

typedef const char* (*version_fn)(void);
typedef int (*compress_fn)(
    unsigned char*, unsigned long*, const unsigned char*, unsigned long, int
);
typedef int (*uncompress_fn)(
    unsigned char*, unsigned long*, const unsigned char*, unsigned long
);
typedef unsigned long (*check_fn)(
    unsigned long, const unsigned char*, unsigned int
);

static int refused(const char* path, const char* reason) {
    void* h = dlopen(path, RTLD_NOW);
    const char* e = h ? "loaded" : dlerror();
    int ok = !h && strstr(e, reason);
    printf("%s refuse %s: %s\n", ok ? "PASS" : "FAIL", path, e);
    return ok;
}

int main(int argc, char** argv) {
    void* z = dlopen(argc > 1 ? argv[1] : "libz.so", RTLD_NOW);
    if (!z) {
        printf("FAIL dlopen: %s\n", dlerror());
        return 1;
    }
    version_fn version = (version_fn) dlsym(z, "zlibVersion");
    compress_fn compress2 = (compress_fn) dlsym(z, "compress2");
    uncompress_fn uncompress = (uncompress_fn) dlsym(z, "uncompress");
    check_fn crc32 = (check_fn) dlsym(z, "crc32");
    check_fn adler32 = (check_fn) dlsym(z, "adler32");
    if (!version || !compress2 || !uncompress || !crc32 || !adler32) {
        printf("FAIL dlsym: %s\n", dlerror());
        return 1;
    }
    enum
    {
        N = 65536
    };
    static unsigned char in[N], packed[N + 1024], out[N];
    const char* words = "the quick brown fox jumps over the lazy dog ";
    for (int i = 0; i < N; i++) in[i] = words[i % 44] ^ ((i / 977) & 7);
    unsigned long packed_len = sizeof packed, out_len = sizeof out;
    int rc = compress2(packed, &packed_len, in, N, 9);
    int rc2 = uncompress(out, &out_len, packed, packed_len);
    printf("zlib %s\n", version());
    printf("crc32 %08lx\n", crc32(0, in, N));
    printf(
        "compressed %lu bytes (rc %d), adler32 %08lx\n", packed_len, rc,
        adler32(1, packed, packed_len)
    );
    printf(
        "round trip %s (rc %d)\n",
        out_len == N && !memcmp(in, out, N) ? "same" : "differs", rc2
    );
    printf(
        "%s missing symbol\n",
        !dlsym(z, "no_such_symbol") && dlerror() ? "PASS" : "FAIL"
    );
    printf("%s dlclose\n", dlclose(z) == 0 ? "PASS" : "FAIL");
    if (argc > 1) return 0;
    // a wasm side module nobody registered, and a program that is not a library
    FILE* f = fopen("/tmp/unknown.so", "wb");
    static const unsigned char fake[] = {0,   'a', 's', 'm', 1,   0,   0,
                                         0,   0,   15,  8,   'd', 'y', 'l',
                                         'i', 'n', 'k', '.', '0', 1,   4,
                                         0,   0,   0,   0};
    fwrite(fake, 1, sizeof fake, f);
    fclose(f);
    int ok = refused(
        "/tmp/unknown.so", "/tmp/unknown.so: not in the exec registry (sha256 "
    );
    ok &= refused("/tmp/unknown.so", "dl (sha256 ");
    ok &=
        refused("/tmp/unknown.so", "a Worker cannot compile code at run time");
    ok &= refused(
        "/tmp/unknown.so",
        "the interpreted tier is not available, so the next run"
    );
    ok &= refused("/no/such.so", "No such file");
    ok &= refused("/bin/dl", "an executable, not a shared library");
    return ok ? 0 : 1;
}
