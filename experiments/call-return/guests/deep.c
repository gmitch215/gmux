#include <stdint.h>

#ifndef FIB_N
    #define FIB_N 38
#endif
#ifndef PASSES
    #define PASSES 4
#endif
#define CAP (4u << 20)

#if defined(__x86_64__)
static long sys3(long n, long a, long b, long c) {
    long r;
    __asm__ volatile("syscall"
                     : "=a"(r)
                     : "a"(n), "D"(a), "S"(b), "d"(c)
                     : "rcx", "r11", "memory");
    return r;
}
    #define NR_WRITE 1
    #define NR_EXIT 60
__asm__(".globl _start\n_start:\n xor %rbp, %rbp\n and $-16, %rsp\n call "
        "guest_main\n hlt\n");
#elif defined(__aarch64__)
static long sys3(long n, long a, long b, long c) {
    register long x0 __asm__("x0") = a;
    register long x1 __asm__("x1") = b;
    register long x2 __asm__("x2") = c;
    register long x8 __asm__("x8") = n;
    __asm__ volatile("svc 0" : "+r"(x0) : "r"(x1), "r"(x2), "r"(x8) : "memory");
    return x0;
}
    #define NR_WRITE 64
    #define NR_EXIT 93
__asm__(".globl _start\n_start:\n bl guest_main\n");
#endif

#if defined(FIB) || defined(PARSE)
static void out(const char* name, uint64_t v) {
    char b[64];
    int n = 0;
    char d[24];
    int k = 0;
    while (*name) b[n++] = *name++;
    b[n++] = ' ';
    do d[k++] = '0' + v % 10;
    while ((v /= 10) != 0);
    while (k) b[n++] = d[--k];
    b[n++] = '\n';
    sys3(NR_WRITE, 1, (long) b, n);
}
#endif

#ifdef FIB
__attribute__((noinline)) static uint64_t fib(uint64_t n) {
    if (n < 2) return n;
    uint64_t a = fib(n - 1);
    uint64_t b = fib(n - 2);
    __asm__ volatile("" : "+r"(a), "+r"(b));
    return a + b;
}
#endif

#ifdef PARSE
static char buf[CAP];
static unsigned len;
static uint64_t seed = 88172645463325252ull;

static unsigned rnd(void) {
    seed ^= seed << 13;
    seed ^= seed >> 7;
    seed ^= seed << 17;
    return (unsigned) (seed >> 32);
}
static void put(char c) {
    buf[len++] = c;
}
static void num(void) {
    unsigned v = rnd() % 1000 + 1;
    char d[8];
    int k = 0;
    do d[k++] = '0' + v % 10;
    while ((v /= 10) != 0);
    while (k) put(d[--k]);
}
static void gexpr(int depth);
static void gfactor(int depth) {
    unsigned r = rnd();
    if (len > CAP - 4096) return num();
    if (depth > 0 && r % 3 == 0) {
        put('(');
        gexpr(depth - 1);
        put(')');
    }
    else if (r % 17 == 0) {
        put('-');
        gfactor(depth);
    }
    else {
        num();
    }
}
static void gterm(int depth) {
    gfactor(depth);
    for (unsigned n = rnd() % 3; n; n--) {
        put(rnd() & 1 ? '*' : '%');
        gfactor(depth);
    }
}
static void gexpr(int depth) {
    gterm(depth);
    for (unsigned n = rnd() % 4; n; n--) {
        put(rnd() & 1 ? '+' : '-');
        gterm(depth);
    }
}

static const char* p;
static uint64_t expr(void);
static uint64_t factor(void) {
    if (*p == '(') {
        p++;
        uint64_t v = expr();
        p++;
        return v;
    }
    if (*p == '-') {
        p++;
        return -factor();
    }
    uint64_t v = 0;
    while (*p >= '0' && *p <= '9') v = v * 10 + (uint64_t) (*p++ - '0');
    return v;
}
static uint64_t term(void) {
    uint64_t v = factor();
    while (*p == '*' || *p == '%') {
        char op = *p++;
        uint64_t w = factor();
        v = op == '*' ? v * w : (w ? v % w : v);
    }
    return v;
}
static uint64_t expr(void) {
    uint64_t v = term();
    while (*p == '+' || *p == '-') {
        char op = *p++;
        uint64_t w = term();
        v = op == '+' ? v + w : v - w;
    }
    return v;
}
#endif

void guest_main(void) {
#ifdef FIB
    out("fib", fib(FIB_N));
#endif
#ifdef PARSE
    while (len < CAP - 8192) {
        gexpr(30);
        put('+');
    }
    put('0');
    uint64_t sum = 0;
    for (int i = 0; i < PASSES; i++) {
        p = buf;
        sum += expr() + (uint64_t) i;
    }
    out("bytes", len);
    out("parse", sum);
#endif
    sys3(NR_EXIT, 0, 0, 0);
    for (;;) {
    }
}
