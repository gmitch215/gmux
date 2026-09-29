#include <stdint.h>

#if defined(__x86_64__)
    #define NR_READ 0
    #define NR_WRITE 1
    #define NR_MMAP 9
    #define NR_MPROTECT 10
    #define NR_MUNMAP 11
    #define NR_BRK 12
    #define NR_PIPE 22
    #define NR_EXIT 60
    #define OPEN_NULL(path) sys6(2, (long) (path), 1, 0, 0, 0, 0)
static long sys6(long n, long a, long b, long c, long d, long e, long f) {
    long r;
    register long r10 __asm__("r10") = d;
    register long r8 __asm__("r8") = e;
    register long r9 __asm__("r9") = f;
    __asm__ volatile("syscall"
                     : "=a"(r)
                     : "a"(n), "D"(a), "S"(b), "d"(c), "r"(r10), "r"(r8),
                       "r"(r9)
                     : "rcx", "r11", "memory");
    return r;
}
__asm__(".globl _start\n_start:\n xor %rbp, %rbp\n and $-16, %rsp\n call "
        "pieces_main\n hlt\n");
#elif defined(__aarch64__)
    #define NR_READ 63
    #define NR_WRITE 64
    #define NR_MMAP 222
    #define NR_MPROTECT 226
    #define NR_MUNMAP 215
    #define NR_BRK 214
    #define NR_PIPE 59
    #define NR_EXIT 93
    #define OPEN_NULL(path) sys6(56, -100, (long) (path), 1, 0, 0, 0)
static long sys6(long n, long a, long b, long c, long d, long e, long f) {
    register long x0 __asm__("x0") = a;
    register long x1 __asm__("x1") = b;
    register long x2 __asm__("x2") = c;
    register long x3 __asm__("x3") = d;
    register long x4 __asm__("x4") = e;
    register long x5 __asm__("x5") = f;
    register long x8 __asm__("x8") = n;
    __asm__ volatile("svc 0"
                     : "+r"(x0)
                     : "r"(x1), "r"(x2), "r"(x3), "r"(x4), "r"(x5), "r"(x8)
                     : "memory");
    return x0;
}
__asm__(".globl _start\n_start:\n bl pieces_main\n");
#endif

/* the guest's memory comes in 64 KiB pieces; every check here puts an access
 * across a piece boundary and reads the same bytes back another way */
#define PIECE 0x10000ul
#define BASE (0x200000000000ul + 0xd000ul) /* starts mid-piece */
#define LEN (5 * PIECE)
#define BND(k) (BASE + 0x3000 + (k) * PIECE) /* the piece boundaries in it */

static int failed;

static void say(const char* s) {
    long n = 0;
    while (s[n]) n++;
    sys6(NR_WRITE, 1, (long) s, n, 0, 0, 0);
}

static void report(const char* name, int ok) {
    say(name);
    say(ok ? " ok\n" : " FAIL\n");
    failed |= !ok;
}

static uint8_t pat(unsigned long i) {
    return (uint8_t) (i * 131 + (i >> 8) * 7 + 1);
}

/* initialized data over three pieces: the loader reads the file straight into
 * them, so a chunk in the wrong place shows as a zero */
static uint8_t blob[3 * PIECE + 4321] = {[0 ... 3 * PIECE + 4320] = 7};
static uint8_t tail[PIECE + 100];

static int image(void) {
    for (unsigned long i = 0; i < sizeof blob; i++)
        if (((volatile uint8_t*) blob)[i] != 7) return 0;
    for (unsigned long i = 0; i < sizeof tail; i++)
        if (((volatile uint8_t*) tail)[i]) return 0;
    return 1;
}

static long map_at(unsigned long addr, unsigned long len, long prot) {
    return sys6(NR_MMAP, (long) addr, (long) len, prot, 0x32, -1, 0);
}

/* stores of every width at every offset just before a boundary read back
 * byte by byte, and bytes stored one at a time read back as one word */
static int straddle(void) {
    for (unsigned long b = BND(0); b < BASE + LEN; b += PIECE)
        for (int off = 1; off < 8; off++)
            for (int w = 2; w <= 8; w *= 2) {
                if (off >= w) continue;
                volatile uint8_t* p = (volatile uint8_t*) (b - (unsigned) off);
                uint64_t v = 0x0123456789abcdefull * (unsigned) (w + off);
                for (int i = 0; i < w; i++) p[i] = 0;
                if (w == 2) *(volatile uint16_t*) p = (uint16_t) v;
                if (w == 4) *(volatile uint32_t*) p = (uint32_t) v;
                if (w == 8) *(volatile uint64_t*) p = v;
                for (int i = 0; i < w; i++)
                    if (p[i] != (uint8_t) (v >> (8 * i))) return 0;
                uint64_t got = 0;
                for (int i = 0; i < w; i++) p[i] = (uint8_t) (v >> (8 * i));
                if (w == 2) got = *(volatile uint16_t*) p;
                if (w == 4) got = *(volatile uint32_t*) p;
                if (w == 8) got = *(volatile uint64_t*) p;
                uint64_t mask = w == 8 ? ~0ull : (1ull << (8 * w)) - 1;
                if (got != (v & mask)) return 0;
            }
    return 1;
}

static int fill_check(unsigned long from, unsigned long to) {
    for (unsigned long i = from; i < to; i++)
        if (*(volatile uint8_t*) i != pat(i)) return 0;
    return 1;
}

static int pipe_across(void) {
    int fds[2];
    if (sys6(NR_PIPE, (long) fds, 0, 0, 0, 0, 0) < 0) return 0;
    unsigned long src = BND(1) - 0x1f00, dst = BND(2) - 0x2100;
    for (unsigned long i = 0; i < 20000; i++)
        *(uint8_t*) (src + i) = pat(i + 5);
    long w = sys6(NR_WRITE, fds[1], (long) src, 20000, 0, 0, 0);
    if (w != 20000) return 0;
    long r = sys6(NR_READ, fds[0], (long) dst, 20000, 0, 0, 0);
    if (r != 20000) return 0;
    for (unsigned long i = 0; i < 20000; i++)
        if (*(uint8_t*) (dst + i) != pat(i + 5)) return 0;
    return 1;
}

static int split_keeps(void) {
    unsigned long lo = BND(1) - 0x2000;
    /* a page in the middle of a piece goes read-only and then away */
    if (sys6(NR_MPROTECT, (long) lo, 0x1000, 1, 0, 0, 0)) return 0;
    if (!fill_check(BASE + 0x1000, lo)) return 0;
    if (!fill_check(lo, lo + 0x1000)) return 0;
    if (!fill_check(lo + 0x1000, BASE + LEN - 0x1000)) return 0;
    if (sys6(NR_MUNMAP, (long) lo, 0x1000, 0, 0, 0, 0)) return 0;
    if (!fill_check(BASE + 0x1000, lo)) return 0;
    if (!fill_check(lo + 0x1000, BASE + LEN - 0x1000)) return 0;
    if (map_at(lo, 0x1000, 3) != (long) lo) return 0;
    for (unsigned long i = lo; i < lo + 0x1000; i++)
        if (*(volatile uint8_t*) i) return 0;
    return 1;
}

#if defined(__x86_64__)
static int rep_across(void) {
    unsigned long d = BND(0) - 0x77, s = BND(2) - 0x1234;
    unsigned long n = 150000;
    for (unsigned long i = 0; i < n; i++) *(uint8_t*) (s + i) = pat(i * 3);
    __asm__ volatile("rep movsb" : "+D"(d), "+S"(s), "+c"(n) : : "memory");
    unsigned long dd = BND(0) - 0x77;
    for (unsigned long i = 0; i < 150000; i++)
        if (*(uint8_t*) (dd + i) != pat(i * 3)) return 0;
    d = BND(0) + 0x40;
    n = 200000;
    uint64_t al = 0x5a;
    __asm__ volatile("rep stosb" : "+D"(d), "+c"(n) : "a"(al) : "memory");
    for (unsigned long i = 0; i < 200000; i++)
        if (*(uint8_t*) (BND(0) + 0x40 + i) != 0x5a) return 0;
    return n == 0;
}
#endif

/* a write of 2 MiB is more than one call's worth of pieces at any piece size
 * from 4 KiB up, and still goes out whole */
static int bigwrite(void) {
    unsigned long big = 0x300000000000ul + 0x2000;
    if (map_at(big, 2ul << 20, 3) != (long) big) return 0;
    long fd = OPEN_NULL("/dev/null");
    if (fd < 0) return 0;
    return sys6(NR_WRITE, fd, (long) big, 2l << 20, 0, 0, 0) == (2l << 20) &&
           sys6(NR_WRITE, fd, (long) big + 5, (2l << 20) - 9, 0, 0, 0) ==
               (2l << 20) - 9;
}

/* a stack that has to grow by megabytes as it is used */
__attribute__((noinline)) static int deep(int depth) {
    volatile uint8_t page[65536];
    for (unsigned i = 0; i < sizeof page; i += 4096) page[i] = (uint8_t) depth;
    if (depth == 0) return 1;
    int ok = deep(depth - 1);
    for (unsigned i = 0; i < sizeof page; i += 4096)
        if (page[i] != (uint8_t) depth) return 0;
    return ok;
}

static int heap(void) {
    long cur = sys6(NR_BRK, 0, 0, 0, 0, 0, 0);
    long top = cur + 3 * (long) PIECE + 0x1234;
    if (sys6(NR_BRK, top, 0, 0, 0, 0, 0) != top) return 0;
    for (long i = cur; i < top; i += 1)
        *(volatile uint8_t*) i = pat((unsigned long) i);
    for (long i = cur; i < top; i += 1)
        if (*(volatile uint8_t*) i != pat((unsigned long) i)) return 0;
    long top2 = top + 2 * (long) PIECE;
    if (sys6(NR_BRK, top2, 0, 0, 0, 0, 0) != top2) return 0;
    for (long i = cur; i < top; i += 97)
        if (*(volatile uint8_t*) i != pat((unsigned long) i)) return 0;
    for (long i = top; i < top2; i += 61)
        if (*(volatile uint8_t*) i) return 0;
    long low = cur + 0x2000;
    if (sys6(NR_BRK, low, 0, 0, 0, 0, 0) != low) return 0;
    if (sys6(NR_BRK, top, 0, 0, 0, 0, 0) != top) return 0;
    for (long i = cur; i < low; i += 1)
        if (*(volatile uint8_t*) i != pat((unsigned long) i)) return 0;
    for (long i = low; i < top; i += 1)
        if (*(volatile uint8_t*) i) return 0;
    return 1;
}

void pieces_main(void) {
    report("image", image());
    report("map", map_at(BASE, LEN, 3) == (long) BASE);
    for (unsigned long i = BASE; i < BASE + LEN; i++)
        *(volatile uint8_t*) i = pat(i);
    report("fill", fill_check(BASE, BASE + LEN));
    report("straddle", straddle());
    for (unsigned long i = BASE; i < BASE + LEN; i++)
        *(volatile uint8_t*) i = pat(i);
    report("pipe", pipe_across());
#if defined(__x86_64__)
    report("rep", rep_across());
#endif
    for (unsigned long i = BASE; i < BASE + LEN; i++)
        *(volatile uint8_t*) i = pat(i);
    report("split", split_keeps());
    report("bigwrite", bigwrite());
    report("stack", deep(48));
    report("heap", heap());
    sys6(NR_EXIT, failed, 0, 0, 0, 0, 0);
}
