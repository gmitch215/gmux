#include <stdint.h>

/* the cpuid bits a libm picks its variant by: glibc selects exp, log and pow
 * built with FMA (which round differently from the SSE2 ones the kernels
 * match) when leaf 1 reports FMA and AVX, leaf 7 AVX2 or leaf 0x80000001
 * FMA4, so katybug must report none */
static long sys3(long n, long a, long b, long c) {
    long r;
    __asm__ volatile("syscall"
                     : "=a"(r)
                     : "a"(n), "D"(a), "S"(b), "d"(c)
                     : "rcx", "r11", "memory");
    return r;
}

__asm__(".globl _start\n_start:\n xor %rbp, %rbp\n and $-16, %rsp\n call "
        "cpuid_main\n hlt\n");

static void cpuid(uint32_t leaf, uint32_t sub, uint32_t r[4]) {
    __asm__ volatile("cpuid"
                     : "=a"(r[0]), "=b"(r[1]), "=c"(r[2]), "=d"(r[3])
                     : "a"(leaf), "c"(sub));
}

static void put(const char* name, uint32_t v) {
    char buf[64];
    int n = 0;
    while (*name) buf[n++] = *name++;
    buf[n++] = ' ';
    buf[n++] = (char) ('0' + v);
    buf[n++] = '\n';
    sys3(1, 1, (long) buf, n);
}

void cpuid_main(void) {
    uint32_t r[4];
    cpuid(1, 0, r);
    put("fma", r[2] >> 12 & 1);
    put("osxsave", r[2] >> 27 & 1);
    put("avx", r[2] >> 28 & 1);
    cpuid(7, 0, r);
    put("leaf7", r[0] | r[1] | r[2] | r[3] ? 1 : 0);
    cpuid(0x80000001, 0, r);
    put("fma4", r[2] >> 16 & 1);
    sys3(60, 0, 0, 0);
}
