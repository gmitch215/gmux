#include <stdint.h>

#if defined(KB_HOST)
    #include <unistd.h>
static long sys_write(int fd, const void* p, unsigned long n) {
    return write(fd, p, n);
}
static void sys_exit(int c) {
    _exit(c);
}
#elif defined(__x86_64__)
static long sys_write(int fd, const void* p, unsigned long n) {
    long r;
    __asm__ volatile("syscall"
                     : "=a"(r)
                     : "a"(1), "D"(fd), "S"(p), "d"(n)
                     : "rcx", "r11", "memory");
    return r;
}
static void sys_exit(int c) {
    __asm__ volatile("syscall" ::"a"(231), "D"(c) : "rcx", "r11", "memory");
    __builtin_unreachable();
}
__asm__(".globl _start\n_start:\n xor %rbp, %rbp\n mov %rsp, %rdi\n"
        " and $-16, %rsp\n call guest_main\n hlt\n");
#elif defined(__aarch64__)
static long sys_write(int fd, const void* p, unsigned long n) {
    register long x0 __asm__("x0") = fd;
    register long x1 __asm__("x1") = (long) p;
    register long x2 __asm__("x2") = (long) n;
    register long x8 __asm__("x8") = 64;
    __asm__ volatile("svc 0" : "+r"(x0) : "r"(x1), "r"(x2), "r"(x8) : "memory");
    return x0;
}
static void sys_exit(int c) {
    register long x0 __asm__("x0") = c;
    register long x8 __asm__("x8") = 94;
    __asm__ volatile("svc 0" ::"r"(x0), "r"(x8) : "memory");
    __builtin_unreachable();
}
__asm__(".globl _start\n_start:\n mov x0, sp\n bl guest_main\n");
#endif

void* memset(void* d, int c, unsigned long n) {
    unsigned char* p = d;
    while (n--) *p++ = (unsigned char) c;
    return d;
}

void* memcpy(void* d, const void* s, unsigned long n) {
    unsigned char* p = d;
    const unsigned char* q = s;
    while (n--) *p++ = *q++;
    return d;
}

static char out[8192];
static int used;

static void put(const char* s) {
    while (*s) out[used++] = *s++;
}

static void num(int64_t v) {
    char b[24];
    int n = 0;
    uint64_t u = v < 0 ? (uint64_t) 0 - (uint64_t) v : (uint64_t) v;
    do b[n++] = (char) ('0' + u % 10);
    while (u /= 10);
    if (v < 0) out[used++] = '-';
    while (n) out[used++] = b[--n];
}

static void hex(uint64_t v) {
    put("0x");
    for (int i = 60; i >= 0; i -= 4)
        out[used++] = "0123456789abcdef"[(v >> i) & 15];
}

static void line(const char* k, int64_t v) {
    put(k);
    put(" ");
    num(v);
    put("\n");
}

static void linex(const char* k, uint64_t v) {
    put(k);
    put(" ");
    hex(v);
    put("\n");
}

__attribute__((noinline)) static int64_t fib(int n) {
    return n < 2 ? n : fib(n - 1) + fib(n - 2);
}

__attribute__((noinline)) static int ack(int m, int n) {
    if (!m) return n + 1;
    if (!n) return ack(m - 1, 1);
    return ack(m - 1, ack(m, n - 1));
}

struct point {
    int32_t x, y;
    int64_t tag;
    uint8_t name[13];
};

__attribute__((noinline)) static struct point mirror(struct point p) {
    struct point q = p;
    q.x = -p.y;
    q.y = p.x * 3;
    q.tag ^= 0x5a5a5a5a5a5a5a5aLL;
    for (int i = 0; i < 13; i++) q.name[i] = (uint8_t) (p.name[12 - i] + 1);
    return q;
}

typedef int64_t (*op_fn)(int64_t, int64_t);
static int64_t op_add(int64_t a, int64_t b) {
    return a + b;
}
static int64_t op_mul(int64_t a, int64_t b) {
    return a * b;
}
static int64_t op_sdiv(int64_t a, int64_t b) {
    return b ? a / b : 0;
}
static int64_t op_urem(int64_t a, int64_t b) {
    return b ? (int64_t) ((uint64_t) a % (uint64_t) b) : 0;
}
static op_fn ops[] = {op_add, op_mul, op_sdiv, op_urem};

__attribute__((noinline)) static const char* name(int k) {
    switch (k) {
        case 0: return "zero";
        case 1: return "one";
        case 2: return "two";
        case 3: return "three";
        case 4: return "four";
        case 5: return "five";
        case 6: return "six";
        case 7: return "seven";
        default: return "many";
    }
}

static uint32_t lcg = 12345;
static uint32_t rnd(void) {
    lcg = lcg * 1103515245u + 12345u;
    return lcg >> 1;
}

int64_t global_sum = 7;
int32_t bss_table[256];

int guest_main(long* sp) {
    (void) sp;
    line("fib25", fib(25));
    line("ack23", ack(2, 3));

    int64_t a = -1234567890123LL, b = 987654;
    line("mul", a * b);
    line("sdiv", a / b);
    line("smod", a % b);
    line("udiv", (int64_t) ((uint64_t) a / (uint64_t) b));
    line("urem", (int64_t) ((uint64_t) a % (uint64_t) b));
    int32_t c = -77777, e = 321;
    line("sdiv32", c / e);
    line("smod32", c % e);
    line("udiv32", (int64_t) ((uint32_t) c / (uint32_t) e));
    unsigned __int128 wide =
        (unsigned __int128) 0xfedcba9876543210ULL * 0x123456789abcdefULL;
    linex("mul128hi", (uint64_t) (wide >> 64));
    linex("mul128lo", (uint64_t) wide);
    __int128 swide = (__int128) a * (int64_t) 0x7fffffff12345LL;
    linex("smul128hi", (uint64_t) ((unsigned __int128) swide >> 64));

    uint64_t v = 0x0123456789abcdefULL;
    linex("shl", v << 13);
    linex("shr", v >> 17);
    linex("sar", (uint64_t) ((int64_t) 0xf123456789abcdefULL >> 23));
    linex("rotl", (v << 21) | (v >> 43));
    line("clz", __builtin_clzll(v));
    line("ctz", __builtin_ctzll(v << 5));
    int pop = 0;
    for (uint64_t t = v; t; t &= t - 1) pop++;
    line("popcount", pop);
    linex("bswap", __builtin_bswap64(v));
    linex("bswap32", __builtin_bswap32((uint32_t) v));

    int8_t s8 = (int8_t) 0xf3;
    int16_t s16 = (int16_t) 0x8123;
    uint8_t u8 = 0xf3;
    line("sext8", s8);
    line("sext16", s16);
    line("zext8", u8);
    line("byte-arith", (uint8_t) (u8 * 7 + 13));
    line("short-arith", (int16_t) (s16 * 3 - 5));

    struct point p = {3, -4, 0x1122334455667788LL, "katybug-test"};
    struct point q = mirror(p);
    line("mirror.x", q.x);
    line("mirror.y", q.y);
    linex("mirror.tag", (uint64_t) q.tag);
    line("mirror.name0", q.name[1]);

    for (int k = 0; k < 4; k++) line("op", ops[k](1000003 + k * 17, -97 + k));
    for (int k = 0; k < 10; k++) {
        put(name(k));
        put(k == 9 ? "\n" : " ");
    }

    int32_t arr[64];
    for (int i = 0; i < 64; i++) arr[i] = (int32_t) (rnd() % 1000) - 500;
    for (int i = 1; i < 64; i++) {
        int32_t t = arr[i];
        int j = i - 1;
        while (j >= 0 && arr[j] > t) {
            arr[j + 1] = arr[j];
            j--;
        }
        arr[j + 1] = t;
    }
    line("sorted0", arr[0]);
    line("sorted31", arr[31]);
    line("sorted63", arr[63]);

    uint8_t sieve[1000];
    memset(sieve, 1, sizeof sieve);
    int primes = 0;
    for (int i = 2; i < 1000; i++) {
        if (!sieve[i]) continue;
        primes++;
        for (int j = i * i; j < 1000; j += i) sieve[j] = 0;
    }
    line("primes", primes);

    for (int i = 0; i < 256; i++) bss_table[i] = i * i - 3 * i;
    for (int i = 0; i < 256; i++) global_sum += bss_table[i] % 7;
    line("global", global_sum);

    int64_t mx = 0, mn = 0;
    for (int i = 0; i < 100; i++) {
        int64_t t = (int64_t) rnd() - (1 << 30);
        mx = t > mx ? t : mx;
        mn = t < mn ? t : mn;
    }
    line("max", mx);
    line("min", mn);
    line("cmp-unsigned", (uint64_t) mn > (uint64_t) mx);

    sys_write(1, out, (unsigned long) used);
    sys_exit((int) (global_sum & 0x7f));
    return 0;
}

#if defined(KB_HOST)
int main(void) {
    return guest_main(0);
}
#endif
