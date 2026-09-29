#include <stdint.h>

#include "prim-bodies.h"

#if defined(__x86_64__)
    #define NR_WRITE 1
    #define NR_MMAP 9
    #define NR_MUNMAP 11
    #define NR_SIGACTION 13
    #define NR_EXIT 60
    #define MC 40
    #define MC_X0 (MC + 13 * 8)
    #define MC_SP (MC + 15 * 8)
    #define MC_PC (MC + 16 * 8)
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
        "prim_main\n hlt\n"
        ".globl restore_rt\nrestore_rt:\n mov $15, %eax\n syscall\n");
static volatile long saved_sp;
/* the function is called with its caller's registers as the ABI has them; a
 * fault resumes at try_done with rax -1 */
__attribute__((noinline)) static long try_call(
    void* fn, long a, long b, long c
) {
    long r;
    __asm__ volatile("mov %%rsp, %[sp]\n call *%[fn]\n"
                     ".globl try_done\ntry_done:\n"
                     : "=&a"(r), [sp] "=m"(saved_sp)
                     : [fn] "r"(fn), "D"(a), "S"(b), "d"(c)
                     : "rcx", "r8", "r9", "r10", "r11", "memory", "cc");
    return r;
}
#elif defined(__aarch64__)
    #define NR_WRITE 64
    #define NR_MMAP 222
    #define NR_MUNMAP 215
    #define NR_SIGACTION 134
    #define NR_EXIT 93
    #define MC 176
    #define MC_X0 (MC + 8)
    #define MC_PC (MC + 8 + 8 * 32)
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
__asm__(".globl _start\n_start:\n bl prim_main\n"
        ".globl restore_rt\nrestore_rt:\n mov x8, #139\n svc 0\n");
__attribute__((noinline)) static long try_call(
    void* fn, long a, long b, long c
) {
    register long x0 __asm__("x0") = a;
    register long x1 __asm__("x1") = b;
    register long x2 __asm__("x2") = c;
    register void* x9 __asm__("x9") = fn;
    __asm__ volatile("blr x9\n"
                     ".globl try_done\ntry_done:\n"
                     : "+r"(x0), "+r"(x1), "+r"(x2), "+r"(x9)
                     :
                     : "x3", "x4", "x5", "x6", "x7", "x8", "x10", "x11", "x12",
                       "x13", "x14", "x15", "x16", "x17", "x30", "memory",
                       "cc");
    return x0;
}
#endif
#define sys(n, a, b, c) sys6(n, a, b, c, 0, 0, 0)
#define SA_SIGINFO 4
#define SA_RESTORER 0x04000000
#define SIGSEGV 11
#define MAP_FIXED_ANON 0x32 /* MAP_PRIVATE | MAP_FIXED | MAP_ANONYMOUS */
void restore_rt(void);
extern char try_done[];
long prim_strlen(const char*), prim_memcmp(const void*, const void*, long),
    prim_strcmp(const char*, const char*), prim_memchr(const void*, long, long);

static char out[8192];
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

struct ksigaction {
    void (*handler)(int, void*, void*);
    unsigned long flags;
    void (*restorer)(void);
    unsigned long mask;
};

static volatile long faults, f_addr;
static void on_segv(int s, void* info, void* uc) {
    (void) s;
    long* mc = (long*) uc;
    f_addr = ((long*) info)[2];
    faults++;
    mc[MC_X0 / 8] = -1;
    mc[MC_PC / 8] = (long) try_done;
#if defined(__x86_64__)
    mc[MC_SP / 8] = saved_sp;
#endif
}

/* one call: its result, and where it faulted (an offset from ref) if it did */
static void call(
    const char* name, void* fn, const char* ref, const void* a, long b, long c
) {
    long before = faults;
    long r = try_call(fn, (long) a, b, c);
    put(name);
    put(" ");
    if (faults != before) {
        put("fault ");
        num(f_addr - (long) ref);
    }
    else if (fn == (void*) prim_memchr)
        num(r ? r - (long) ref : -9999);
    else if (fn == (void*) prim_strlen)
        num(r);
    else
        num((int) r);
    put("\n");
}

static void fill(char* p, int c, long n) {
    for (long i = 0; i < n; i++) p[i] = (char) c;
}

void prim_main(void) {
    struct ksigaction a = {on_segv, SA_SIGINFO | SA_RESTORER, restore_rt, 0};
    sys6(NR_SIGACTION, SIGSEGV, (long) &a, 0, 8, 0, 0);
    /* A: one page and a hole; B: two mappings side by side; C: a page, a
     * PROT_NONE page, a page */
    char* A = (char*) 0x7e0000000000;
    char* B = A + 0x10000;
    char* C = A + 0x20000;
    sys6(NR_MMAP, (long) A, 8192, 3, MAP_FIXED_ANON, -1, 0);
    sys(NR_MUNMAP, (long) (A + 4096), 4096, 0);
    sys6(NR_MMAP, (long) B, 4096, 3, MAP_FIXED_ANON, -1, 0);
    sys6(NR_MMAP, (long) (B + 4096), 4096, 3, MAP_FIXED_ANON, -1, 0);
    sys6(NR_MMAP, (long) C, 4096, 3, MAP_FIXED_ANON, -1, 0);
    sys6(NR_MMAP, (long) (C + 4096), 4096, 0, MAP_FIXED_ANON, -1, 0);
    sys6(NR_MMAP, (long) (C + 8192), 4096, 3, MAP_FIXED_ANON, -1, 0);

    fill(A, 'x', 4096);
    fill(B, 'x', 8192);
    fill(C, 'x', 4096);
    fill(C + 8192, 'x', 4096);
    /* A + 100: 50 x's and a NUL; A + 2000: "abc" */
    A[150] = 0;
    A[2000] = 'a', A[2001] = 'b', A[2002] = 'c', A[2003] = 0;
    A[3000] = 'a', A[3001] = 'b', A[3002] = 'd', A[3003] = 0;
    A[2100] = 'q';
    B[4150] = 0;
    B[4100] = 'q';
    A[3500] = 0;

    call("strlen in a page", (void*) prim_strlen, A, A + 3400, 0, 0);
    A[4095] = 0;
    call(
        "strlen ends at the last byte", (void*) prim_strlen, A, A + 4000, 0, 0
    );
    A[4095] = 'x';
    call("strlen runs off the page", (void*) prim_strlen, A, A + 4090, 0, 0);
    call("strlen unaligned off", (void*) prim_strlen, A, A + 4093, 0, 0);
    call("strlen in the hole", (void*) prim_strlen, A, A + 4096, 0, 0);
    call("strlen across mappings", (void*) prim_strlen, B, B + 4000, 0, 0);
    call("strlen into PROT_NONE", (void*) prim_strlen, C, C + 4090, 0, 0);

    call("memcmp equal", (void*) prim_memcmp, A, A + 100, (long) (A + 200), 40);
    call(
        "memcmp differs early", (void*) prim_memcmp, A, A + 2000,
        (long) (A + 3000), 1 << 20
    );
    call(
        "memcmp a runs off", (void*) prim_memcmp, A, A + 4090, (long) (A + 100),
        64
    );
    call(
        "memcmp b runs off", (void*) prim_memcmp, A, A + 100, (long) (A + 4090),
        64
    );
    call(
        "memcmp n 0 in the hole", (void*) prim_memcmp, A, A + 4096,
        (long) (A + 4096), 0
    );
    call(
        "memcmp across mappings", (void*) prim_memcmp, B, B + 4000,
        (long) (B + 5000), 300
    );
    call(
        "memcmp into PROT_NONE", (void*) prim_memcmp, C, C + 4090,
        (long) (C + 200), 64
    );

    call("strcmp equal", (void*) prim_strcmp, A, A + 100, (long) (A + 100), 0);
    call(
        "strcmp differs", (void*) prim_strcmp, A, A + 2000, (long) (A + 3000), 0
    );
    call(
        "strcmp differs, reversed", (void*) prim_strcmp, A, A + 3000,
        (long) (A + 2000), 0
    );
    call(
        "strcmp a runs off", (void*) prim_strcmp, A, A + 4090, (long) (A + 100),
        0
    );
    call(
        "strcmp b in the hole", (void*) prim_strcmp, A, A + 2000,
        (long) (A + 4096), 0
    );
    A[4095] = 'y';
    fill(A + 300, 'x', 5);
    A[305] = 'z';
    A[306] = 0;
    call(
        "strcmp differs before the page end", (void*) prim_strcmp, A, A + 4090,
        (long) (A + 300), 0
    );
    A[4095] = 'x';
    call(
        "strcmp across mappings", (void*) prim_strcmp, B, B + 4000,
        (long) (B + 4000), 0
    );

    call("memchr in a page", (void*) prim_memchr, A, A + 2000, 'q', 400);
    call(
        "memchr huge n, match early", (void*) prim_memchr, A, A + 2000, 'q',
        1L << 40
    );
    call("memchr runs off", (void*) prim_memchr, A, A + 4000, 'z', 200);
    call("memchr n 0 in the hole", (void*) prim_memchr, A, A + 4096, 'q', 0);
    call(
        "memchr unaligned runs off", (void*) prim_memchr, A, A + 4093, 'z', 10
    );
    call("memchr across mappings", (void*) prim_memchr, B, B + 4090, 'q', 100);
    A[4095] = 'q';
    call("memchr last byte", (void*) prim_memchr, A, A + 4000, 'q', 96);
    call("memchr past the end of n", (void*) prim_memchr, A, A + 4000, 'q', 95);
    A[4095] = 'x';
    call("memchr into PROT_NONE", (void*) prim_memchr, C, C + 4090, 'z', 100);

    put("faults ");
    num(faults);
    put("\n");
    sys(NR_WRITE, 1, (long) out, used);
    sys(NR_EXIT, 0, 0, 0);
}
