#include <stdint.h>

#define NR_WRITE 1
#define NR_MMAP 9
#define NR_MUNMAP 11
#define NR_SIGACTION 13
#define NR_EXIT 60
#define MC 40
#define SA_SIGINFO 4
#define SA_RESTORER 0x04000000
#define SIGFPE 8
#define SIGSEGV 11
#define MAP_FIXED_ANON 0x32 /* MAP_PRIVATE | MAP_FIXED | MAP_ANONYMOUS */
#define MAP_ANON 0x22

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
#define sys(n, a, b, c) sys6(n, a, b, c, 0, 0, 0)
__asm__(".globl _start\n_start:\n xor %rbp, %rbp\n and $-16, %rsp\n call "
        "rep_main\n hlt\n"
        ".globl restore_rt\nrestore_rt:\n mov $15, %eax\n syscall\n");
void restore_rt(void);

static char out[2048];
static int used;
static void put(const char* s) {
    while (*s) out[used++] = *s++;
}
static void num(long v) {
    char b[24];
    int n = 0;
    unsigned long u = v < 0 ? -(unsigned long) v : (unsigned long) v;
    do b[n++] = (char) ('0' + u % 10);
    while (u /= 10);
    if (v < 0) out[used++] = '-';
    while (n) out[used++] = b[--n];
}
static void line(const char* k, long v) {
    put(k);
    put(" ");
    num(v);
    put("\n");
}

/* the fault's registers; rcx 0 in the frame ends the rep */
static volatile long f_rcx, f_rsi, f_rdi, f_addr, faults;
static void on_segv(int s, void* info, void* uc) {
    (void) s;
    long* mc = (long*) ((char*) uc + MC);
    f_rdi = mc[8];
    f_rsi = mc[9];
    f_rcx = mc[14];
    f_addr = ((long*) info)[2];
    mc[14] = 0;
    faults++;
}

struct ksigaction {
    void (*handler)(int, void*, void*);
    unsigned long flags;
    void (*restorer)(void);
    unsigned long mask;
};

static void rep_movs(long w, void* d, const void* s, long n) {
    if (w == 1)
        __asm__ volatile("rep movsb" : "+D"(d), "+S"(s), "+c"(n) : : "memory");
    else
        __asm__ volatile("rep movsq" : "+D"(d), "+S"(s), "+c"(n) : : "memory");
}
static void rep_stos(long w, void* d, long v, long n) {
    if (w == 1)
        __asm__ volatile("rep stosb" : "+D"(d), "+c"(n) : "a"(v) : "memory");
    else
        __asm__ volatile("rep stosq" : "+D"(d), "+c"(n) : "a"(v) : "memory");
}

/* a divide error: rax and rdx as they stood; the divide re-runs as 0 by 1 */
static volatile long e_rax, e_rdx, e_code, fpes;
static void on_fpe(int s, void* info, void* uc) {
    (void) s;
    long* mc = (long*) ((char*) uc + MC);
    e_rax = mc[13];
    e_rdx = mc[12];
    e_code = ((int*) info)[2];
    mc[11] = 1;
    mc[12] = 0;
    mc[13] = 0;
    fpes++;
}

enum
{
    DIVQ,
    IDIVQ,
    IDIVL,
    DIVB
};
static long divide(int kind, long rax, long rdx, long rbx) {
    switch (kind) {
        case DIVQ:
            __asm__ volatile("divq %%rbx" : "+a"(rax), "+d"(rdx), "+b"(rbx));
            break;
        case IDIVQ:
            __asm__ volatile("idivq %%rbx" : "+a"(rax), "+d"(rdx), "+b"(rbx));
            break;
        case IDIVL:
            __asm__ volatile("idivl %%ebx" : "+a"(rax), "+d"(rdx), "+b"(rbx));
            break;
        case DIVB:
            __asm__ volatile("divb %%bl" : "+a"(rax), "+d"(rdx), "+b"(rbx));
            break;
    }
    return rax;
}

static void div_line(const char* k, int kind, long rax, long rdx, long rbx) {
    long before = fpes, q = divide(kind, rax, rdx, rbx);
    put(k);
    put(" ");
    num(fpes - before);
    if (fpes != before) {
        put(" kept ");
        num(e_rax == rax && e_rdx == rdx);
        put(" code ");
        num(e_code);
    }
    put(" q ");
    num(q);
    put("\n");
}

/* a load fault inside a hot loop's trace: rip, the counter and the sum as they
 * stood */
static volatile long w_rip, w_rax, w_rcx;
extern char walk_fault[], walk_done[];
static void on_walk(int s, void* info, void* uc) {
    (void) s;
    (void) info;
    long* mc = (long*) ((char*) uc + MC);
    w_rip = mc[16];
    w_rax = mc[13];
    w_rcx = mc[14];
    mc[16] = (long) walk_done;
}
__attribute__((noinline)) static void walk(const long* p, long n) {
    long sum = 0, i = 0;
    __asm__ volatile("1: testq $31, %[i]\n"
                     " jz 2f\n"
                     " addq $3, %[sum]\n"
                     "2:\n"
                     ".globl walk_fault\nwalk_fault:\n"
                     " addq (%[p],%[i],8), %[sum]\n"
                     " incq %[i]\n"
                     " cmpq %[n], %[i]\n"
                     " jb 1b\n"
                     ".globl walk_done\nwalk_done:\n"
                     : [sum] "+a"(sum), [i] "+c"(i)
                     : [p] "r"(p), [n] "r"(n)
                     : "cc", "memory");
}

static char src[256];
static long dst[8];

void rep_main(void) {
    struct ksigaction a = {on_segv, SA_SIGINFO | SA_RESTORER, restore_rt, 0};
    sys6(NR_SIGACTION, SIGSEGV, (long) &a, 0, 8, 0, 0);
    char* base = (char*) 0x7e0000000000;
    sys6(NR_MMAP, (long) base, 8192, 3, MAP_FIXED_ANON, -1, 0);
    sys(NR_MUNMAP, (long) (base + 4096), 4096, 0);
    for (int i = 0; i < 256; i++) src[i] = (char) i;

    /* a store fault: the bytes before the page end are written */
    rep_movs(1, base + 4000, src, 200);
    line("movsb rcx", f_rcx);
    line("movsb rdi", f_rdi - (long) base);
    line("movsb rsi", f_rsi - (long) src);
    line("movsb addr", f_addr - (long) base);
    line("movsb last", base[4095]);

    /* an element across the page end faults whole */
    base[4092] = 7;
    rep_stos(8, base + 4092, -1, 4);
    line("stosq rcx", f_rcx);
    line("stosq rdi", f_rdi - (long) base);
    line("stosq kept", base[4092]);

    /* a load fault writes nothing for that element */
    for (int i = 0; i < 8; i++) dst[i] = 0x55;
    rep_movs(8, dst, base + 4096 - 16, 5);
    line("movsq rcx", f_rcx);
    line("movsq rsi", f_rsi - (long) base);
    line("movsq kept", dst[2]);
    line("faults", faults);

    /* overlapping forward copy repeats the first byte */
    char o[17] = "abcdefghijklmnop";
    rep_movs(1, o + 1, o, 15);
    put(o);
    put("\n");

    /* a newer mapping inside the range takes its part of a stos */
    char* m = (char*) 0x7e0000100000;
    sys6(NR_MMAP, (long) m, 4 * 4096, 3, MAP_FIXED_ANON, -1, 0);
    sys6(NR_MMAP, (long) (m + 4096), 4096, 3, MAP_FIXED_ANON, -1, 0);
    rep_stos(1, m, 9, 4 * 4096);
    line("stosb over a newer mapping", m[4096] + m[4 * 4096 - 1]);

    /* 3 MiB: stos a pattern, copy it, sum it */
    long big = 3 << 20;
    long* p = (long*) sys6(NR_MMAP, 0, 2 * big, 3, MAP_ANON, -1, 0);
    for (long i = 0; i < big / 8; i += 4096) p[i] = i;
    rep_movs(8, p + big / 8, p, big / 8);
    long sum = 0;
    for (long i = 0; i < big / 8; i += 4096) sum += p[big / 8 + i];
    rep_stos(8, p, 3, big / 8);
    line("copied sum", sum);
    line("filled", p[big / 8 - 1]);

    struct ksigaction wa = {on_walk, SA_SIGINFO | SA_RESTORER, restore_rt, 0};
    sys6(NR_SIGACTION, SIGSEGV, (long) &wa, 0, 8, 0, 0);
    long* w = (long*) (base + 4096) - 512;
    for (long i = 0; i < 512; i++) w[i] = i;
    walk(w, 600);
    line("walk rip at the load", w_rip == (long) walk_fault);
    line("walk rcx", w_rcx);
    line("walk rax", w_rax);

    struct ksigaction fa = {on_fpe, SA_SIGINFO | SA_RESTORER, restore_rt, 0};
    sys6(NR_SIGACTION, SIGFPE, (long) &fa, 0, 8, 0, 0);
    long min = (long) (1ul << 63);
    div_line("divq by zero", DIVQ, 5, 0, 0);
    div_line("divq overflow", DIVQ, 5, 3, 3);
    div_line(
        "divq wide", DIVQ, 0x123456789abcdef0, 0x0fedcba987654321,
        0x7fffffffffffffff
    );
    div_line("idivq min by -1", IDIVQ, min, -1, -1);
    div_line("idivq 2^63 by 1", IDIVQ, min, 0, 1);
    div_line("idivq -2^63 by 1", IDIVQ, min, -1, 1);
    div_line("idivq -2^63 by -2", IDIVQ, min, -1, -2);
    div_line(
        "idivq wide", IDIVQ, 0x123456789abcdef0, -0x0fedcba987654321,
        0x7fffffffffffffff
    );
    div_line("idivl min by -1", IDIVL, 0x80000000, 0xffffffff, 0xffffffff);
    div_line("divb overflow", DIVB, 0x0400, 0, 2);

    sys(NR_WRITE, 1, (long) out, used);
    sys(NR_EXIT, 0, 0, 0);
}
