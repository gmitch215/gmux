/*
 * integer guests for the interpreter topology arms: no floats, no imports and
 * no memory.grow, so wasm3, Katybug's wasm frontend and V8 all run the same
 * module. Each export takes a work count and returns a checksum the arms
 * compare
 */
#include <stdint.h>

#define EXPORT(name) __attribute__((export_name(#name)))

static uint32_t buf[1 << 14];
static uint8_t sieve_bits[1 << 20];
static int32_t arr[1 << 14];
static int32_t ma[32 * 32], mb[32 * 32], mc[32 * 32];
static uint32_t crc_table[256];

/* a dependent multiply-add chain: no instruction-level parallelism for the host
 */
EXPORT(chain) uint32_t chain(uint32_t n) {
    uint32_t acc = 1;
    for (uint32_t i = 0; i < n; i++) acc = acc * 3 + 7;
    return acc;
}

/* table-driven CRC-32 over 64 KiB, n passes */
EXPORT(crc32) uint32_t crc32(uint32_t n) {
    for (uint32_t i = 0; i < 256; i++) {
        uint32_t c = i;
        for (int k = 0; k < 8; k++) c = c & 1 ? 0xedb88320u ^ (c >> 1) : c >> 1;
        crc_table[i] = c;
    }
    const uint8_t* p = (const uint8_t*) buf;
    for (uint32_t i = 0; i < sizeof buf; i++)
        ((uint8_t*) buf)[i] = (uint8_t) (i * 131 + 7);
    uint32_t crc = 0xffffffffu;
    for (uint32_t r = 0; r < n; r++)
        for (uint32_t i = 0; i < sizeof buf; i++)
            crc = crc_table[(crc ^ p[i]) & 0xff] ^ (crc >> 8);
    return ~crc;
}

#define ROR(x, n) (((x) >> (n)) | ((x) << (32 - (n))))

/* SHA-256's compression function, n rounds chained through its own state */
EXPORT(sha256) uint32_t sha256(uint32_t n) {
    static const uint32_t k[64] = {
        0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1,
        0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3,
        0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786,
        0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
        0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147,
        0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
        0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b,
        0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
        0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a,
        0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
        0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2
    };
    uint32_t h[8] = {0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
                     0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19};
    uint32_t w[64];
    for (uint32_t r = 0; r < n; r++) {
        for (int i = 0; i < 16; i++)
            w[i] = h[i & 7] ^ (r * 0x9e3779b9u + (uint32_t) i);
        for (int i = 16; i < 64; i++) {
            uint32_t s0 =
                ROR(w[i - 15], 7) ^ ROR(w[i - 15], 18) ^ (w[i - 15] >> 3);
            uint32_t s1 =
                ROR(w[i - 2], 17) ^ ROR(w[i - 2], 19) ^ (w[i - 2] >> 10);
            w[i] = w[i - 16] + s0 + w[i - 7] + s1;
        }
        uint32_t a = h[0], b = h[1], c = h[2], d = h[3], e = h[4], f = h[5],
                 g = h[6], hh = h[7];
        for (int i = 0; i < 64; i++) {
            uint32_t t1 = hh + (ROR(e, 6) ^ ROR(e, 11) ^ ROR(e, 25)) +
                          ((e & f) ^ (~e & g)) + k[i] + w[i];
            uint32_t t2 = (ROR(a, 2) ^ ROR(a, 13) ^ ROR(a, 22)) +
                          ((a & b) ^ (a & c) ^ (b & c));
            hh = g;
            g = f;
            f = e;
            e = d + t1;
            d = c;
            c = b;
            b = a;
            a = t1 + t2;
        }
        h[0] += a;
        h[1] += b;
        h[2] += c;
        h[3] += d;
        h[4] += e;
        h[5] += f;
        h[6] += g;
        h[7] += hh;
    }
    return h[0] ^ h[7];
}

/* the sieve of Eratosthenes over a 1 MiB byte array, n times */
EXPORT(sieve) uint32_t sieve(uint32_t n) {
    uint32_t count = 0;
    for (uint32_t r = 0; r < n; r++) {
        for (uint32_t i = 0; i < sizeof sieve_bits; i++) sieve_bits[i] = 1;
        count = 0;
        for (uint32_t i = 2; i < sizeof sieve_bits; i++)
            if (sieve_bits[i]) {
                count++;
                for (uint32_t j = i + i; j < sizeof sieve_bits; j += i)
                    sieve_bits[j] = 0;
            }
    }
    return count;
}

static void quicksort(int32_t* a, int lo, int hi) {
    while (lo < hi) {
        int32_t p = a[(lo + hi) / 2];
        int i = lo, j = hi;
        while (i <= j) {
            while (a[i] < p) i++;
            while (a[j] > p) j--;
            if (i <= j) {
                int32_t t = a[i];
                a[i++] = a[j];
                a[j--] = t;
            }
        }
        if (j - lo < hi - i) {
            quicksort(a, lo, j);
            lo = i;
        }
        else {
            quicksort(a, i, hi);
            hi = j;
        }
    }
}

/* quicksort of 16,384 pseudo-random ints, n times */
EXPORT(sort) uint32_t sort(uint32_t n) {
    uint32_t x = 12345, sum = 0;
    const int len = sizeof arr / sizeof arr[0];
    for (uint32_t r = 0; r < n; r++) {
        for (int i = 0; i < len; i++) {
            x ^= x << 13;
            x ^= x >> 17;
            x ^= x << 5;
            arr[i] = (int32_t) x;
        }
        quicksort(arr, 0, len - 1);
        sum += (uint32_t) arr[len / 2];
    }
    return sum;
}

static uint32_t fibr(uint32_t n) {
    return n < 2 ? n : fibr(n - 1) + fibr(n - 2);
}

/* naive recursive Fibonacci of 20, n times: a call per handful of instructions
 */
EXPORT(fib) uint32_t fib(uint32_t n) {
    uint32_t s = 0;
    for (uint32_t r = 0; r < n; r++) s += fibr(20 + (r & 1));
    return s;
}

/* a 32x32 integer matrix product, n times */
EXPORT(matmul) uint32_t matmul(uint32_t n) {
    for (int i = 0; i < 32 * 32; i++) {
        ma[i] = i * 7 + 1;
        mb[i] = i * 3 + 2;
    }
    uint32_t s = 0;
    for (uint32_t r = 0; r < n; r++) {
        for (int i = 0; i < 32; i++)
            for (int j = 0; j < 32; j++) {
                int32_t acc = 0;
                for (int k = 0; k < 32; k++)
                    acc += ma[i * 32 + k] * mb[k * 32 + j];
                mc[i * 32 + j] = acc;
            }
        s += (uint32_t) mc[(r * 7) & 1023];
        ma[r & 1023] ^= (int32_t) s;
    }
    return s;
}
