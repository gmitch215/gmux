#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <zlib.h>

/* the guest's libz through the loader's slots: crc32, adler32, compress2 and
 * uncompress. bytes: the deflate output over a 4 MiB corpus at levels 1, 6 and
 * 9, as a length and a hash (what two zlib builds are compared by); check: the
 * calls' results, edge cases and refusals included; run <op> <iters>: crc,
 * adl, def or inf over the corpus, for the timing. katybug's output must be
 * the same with its kernels on and off */

static uLong (*volatile f_crc)(uLong, const Bytef*, uInt) = crc32;
static uLong (*volatile f_adl)(uLong, const Bytef*, uInt) = adler32;
static int (*volatile f_def)(Bytef*, uLongf*, const Bytef*, uLong, int) =
    compress2;
static int (*volatile f_inf)(Bytef*, uLongf*, const Bytef*, uLong) = uncompress;

static uint64_t seed = 88172645463325252ull;
static uint64_t rnd(void) {
    seed ^= seed << 13, seed ^= seed >> 7, seed ^= seed << 17;
    return seed;
}

static uint64_t fnv(const void* p, size_t n) {
    const uint8_t* b = p;
    uint64_t h = 1469598103934665603ull;
    for (size_t i = 0; i < n; i++) h = (h ^ b[i]) * 1099511628211ull;
    return h;
}

#define CORPUS (4u << 20)

/* shape 0: text-like words, runs and random bytes in blocks, so every level
 * has matches to find and some data it cannot shrink; 1: zeros; 2: random
 * bytes (stored blocks); 3: words only */
static uint8_t* corpus(size_t n, int shape) {
    static const char* const words[] = {
        "the ",      "of ",     "and ",    "to ",     "in ",
        "kernel ",   "memory ", "thread ", "page ",   "guest ",
        "host ",     "call ",   "byte ",   "return ", "value ",
        "function ", "stream ", "window ", "table ",  "block "
    };
    uint8_t* b = calloc(n, 1);
    for (size_t at = 0; at < n && shape != 1;) {
        size_t len = 512 + rnd() % 3584;
        if (len > n - at) len = n - at;
        switch (shape == 2 ? 3 : shape == 3 ? 0 : rnd() % 4) {
            case 0:
            case 1:
                for (size_t i = 0; i < len;) {
                    const char* w = words[rnd() % 20];
                    for (; *w && i < len; i++) b[at + i] = (uint8_t) *w++;
                }
                break;
            case 2: memset(b + at, (int) (rnd() & 0xff), len); break;
            default:
                for (size_t i = 0; i < len; i++) b[at + i] = (uint8_t) rnd();
        }
        at += len;
    }
    return b;
}

static void bytes(void) {
    static const char* const shapes[] = {"mixed", "zeros", "random", "text"};
    uLongf cap = compressBound(CORPUS);
    uint8_t* out = malloc(cap);
    uint8_t* back = malloc(CORPUS);
    static const int levels[] = {1, 6, 9};
    for (int s = 0; s < 4; s++) {
        uint8_t* in = corpus(CORPUS, s);
        for (int i = 0; i < 3; i++) {
            uLongf n = cap;
            int rc = f_def(out, &n, in, CORPUS, levels[i]);
            uLongf m = CORPUS;
            int rc2 = f_inf(back, &m, out, n);
            printf(
                "compress2 %s level %d rc %d len %lu hash %016llx; "
                "uncompress rc %d %s\n",
                shapes[s], levels[i], rc, (unsigned long) n,
                (unsigned long long) fnv(out, n), rc2,
                m == CORPUS && !memcmp(back, in, CORPUS) ? "same" : "differs"
            );
        }
        free(in);
    }
}

static void line(
    const char* what, int rc, uLongf n, const void* p, size_t len
) {
    printf(
        "%s rc %d len %lu hash %016llx\n", what, rc, (unsigned long) n,
        (unsigned long long) fnv(p, len)
    );
}

static void check(void) {
    uint8_t* in = corpus(300000, 0);
    char name[96];
    /* sums: lengths either side of the small and large cases, unaligned starts,
     * a running value, an init above 32 bits, and a null buffer */
    static const size_t lens[] = {1,    2,    3,    7,     8,     15,  16,
                                  17,   63,   64,   65,    255,   256, 4095,
                                  5551, 5552, 5553, 65536, 100003};
    for (size_t i = 0; i < sizeof lens / sizeof *lens; i++)
        for (int off = 0; off < 3; off++) {
            printf(
                "crc32 n=%zu off=%d %08lx adler32 %08lx\n", lens[i], off,
                f_crc(0, in + off, (uInt) lens[i]),
                f_adl(1, in + off, (uInt) lens[i])
            );
        }
    uLong c = 0, a = 1;
    for (int i = 0; i < 50; i++) {
        c = f_crc(c, in + i * 1000, 1000);
        a = f_adl(a, in + i * 1000, 1000);
    }
    printf("crc32 running %08lx adler32 running %08lx\n", c, a);
    printf(
        "crc32 init %08lx adler32 init %08lx\n", f_crc(0xdeadbeefUL, in, 777),
        f_adl(0xfffefffdUL, in, 777)
    );
    printf(
        "crc32 null %lu adler32 null %lu crc32 zero %08lx\n", f_crc(5, NULL, 0),
        f_adl(5, NULL, 0), f_crc(0x12345678, in, 0)
    );
    /* compress2: every level, a buffer that is too small, a bad level, empty */
    uLongf cap = compressBound(100000);
    uint8_t* out = malloc(cap + 64);
    for (int level = -1; level <= 10; level++) {
        memset(out, 0xa5, cap + 64);
        uLongf n = cap;
        int rc = f_def(out, &n, in, 100000, level);
        snprintf(name, sizeof name, "compress2 level %d", level);
        line(name, rc, n, out, cap + 64);
    }
    static const uLongf small[] = {1, 10, 100, 1000, 40000};
    for (size_t i = 0; i < sizeof small / sizeof *small; i++) {
        memset(out, 0xa5, cap + 64);
        uLongf n = small[i];
        int rc = f_def(out, &n, in, 100000, 6);
        snprintf(
            name, sizeof name, "compress2 dest %lu", (unsigned long) small[i]
        );
        line(name, rc, n, out, cap + 64);
    }
    memset(out, 0xa5, cap + 64);
    uLongf n0 = cap;
    int rc0 = f_def(out, &n0, in, 0, 6);
    line("compress2 empty", rc0, n0, out, cap + 64);
    n0 = 0;
    rc0 = f_def(out, &n0, in, 10, 6);
    line("compress2 dest 0", rc0, n0, out, cap + 64);
    /* uncompress: good data, a short dest, damaged and truncated input */
    uLongf zn = cap;
    f_def(out, &zn, in, 100000, 6);
    uint8_t* z = malloc(zn);
    memcpy(z, out, zn);
    uint8_t* back = malloc(100064);
    for (int variant = 0; variant < 6; variant++) {
        memset(back, 0x5a, 100064);
        uLongf n = 100000;
        uLong src = zn;
        uint8_t* data = z;
        uint8_t* bad = malloc(zn);
        memcpy(bad, z, zn);
        if (variant == 1) n = 50000;
        if (variant == 2) bad[zn / 2] ^= 0x40, data = bad;
        if (variant == 3) src = zn / 2;
        if (variant == 4) bad[0] = 0, data = bad;
        if (variant == 5) n = 100064;
        int rc = f_inf(back, &n, data, src);
        snprintf(name, sizeof name, "uncompress variant %d", variant);
        line(name, rc, n, back, 100064);
        free(bad);
    }
    uLongf en = 0;
    int erc = f_inf(back, &en, z, 0);
    printf("uncompress empty rc %d len %lu\n", erc, (unsigned long) en);
}

/* the corpus from a file when there is one (generating it costs katybug more
 * than the timed calls) */
static uint8_t* load(const char* path) {
    uint8_t* b = malloc(CORPUS);
    FILE* f = fopen(path, "rb");
    if (!f || fread(b, 1, CORPUS, f) != CORPUS) exit(2);
    fclose(f);
    return b;
}

static void run(const char* op, long iters, const char* path) {
    uint8_t* in = path ? load(path) : corpus(CORPUS, 0);
    uLongf cap = compressBound(1u << 20);
    uint8_t* out = malloc(cap);
    uint8_t* back = malloc(1u << 20);
    uLongf zn = cap;
    f_def(out, &zn, in, 1u << 20, 6);
    uint64_t sum = 0;
    for (long i = 0; i < iters; i++) {
        if (!strcmp(op, "crc"))
            sum += f_crc((uLong) i, in, CORPUS);
        else if (!strcmp(op, "adl"))
            sum += f_adl((uLong) i, in, CORPUS);
        else if (!strcmp(op, "def")) {
            uLongf n = cap;
            f_def(out, &n, in + (i & 7) * 4096, 1u << 20, 6);
            sum += n;
        }
        else {
            uLongf n = 1u << 20;
            f_inf(back, &n, out, zn);
            sum += n + back[i & 1023];
        }
    }
    printf("%s %ld %llu\n", op, iters, (unsigned long long) sum);
}

int main(int argc, char** argv) {
    if (argc > 1 && !strcmp(argv[1], "bytes")) return bytes(), 0;
    if (argc > 1 && !strcmp(argv[1], "check")) return check(), 0;
    if (argc > 2 && !strcmp(argv[1], "corpus")) {
        FILE* f = fopen(argv[2], "wb");
        uint8_t* b = corpus(CORPUS, 0);
        return !f || fwrite(b, 1, CORPUS, f) != CORPUS || fclose(f);
    }
    if (argc > 3 && !strcmp(argv[1], "run"))
        return run(argv[2], atol(argv[3]), argc > 4 ? argv[4] : NULL), 0;
    fprintf(
        stderr, "usage: zbench bytes | check | corpus <file> | run "
                "crc|adl|def|inf <iters> [corpus]\n"
    );
    return 2;
}
