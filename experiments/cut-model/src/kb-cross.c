#include <stdint.h>

#if defined(__x86_64__)
static long sys3(long nr, long a, long b, long c) {
    long r;
    __asm__ volatile("syscall"
                     : "=a"(r)
                     : "a"(nr), "D"(a), "S"(b), "d"(c)
                     : "rcx", "r11", "memory");
    return r;
}
static long sys6(long nr, long a, long b, long c, long d, long e, long f) {
    long r;
    register long r10 __asm__("r10") = d;
    register long r8 __asm__("r8") = e;
    register long r9 __asm__("r9") = f;
    __asm__ volatile("syscall"
                     : "=a"(r)
                     : "a"(nr), "D"(a), "S"(b), "d"(c), "r"(r10), "r"(r8),
                       "r"(r9)
                     : "rcx", "r11", "memory");
    return r;
}
    #define NR_WRITE 1
    #define NR_EXIT 231
    #define NR_MMAP 9
__asm__(".globl _start\n_start:\n xor %rbp, %rbp\n mov %rsp, %rdi\n and $-16, "
        "%rsp\n call guest_main\n hlt\n");
#elif defined(__aarch64__)
static long sys6(long nr, long a, long b, long c, long d, long e, long f) {
    register long x0 __asm__("x0") = a;
    register long x1 __asm__("x1") = b;
    register long x2 __asm__("x2") = c;
    register long x3 __asm__("x3") = d;
    register long x4 __asm__("x4") = e;
    register long x5 __asm__("x5") = f;
    register long x8 __asm__("x8") = nr;
    __asm__ volatile("svc 0"
                     : "+r"(x0)
                     : "r"(x1), "r"(x2), "r"(x3), "r"(x4), "r"(x5), "r"(x8)
                     : "memory");
    return x0;
}
static long sys3(long nr, long a, long b, long c) {
    return sys6(nr, a, b, c, 0, 0, 0);
}
    #define NR_WRITE 64
    #define NR_EXIT 94
    #define NR_MMAP 222
__asm__(".globl _start\n_start:\n mov x0, sp\n bl guest_main\n");
#endif

#define ROUND(x, y)                                                            \
    x = (x ^ y) + 0x9e3779b9u;                                                 \
    __asm__ volatile("" : "+r"(x));
#define R4(x, y) ROUND(x, y) ROUND(x, y) ROUND(x, y) ROUND(x, y)
#define R16(x, y) R4(x, y) R4(x, y) R4(x, y) R4(x, y)
#define R64(x, y) R16(x, y) R16(x, y) R16(x, y) R16(x, y)

/* straight-line work between back-edges: the block length varies, the loop is
 * one block a pass */
#define ALU(name, body)                                                        \
    __attribute__((noinline)) static unsigned long name(unsigned long n) {     \
        unsigned long x = 1, y = n;                                            \
        __asm__ volatile("" : "+r"(y));                                        \
        for (unsigned long i = 0; i < n; i++) {                                \
            body                                                               \
        }                                                                      \
        return x + y;                                                          \
    }
ALU(alu1, ROUND(x, y))
ALU(alu4, R4(x, y))
ALU(alu16, R16(x, y))
ALU(alu64, R64(x, y))

static unsigned char pat[256];

/* a branch on pat, both arms the same work */
#define BRANCH(name, reps)                                                     \
    __attribute__((noinline)) static unsigned long name(unsigned long n) {     \
        unsigned long x = 1, y = n;                                            \
        __asm__ volatile("" : "+r"(y));                                        \
        for (unsigned long i = 0; i < n; i++) {                                \
            reps(x, y) if (pat[i & 255]) {                                     \
                reps(x, y) x += 5;                                             \
                __asm__ volatile("" : "+r"(x));                                \
            }                                                                  \
            else {                                                             \
                reps(x, y) x += 3;                                             \
                __asm__ volatile("" : "+r"(x));                                \
            }                                                                  \
            reps(x, y)                                                         \
        }                                                                      \
        return x + y;                                                          \
    }
BRANCH(br4, R4)
BRANCH(br16, R16)

/* a segment: work, then a branch on pat that never leaves (the cold arm sits
 * out of line) */
#define SEG(reps)                                                              \
    reps(x, y) if (__builtin_expect(!pat[(i + __COUNTER__) & 255], 0)) {       \
        x += 7;                                                                \
        __asm__ volatile("" : "+r"(x));                                        \
    }
#define S1(r) SEG(r)
#define S2(r) S1(r) S1(r)
#define S4(r) S2(r) S2(r)
#define S8(r) S4(r) S4(r)
#define S16(r) S8(r) S8(r)
#define S32(r) S16(r) S16(r)
#define S64(r) S32(r) S32(r)

#define TL(name, segs, reps)                                                   \
    __attribute__((noinline)) static unsigned long name(unsigned long n) {     \
        unsigned long x = 1, y = n;                                            \
        __asm__ volatile("" : "+r"(y));                                        \
        _Pragma("clang loop unroll(disable)") for (unsigned long i = 0; i < n; \
                                                   i++) {                      \
            segs(reps)                                                         \
        }                                                                      \
        return x + y;                                                          \
    }
TL(tl1_4, S1, R4)
TL(tl2_4, S2, R4)
TL(tl4_4, S4, R4)
TL(tl8_4, S8, R4)
TL(tl16_4, S16, R4)
TL(tl32_4, S32, R4)
TL(tl64_4, S64, R4)
TL(tl1_16, S1, R16)
TL(tl2_16, S2, R16)
TL(tl4_16, S4, R16)
TL(tl8_16, S8, R16)
TL(tl16_16, S16, R16)
TL(tl32_16, S32, R16)
TL(tl64_16, S64, R16)

static unsigned long spin(unsigned long n, unsigned long* a, unsigned long* b) {
    unsigned long s = 0;
#pragma clang loop unroll(disable)
    for (unsigned long i = 0; i < n; i++) {
        unsigned long* p = (i & 1) ? b : a;
        s += *(volatile unsigned long*) p;
    }
    return s;
}

/* the same load always in one mapping (miss = 0) or alternating between two (a
 * miss a load) */
__attribute__((noinline)) static unsigned long map(
    unsigned long n, int miss, int extra
) {
    for (int k = 0; k < extra; k++)
        if (sys6(NR_MMAP, 0, 4096, 3, 0x22, -1, 0) < 0) return 1;
    long a = sys6(NR_MMAP, 0, 4096, 3, 0x22, -1, 0);
    long b = sys6(NR_MMAP, 0, 4096, 3, 0x22, -1, 0);
    if (a < 0 || b < 0) return 1;
    unsigned long* pa = (unsigned long*) a;
    unsigned long* pb = miss ? (unsigned long*) b : (unsigned long*) a;
    return spin(n, pa, pb);
}

static unsigned long num(const char* s) {
    unsigned long v = 0;
    while (*s >= '0' && *s <= '9') v = v * 10 + (unsigned long) (*s++ - '0');
    return v;
}

static void hex(unsigned long v) {
    char out[19];
    out[0] = 'x';
    for (int i = 0; i < 16; i++)
        out[1 + i] = "0123456789abcdef"[(v >> (60 - 4 * i)) & 15];
    out[17] = '\n';
    sys3(NR_WRITE, 1, (long) out, 18);
}

static unsigned long tl(unsigned long s, unsigned long k, unsigned long n) {
    for (unsigned long j = 0; j < 256; j++) pat[j] = 1;
    if (k == 4)
        return s == 1    ? tl1_4(n)
               : s == 2  ? tl2_4(n)
               : s == 4  ? tl4_4(n)
               : s == 8  ? tl8_4(n)
               : s == 16 ? tl16_4(n)
               : s == 32 ? tl32_4(n)
                         : tl64_4(n);
    return s == 1    ? tl1_16(n)
           : s == 2  ? tl2_16(n)
           : s == 4  ? tl4_16(n)
           : s == 8  ? tl8_16(n)
           : s == 16 ? tl16_16(n)
           : s == 32 ? tl32_16(n)
                     : tl64_16(n);
}

/* alu <reps 1|4|16|64> <n> | br <reps 4|16> <every> <n> | map <miss 0|1>
 * <extra> <n> | t <segments 1..64 doubling> <reps 4|16> <n> | null */
void guest_main(long* sp) {
    long argc = sp[0];
    char** argv = (char**) (sp + 1);
    unsigned long v = 0;
    if (argc >= 4 && argv[1][0] == 'a') {
        unsigned long r = num(argv[2]), n = num(argv[3]);
        v = r == 1 ? alu1(n) : r == 4 ? alu4(n) : r == 16 ? alu16(n) : alu64(n);
    }
    else if (argc >= 5 && argv[1][0] == 'b') {
        unsigned long r = num(argv[2]), every = num(argv[3]), n = num(argv[4]);
        /* the trace is built while the branch only goes one way, then it leaves
         * on 1 pass in every */
        for (unsigned long j = 0; j < 256; j++) pat[j] = 1;
        v = r == 4 ? br4(4096) : br16(4096);
        for (unsigned long j = 0; j < 256; j++)
            pat[j] = !every || j % every != 0;
        v += r == 4 ? br4(n) : br16(n);
    }
    else if (argc >= 5 && argv[1][0] == 't')
        v = tl(num(argv[2]), num(argv[3]), num(argv[4]));
    else if (argc >= 5 && argv[1][0] == 'm')
        v = map(num(argv[4]), (int) num(argv[2]), (int) num(argv[3]));
    hex(v);
    sys3(NR_EXIT, 0, 0, 0);
    __builtin_unreachable();
}
