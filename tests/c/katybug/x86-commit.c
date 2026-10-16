#include <stdint.h>

#define NR_WRITE 1
#define NR_MMAP 9
#define NR_MPROTECT 10
#define NR_SIGACTION 13
#define NR_GETPID 39
#define NR_EXIT 60
#define NR_SIGALTSTACK 131
#define SA_SIGINFO 4
#define SA_ONSTACK 0x08000000
#define SA_RESTORER 0x04000000
#define SIGUSR1 10
#define SIGSEGV 11
#define MAP_FIXED_ANON 0x32
#define PAGE 4096L
#define AREA 0x30000000L /* two mapped pages, then a PROT_NONE page */
#define END (AREA + 2 * PAGE)
#define HOLE                                                                   \
    0x38000000L /* one page per case, 64 KiB apart, mapped by the handler */
#define MC 40
#define EFL 0x8c5 /* CF PF ZF SF OF: AF is not modeled */

static inline __attribute__((always_inline)) long sys6(
    long n, long a, long b, long c, long d, long e, long f
) {
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

__asm__(".text\n"
        ".globl _start\n_start:\n xor %rbp, %rbp\n mov %rsp, %rdi\n and $-16, "
        "%rsp\n call commit_main\n hlt\n"
        ".globl restore_rt\nrestore_rt:\n mov $15, %eax\n syscall\n"
        ".globl ret_target\nret_target:\n ret\n"
        ".globl callf\ncallf:\n push %rdx\n popfq\n mov %rdi, %rax\n mov %rsi, "
        "%rdi\n jmp *%rax\n");
void restore_rt(void);
/* f(arg) entered with the flags register set to `flags` */
long callf(long (*f)(long), long arg, long flags);

struct ksigaction {
    void (*handler)(int, void*, void*);
    unsigned long flags;
    void (*restorer)(void);
    unsigned long mask;
};
struct kstack {
    void* sp;
    int flags;
    long size;
};

enum
{
    MAP = 1,
    SKIP = 2,
    FLIP = 3
};
static volatile long mode, adv, how, hits, fillv, fillat, tailat, retaddr;
static volatile long h_addr, h_rip, h_rsp, h_rax, h_rbx, h_rcx, h_rdx, h_rsi;
static volatile long h_rdi, h_rbp, h_r8, h_efl, h_tail;
static volatile long u_hits, u_rbx, u_r12;
static char astack[16384] __attribute__((aligned(16)));

/* records the frame, then maps the page (or skips the instruction, or flips
   ZF in the frame and maps) so the access retries */
static void on_segv(int s, void* info, void* uc) {
    (void) s;
    long* g = (long*) ((char*) uc + MC);
    long a = ((long*) info)[2];
    hits++;
    h_addr = a;
    h_rip = g[16];
    h_rsp = g[15];
    h_rax = g[13];
    h_rbx = g[11];
    h_rcx = g[14];
    h_rdx = g[12];
    h_rsi = g[9];
    h_rdi = g[8];
    h_rbp = g[10];
    h_r8 = g[0];
    h_efl = g[17] & EFL;
    h_tail = tailat ? *(volatile long*) tailat : 0;
    if (mode == SKIP) {
        g[16] += adv;
        return;
    }
    if (mode == FLIP) g[17] ^= 0x40;
    long page = a & ~(PAGE - 1);
    if (how == 0)
        sys(NR_MPROTECT, page, PAGE, 3);
    else
        sys6(NR_MMAP, page, PAGE, 3, MAP_FIXED_ANON, -1, 0);
    if (fillat) *(volatile long*) fillat = fillv ? fillv : retaddr;
}

static void on_usr1(int s, void* info, void* uc) {
    (void) s;
    (void) info;
    long* g = (long*) ((char*) uc + MC);
    u_hits++;
    u_rbx = g[11];
    u_r12 = g[4];
}

static char out[16384];
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
static void line(const char* k, long a, long b, long c, long d, long e) {
    put(k);
    long v[5] = {a, b, c, d, e};
    for (int i = 0; i < 5; i++) {
        put(" ");
        num(v[i]);
    }
    put("\n");
}

static void reset(long m, long hole) {
    mode = m;
    adv = 0;
    how = hole;
    hits = 0;
    fillv = fillat = tailat = 0;
    h_addr = h_rip = h_rsp = h_rax = h_rbx = h_rcx = h_rdx = h_rsi = 0;
    h_rdi = h_rbp = h_r8 = h_efl = h_tail = 0;
    sys6(NR_MMAP, AREA, 3 * PAGE, 3, MAP_FIXED_ANON, -1, 0);
}
static long hole(long k) {
    return HOLE + k * 0x10000L;
}
static void closed(void) {
    sys(NR_MPROTECT, END, PAGE, 0);
}

extern char ld_insn[], ld4_insn[], st_insn[], push_insn[], call_insn[],
    calld_insn[], ret_insn[], leave_insn[], xchg_insn[], cmpxchg_insn[],
    sc_insn[], sc_after[];

extern char ret_target[];

/* a load whose destination is its base register: the destination stays the
   base until the load completes */
__attribute__((noinline)) static long c_ld(long base) {
    register long rax __asm__("rax") = base;
    __asm__ volatile(".globl ld_insn\nld_insn: mov (%%rax), %%rax\n"
                     : "+a"(rax)
                     :
                     : "memory");
    return rax;
}
__attribute__((noinline)) static long c_ld4(long base) {
    register long rax __asm__("rax") = base;
    __asm__ volatile(".globl ld4_insn\nld4_insn: mov (%%rax), %%eax\n"
                     : "+a"(rax)
                     :
                     : "memory");
    return rax;
}
__attribute__((noinline)) static void c_st(long addr, long v) {
    register long rcx __asm__("rcx") = addr;
    register long rbx __asm__("rbx") = v;
    __asm__ volatile(".globl st_insn\nst_insn: mov %%rbx, (%%rcx)\n"
                     :
                     : "c"(rcx), "b"(rbx)
                     : "memory");
}
/* the stack pointer is moved onto `top` for one instruction */
__attribute__((noinline)) static long c_push(long top, long v) {
    long saved, after;
    __asm__ volatile("mov %%rsp, %[s]\n mov %[t], %%rsp\n"
                     ".globl push_insn\npush_insn: push %[v]\n"
                     "mov %%rsp, %[a]\n mov %[s], %%rsp\n"
                     : [s] "=&r"(saved), [a] "=&r"(after)
                     : [t] "r"(top), [v] "r"(v)
                     : "memory");
    return after;
}
__attribute__((noinline)) static long c_call(long top, long target) {
    long saved, after;
    __asm__ volatile("mov %%rsp, %[s]\n mov %[t], %%rsp\n"
                     ".globl call_insn\ncall_insn: call *%[f]\n"
                     "mov %%rsp, %[a]\n mov %[s], %%rsp\n"
                     : [s] "=&r"(saved), [a] "=&r"(after)
                     : [t] "r"(top), [f] "r"(target)
                     : "memory");
    return after;
}
__attribute__((noinline)) static long c_calld(long top) {
    long saved, after;
    __asm__ volatile("mov %%rsp, %[s]\n mov %[t], %%rsp\n"
                     ".globl calld_insn\ncalld_insn: call ret_target\n"
                     "mov %%rsp, %[a]\n mov %[s], %%rsp\n"
                     : [s] "=&r"(saved), [a] "=&r"(after)
                     : [t] "r"(top)
                     : "memory");
    return after;
}
__attribute__((noinline)) static long c_ret(long top) {
    long saved, after, tmp;
    __asm__ volatile(
        "mov %%rsp, %[s]\n mov %[t], %%rsp\n"
        "lea 1f(%%rip), %[x]\n mov %[x], %[r]\n"
        ".globl ret_insn\nret_insn: ret\n"
        "1: mov %%rsp, %[a]\n mov %[s], %%rsp\n"
        : [s] "=&r"(saved), [a] "=&r"(after), [x] "=&r"(tmp), [r] "=m"(retaddr)
        : [t] "r"(top)
        : "memory"
    );
    return after;
}
__attribute__((noinline)) static long c_leave(long top) {
    long saved, after;
    __asm__ volatile("mov %%rsp, %[s]\n mov %[t], %%rbp\n"
                     ".globl leave_insn\nleave_insn: leave\n"
                     "mov %%rsp, %[a]\n mov %[s], %%rsp\n"
                     : [s] "=&r"(saved), [a] "=&r"(after)
                     : [t] "r"(top)
                     : "rbp", "memory");
    return after;
}
__attribute__((noinline)) static long c_xchg(long addr, long v) {
    register long rbx __asm__("rbx") = v;
    __asm__ volatile(".globl xchg_insn\nxchg_insn: xchg %%rbx, (%%rcx)\n"
                     : "+b"(rbx)
                     : "c"(addr)
                     : "memory");
    return rbx;
}
__attribute__((noinline)) static long c_cmpxchg(long addr, long expect) {
    register long rax __asm__("rax") = expect;
    long zf;
    __asm__ volatile(".globl cmpxchg_insn\ncmpxchg_insn: lock cmpxchg %%rdx, "
                     "(%%rcx)\n sete %b[z]\n"
                     : "+a"(rax), [z] "=&q"(zf)
                     : "c"(addr), "d"(0x77L)
                     : "memory", "cc");
    return rax * 2 + (zf & 1);
}

__attribute__((noinline)) static void c_stosb(long dst, long n) {
    __asm__ volatile("rep stosb" : "+D"(dst), "+c"(n) : "a"(0xab) : "memory");
}
__attribute__((noinline)) static void c_stosq(long dst, long n) {
    __asm__ volatile("rep stosq"
                     : "+D"(dst), "+c"(n)
                     : "a"(0x1122334455667788L)
                     : "memory");
}
__attribute__((noinline)) static void c_movsb(long dst, long src, long n) {
    __asm__ volatile("rep movsb" : "+D"(dst), "+S"(src), "+c"(n) : : "memory");
}
__attribute__((noinline)) static void c_movsq(long dst, long src, long n) {
    __asm__ volatile("rep movsq" : "+D"(dst), "+S"(src), "+c"(n) : : "memory");
}

/* an access of width w at the end of the mapped pages, half of it on the
   PROT_NONE page */
#define LD_AT(name, insn)                                                      \
    __attribute__((noinline)) static long name(long addr) {                    \
        register long rax __asm__("rax") = 0x5a5a5a5a5a5a5a5aL;                \
        __asm__ volatile(insn : "+a"(rax) : "c"(addr) : "memory");             \
        return rax;                                                            \
    }
LD_AT(c_ld2, "movzwl (%%rcx), %%eax")
LD_AT(c_ld4s, "mov (%%rcx), %%eax")
LD_AT(c_ld8s, "mov (%%rcx), %%rax")
#define ST_AT(name, insn)                                                      \
    __attribute__((noinline)) static void name(long addr) {                    \
        register long rax __asm__("rax") = 0x1122334455667788L;                \
        __asm__ volatile(insn : : "a"(rax), "c"(addr) : "memory");             \
    }
ST_AT(c_st2, "mov %%ax, (%%rcx)")
ST_AT(c_st4, "mov %%eax, (%%rcx)")
ST_AT(c_st8, "mov %%rax, (%%rcx)")

/* flags from a setup, a store that faults, and a jz after the retry */
#define FCASE(name, setup)                                                     \
    __attribute__((noinline)) static long name(long addr) {                    \
        long r;                                                                \
        __asm__ volatile(                                                      \
            "mov %[a], %%rcx\n mov $0x1234, %%rdx\n " setup "\n"               \
            ".globl " #name "_insn\n" #name "_insn: mov %%rdx, "               \
            "(%%rcx)\n jz 1f\n mov $1, %[r]\n jmp 2f\n1: mov $2, "             \
            "%[r]\n2: test %%rbx, %%rbx\n"                                     \
            : [r] "=&r"(r)                                                     \
            : [a] "r"(addr)                                                    \
            : "rcx", "rdx", "rbx", "cc", "memory"                              \
        );                                                                     \
        return r;                                                              \
    }                                                                          \
    extern char name##_insn[];
FCASE(f_eq, "mov $3, %%rbx\n cmp $3, %%rbx")
FCASE(f_lt, "mov $1, %%rbx\n cmp $2, %%rbx")
FCASE(f_ov, "mov $0x7fffffffffffffff, %%rbx\n add $1, %%rbx")
FCASE(f_nz, "mov $0x80, %%ebx\n test %%bl, %%bl\n cmp $5, %%ebx")

/* the store is skipped: its three bytes are jumped over */
__attribute__((noinline)) static long c_skip(long addr) {
    long r;
    __asm__ volatile("mov %[a], %%rcx\n mov $0x1234, %%rdx\n"
                     "mov $9, %[r]\n"
                     ".globl skip_insn\nskip_insn: .byte 0x48, 0x89, 0x11\n"
                     "add $1, %[r]\n"
                     : [r] "=&r"(r)
                     : [a] "r"(addr)
                     : "rcx", "rdx", "cc", "memory");
    return r;
}
extern char skip_insn[];

/* a syscall: rcx is the return address and r11 the flags before it */
__attribute__((noinline)) static void c_syscall(long* o) {
    long c, f, a;
    __asm__ volatile("mov $39, %%eax\n mov $1, %%rbx\n cmp $2, %%rbx\n"
                     ".globl sc_insn\nsc_insn: syscall\n"
                     ".globl sc_after\nsc_after: mov %%rcx, %[c]\n"
                     "mov %%r11, %[f]\n mov %%rax, %[a]\n"
                     : [c] "=&r"(c), [f] "=&r"(f), [a] "=&r"(a)
                     :
                     : "rax", "rbx", "rcx", "r11", "cc", "memory");
    o[0] = c;
    o[1] = f;
    o[2] = a;
}

/* rbx and r12 stay equal; a signal arrives at iteration `at` */
__attribute__((noinline)) static long c_sigloop(long n, long at, long pid) {
    long a, b;
    __asm__ volatile("xor %%ebx, %%ebx\n xor %%r12d, %%r12d\n"
                     "1: inc %%rbx\n inc %%r12\n cmp %[at], %%rbx\n jne 2f\n"
                     "mov $62, %%eax\n mov %[p], %%rdi\n mov $10, %%esi\n"
                     "syscall\n"
                     "2: cmp %[n], %%rbx\n jb 1b\n"
                     "mov %%rbx, %[a]\n mov %%r12, %[b]\n"
                     : [a] "=&r"(a), [b] "=&r"(b)
                     : [n] "r"(n), [at] "r"(at), [p] "r"(pid)
                     : "rax", "rbx", "rcx", "rdi", "rsi", "r11", "r12", "cc",
                       "memory");
    return a * 1000 + (a - b);
}

/* multiword add and subtract with the carry across the words */
static uint64_t seed = 0x9e3779b97f4a7c15UL;
static uint64_t next(void) {
    seed ^= seed << 13;
    seed ^= seed >> 7;
    seed ^= seed << 17;
    return seed;
}
__attribute__((noinline)) static long c_chain(
    int sub, uint64_t* x, uint64_t* y, uint64_t* z
) {
    long c;
    if (sub)
        __asm__ volatile(
            "mov (%[x]), %%rax\n sub (%[y]), %%rax\n"
            "mov %%rax, (%[z])\n mov 8(%[x]), %%rax\n"
            "sbb 8(%[y]), %%rax\n mov %%rax, 8(%[z])\n"
            "mov 16(%[x]), %%rax\n sbb 16(%[y]), %%rax\n"
            "mov %%rax, 16(%[z])\n mov 24(%[x]), %%rax\n"
            "sbb 24(%[y]), %%rax\n mov %%rax, 24(%[z])\n"
            "sbb %%rax, %%rax\n mov %%rax, %[c]\n test %%rax, %%rax\n"
            : [c] "=&r"(c)
            : [x] "r"(x), [y] "r"(y), [z] "r"(z)
            : "rax", "cc", "memory"
        );
    else
        __asm__ volatile(
            "mov (%[x]), %%rax\n add (%[y]), %%rax\n"
            "mov %%rax, (%[z])\n mov 8(%[x]), %%rax\n"
            "adc 8(%[y]), %%rax\n mov %%rax, 8(%[z])\n"
            "mov 16(%[x]), %%rax\n adc 16(%[y]), %%rax\n"
            "mov %%rax, 16(%[z])\n mov 24(%[x]), %%rax\n"
            "adc 24(%[y]), %%rax\n mov %%rax, 24(%[z])\n"
            "sbb %%rax, %%rax\n mov %%rax, %[c]\n test %%rax, %%rax\n"
            : [c] "=&r"(c)
            : [x] "r"(x), [y] "r"(y), [z] "r"(z)
            : "rax", "cc", "memory"
        );
    return c;
}

/* inc and dec keep the carry */
__attribute__((noinline)) static long c_incdec(long v, int dec, int carry) {
    long r = 0;
    unsigned char c = 0, z = 0, o = 0, s = 0;
    if (dec) {
        if (carry)
            __asm__ volatile("stc\n dec %[v]\n setc %[c]\n setz %[z]\n"
                             "seto %[o]\n sets %[s]\n test %[v], %[v]\n"
                             : [v] "+r"(v), [c] "=&q"(c), [z] "=&q"(z),
                               [o] "=&q"(o), [s] "=&q"(s)
                             :
                             : "cc");
        else
            __asm__ volatile("clc\n dec %[v]\n setc %[c]\n setz %[z]\n"
                             "seto %[o]\n sets %[s]\n test %[v], %[v]\n"
                             : [v] "+r"(v), [c] "=&q"(c), [z] "=&q"(z),
                               [o] "=&q"(o), [s] "=&q"(s)
                             :
                             : "cc");
    }
    else {
        if (carry)
            __asm__ volatile("stc\n inc %[v]\n setc %[c]\n setz %[z]\n"
                             "seto %[o]\n sets %[s]\n test %[v], %[v]\n"
                             : [v] "+r"(v), [c] "=&q"(c), [z] "=&q"(z),
                               [o] "=&q"(o), [s] "=&q"(s)
                             :
                             : "cc");
        else
            __asm__ volatile("clc\n inc %[v]\n setc %[c]\n setz %[z]\n"
                             "seto %[o]\n sets %[s]\n test %[v], %[v]\n"
                             : [v] "+r"(v), [c] "=&q"(c), [z] "=&q"(z),
                               [o] "=&q"(o), [s] "=&q"(s)
                             :
                             : "cc");
    }
    r = c | z << 1 | o << 2 | s << 3;
    return r * 4 + (v & 3);
}

/* every condition code after one flag-setting instruction */
#define CONDS                                                                  \
    "seto 0(%[m])\n setno 1(%[m])\n setb 2(%[m])\n setae 3(%[m])\n"            \
    "sete 4(%[m])\n setne 5(%[m])\n setbe 6(%[m])\n seta 7(%[m])\n"            \
    "sets 8(%[m])\n setns 9(%[m])\n setp 10(%[m])\n setnp 11(%[m])\n"          \
    "setl 12(%[m])\n setge 13(%[m])\n setle 14(%[m])\n setg 15(%[m])\n"        \
    "test %[m], %[m]\n"
#define BIN(name, pre, insn, w)                                                \
    __attribute__((noinline)) static void name(                                \
        unsigned long a, unsigned long b, unsigned char* m                     \
    ) {                                                                        \
        __asm__ volatile(pre insn " %" #w "[b], %" #w "[a]\n" CONDS            \
                         : [a] "+r"(a)                                         \
                         : [b] "r"(b), [m] "r"(m)                              \
                         : "cc", "memory");                                    \
    }
#define UN(name, pre, insn, w)                                                 \
    __attribute__((noinline)) static void name(                                \
        unsigned long a, unsigned long b, unsigned char* m                     \
    ) {                                                                        \
        (void) b;                                                              \
        __asm__ volatile(pre insn " %" #w "[a]\n" CONDS                        \
                         : [a] "+r"(a)                                         \
                         : [m] "r"(m)                                          \
                         : "cc", "memory");                                    \
    }
#define SH(name, pre, insn, cnt, w)                                            \
    __attribute__((noinline)) static void name(                                \
        unsigned long a, unsigned long b, unsigned char* m                     \
    ) {                                                                        \
        __asm__ volatile(pre insn " " cnt ", %" #w "[a]\n" CONDS               \
                         : [a] "+r"(a)                                         \
                         : [b] "r"(b), [m] "r"(m)                              \
                         : "cc", "memory");                                    \
    }
#define SET(pre) pre
#define FOUR(m, pre, insn)                                                     \
    BIN(m##_b, pre, insn, b)                                                   \
    BIN(m##_w, pre, insn, w)                                                   \
    BIN(m##_k, pre, insn, k)                                                   \
    BIN(m##_q, pre, insn, q)
#define FOUR_UN(m, pre, insn)                                                  \
    UN(m##_b, pre, insn, b)                                                    \
    UN(m##_w, pre, insn, w)                                                    \
    UN(m##_k, pre, insn, k)                                                    \
    UN(m##_q, pre, insn, q)
#define FOUR_SH(m, pre, insn, cnt)                                             \
    SH(m##_b, pre, insn, cnt, b)                                               \
    SH(m##_w, pre, insn, cnt, w)                                               \
    SH(m##_k, pre, insn, cnt, k)                                               \
    SH(m##_q, pre, insn, cnt, q)
FOUR(k_add, "", "add")
FOUR(k_sub, "", "sub")
FOUR(k_and, "", "and")
FOUR(k_or, "", "or")
FOUR(k_xor, "", "xor")
FOUR(k_adc0, "clc\n ", "adc")
FOUR(k_adc1, "stc\n ", "adc")
FOUR(k_sbb0, "clc\n ", "sbb")
FOUR(k_sbb1, "stc\n ", "sbb")
FOUR(k_cmp, "", "cmp")
FOUR(k_test, "", "test")
FOUR_UN(k_neg, "", "neg")
FOUR_UN(k_inc1, "stc\n ", "inc")
FOUR_UN(k_inc0, "clc\n ", "inc")
FOUR_UN(k_dec1, "stc\n ", "dec")
FOUR_UN(k_dec0, "clc\n ", "dec")
FOUR_SH(k_shl1, "", "shl", "$1")
FOUR_SH(k_shr1, "", "shr", "$1")
FOUR_SH(k_sar1, "", "sar", "$1")
FOUR_SH(k_rol1, "cmp %[b], %[b]\n ", "rol", "$1")
FOUR_SH(k_ror1, "cmp %[b], %[b]\n ", "ror", "$1")
FOUR_SH(k_shl3, "", "shl", "$3")
FOUR_SH(k_shr3, "", "shr", "$3")
FOUR_SH(k_sar3, "", "sar", "$3")

typedef void (*kernel)(unsigned long, unsigned long, unsigned char*);
static const unsigned long vals[] = {
    0,
    1,
    2,
    0x7f,
    0x80,
    0xff,
    0x7fff,
    0x8000,
    0xffff,
    0x7fffffffUL,
    0x80000000UL,
    0xffffffffUL,
    0x7fffffffffffffffUL,
    0x8000000000000000UL,
    ~0UL,
    0x123456789abcdefUL
};
#define NV (sizeof vals / sizeof vals[0])

/* the conditions a flag-setting instruction defines: `skip` drops the ones
   that read flags it leaves undefined (the overflow ones after a shift by
   more than 1) */
static void kinds(const char* name, kernel k, unsigned skip) {
    unsigned long h = 1469598103934665603UL;
    for (unsigned i = 0; i < NV; i++)
        for (unsigned j = 0; j < NV; j++) {
            unsigned char m[16];
            for (int c = 0; c < 16; c++) m[c] = 0xee;
            k(vals[i], vals[j], m);
            for (int c = 0; c < 16; c++)
                if (!(skip >> c & 1)) h = (h ^ m[c]) * 1099511628211UL;
        }
    line(name, (long) (h >> 1), 0, 0, 0, 0);
}
#define K(n, skip)                                                             \
    do {                                                                       \
        kinds(#n "_b", n##_b, skip);                                           \
        kinds(#n "_w", n##_w, skip);                                           \
        kinds(#n "_k", n##_k, skip);                                           \
        kinds(#n "_q", n##_q, skip);                                           \
    } while (0)

static int pick(const char* want, const char* name) {
    if (!want) return 1;
    while (*name)
        if (*want++ != *name++) return 0;
    return !*want;
}

static void fill(long at, long n) {
    for (long i = 0; i < n; i++)
        ((volatile long*) at)[i] = 0x0101010101010101L * (i + 1);
}

void commit_main(long* sp) {
    const char* only = sp[0] > 1 ? ((char**) (sp + 1))[1] : 0;
    struct kstack ss = {astack, 0, sizeof astack};
    sys(NR_SIGALTSTACK, (long) &ss, 0, 0);
    struct ksigaction sa = {
        on_segv, SA_SIGINFO | SA_ONSTACK | SA_RESTORER, restore_rt, 0
    };
    sys6(NR_SIGACTION, SIGSEGV, (long) &sa, 0, 8, 0, 0);
    struct ksigaction su = {
        on_usr1, SA_SIGINFO | SA_ONSTACK | SA_RESTORER, restore_rt, 0
    };
    sys6(NR_SIGACTION, SIGUSR1, (long) &su, 0, 8, 0, 0);
    sys6(NR_MMAP, AREA, 3 * PAGE, 3, MAP_FIXED_ANON, -1, 0);
    long r;
    long pg;

    if (pick(only, "ld-base")) {
        reset(MAP, 1);
        pg = hole(0);
        fillat = pg + 16;
        fillv = 0x1122334455667788L;
        r = c_ld(pg + 16);
        line(
            "ld-base", hits, h_addr - pg, h_rax - pg, h_rip - (long) ld_insn, r
        );
    }
    if (pick(only, "ld-base4")) {
        reset(MAP, 1);
        pg = hole(1);
        fillat = pg + 16;
        fillv = 0x1122334455667788L;
        r = c_ld4(pg + 16);
        line(
            "ld-base4", hits, h_addr - pg, h_rax - pg, h_rip - (long) ld4_insn,
            r
        );
    }
    if (pick(only, "st")) {
        reset(MAP, 1);
        pg = hole(2);
        c_st(pg + 24, 0x0f0e0d0c0b0a0908L);
        line(
            "st", hits, h_addr - pg, h_rcx - pg, h_rbx == 0x0f0e0d0c0b0a0908L,
            ((long*) pg)[3]
        );
    }
    /* the stack pointer sits 16 bytes into the page after the mapped ones, so
       the signal frame lands on the mapped pages below it */
    if (pick(only, "push")) {
        reset(MAP, 0);
        sys(NR_MPROTECT, END, PAGE, 1);
        pg = END + 16;
        r = c_push(pg, 0x4142434445464748L);
        line("push", hits, h_addr - END, h_rsp - pg, r - pg, ((long*) END)[1]);
    }
    if (pick(only, "call")) {
        reset(MAP, 0);
        sys(NR_MPROTECT, END, PAGE, 1);
        pg = END + 16;
        r = c_call(pg, (long) ret_target);
        line(
            "call", hits, h_addr - END, h_rsp - pg, r - pg,
            h_rip - (long) call_insn
        );
    }
    if (pick(only, "call-rel")) {
        reset(MAP, 0);
        sys(NR_MPROTECT, END, PAGE, 1);
        pg = END + 16;
        r = c_calld(pg);
        line(
            "call-rel", hits, h_addr - END, h_rsp - pg, r - pg,
            h_rip - (long) calld_insn
        );
    }
    if (pick(only, "ret")) {
        reset(MAP, 0);
        closed();
        pg = END + 16;
        fillat = pg;
        r = c_ret(pg);
        line(
            "ret", hits, h_addr - END, h_rsp - pg, r - pg,
            h_rip - (long) ret_insn
        );
    }
    if (pick(only, "leave")) {
        reset(MAP, 0);
        closed();
        pg = END + 16;
        fillat = pg;
        fillv = 0x2a2a2a2a2a2a2a2aL;
        r = c_leave(pg);
        line(
            "leave", hits, h_addr - END, h_rsp == pg, r - pg,
            h_rip - (long) leave_insn
        );
    }
    if (pick(only, "xchg")) {
        reset(MAP, 1);
        pg = hole(8);
        fillat = pg + 8;
        fillv = 0x6162636465666768L;
        r = c_xchg(pg + 8, 0x7172737475767778L);
        line("xchg", hits, h_addr - pg, h_rbx, r, ((long*) pg)[1]);
    }
    if (pick(only, "cmpxchg")) {
        reset(MAP, 1);
        pg = hole(9);
        fillat = pg + 8;
        fillv = 0x1111L;
        r = c_cmpxchg(pg + 8, 0x1111L);
        line("cmpxchg", hits, h_addr - pg, h_rax, r, ((long*) pg)[1]);
    }
    if (pick(only, "stosb")) {
        reset(MAP, 0);
        fill(END - 16, 2);
        closed();
        tailat = END - 8;
        c_stosb(END - 8, 32);
        line("stosb", hits, h_addr - END, h_rdi - END, h_rcx, h_tail);
        line(
            "stosb out", ((long*) END)[0], ((long*) END)[1], ((long*) END)[2],
            ((long*) END)[3], *(long*) (END - 8)
        );
    }
    if (pick(only, "stosq")) {
        reset(MAP, 0);
        closed();
        tailat = END - 16;
        c_stosq(END - 16, 4);
        line("stosq", hits, h_addr - END, h_rdi - END, h_rcx, h_tail);
        line(
            "stosq out", ((long*) END)[0], ((long*) END)[1], *(long*) (END - 8),
            *(long*) (END - 16), 0
        );
    }
    if (pick(only, "movsb-w")) {
        reset(MAP, 0);
        fill(AREA, 8);
        closed();
        tailat = END - 8;
        c_movsb(END - 8, AREA, 32);
        line("movsb-w", hits, h_addr - END, h_rdi - END, h_rcx, h_rsi - AREA);
        line(
            "movsb-w out", h_tail, *(long*) (END - 8), ((long*) END)[0],
            ((long*) END)[3], 0
        );
    }
    if (pick(only, "movsb-r")) {
        reset(MAP, 0);
        fill(END - 8, 1);
        closed();
        c_movsb(AREA + 0x100, END - 8, 32);
        line("movsb-r", hits, h_addr - END, h_rdi - AREA, h_rcx, h_rsi - END);
        line(
            "movsb-r out", ((long*) (AREA + 0x100))[0],
            ((long*) (AREA + 0x100))[1], ((long*) (AREA + 0x100))[2],
            ((long*) (AREA + 0x100))[3], 0
        );
    }
    if (pick(only, "movsq-w")) {
        reset(MAP, 0);
        fill(AREA, 8);
        closed();
        tailat = END - 16;
        c_movsq(END - 16, AREA, 4);
        line("movsq-w", hits, h_addr - END, h_rdi - END, h_rcx, h_rsi - AREA);
        line(
            "movsq-w out", h_tail, *(long*) (END - 8), ((long*) END)[0],
            ((long*) END)[1], 0
        );
    }
    if (pick(only, "movsq-r")) {
        reset(MAP, 0);
        fill(END - 16, 2);
        closed();
        c_movsq(AREA + 0x100, END - 16, 4);
        line("movsq-r", hits, h_addr - END, h_rdi - AREA, h_rcx, h_rsi - END);
        line(
            "movsq-r out", ((long*) (AREA + 0x100))[0],
            ((long*) (AREA + 0x100))[1], ((long*) (AREA + 0x100))[2],
            ((long*) (AREA + 0x100))[3], 0
        );
    }
    if (pick(only, "straddle")) {
        struct {
            const char* name;
            long w;
            int store;
        } t[] = {{"ld2", 2, 0}, {"ld4", 4, 0}, {"ld8", 8, 0},
                 {"st2", 2, 1}, {"st4", 4, 1}, {"st8", 8, 1}};
        for (int i = 0; i < 6; i++) {
            reset(MAP, 0);
            *(volatile long*) (END - 8) = 0x0101010101010101L;
            closed();
            tailat = END - 8;
            long at = END - t[i].w / 2;
            if (!t[i].store) {
                r = t[i].w == 2   ? c_ld2(at)
                    : t[i].w == 4 ? c_ld4s(at)
                                  : c_ld8s(at);
                line(t[i].name, hits, h_addr - END, h_tail, h_rax, r);
            }
            else {
                if (t[i].w == 2)
                    c_st2(at);
                else if (t[i].w == 4)
                    c_st4(at);
                else
                    c_st8(at);
                line(
                    t[i].name, hits, h_addr - END, h_tail, *(long*) (END - 8),
                    ((long*) END)[0]
                );
            }
        }
    }
    if (pick(only, "flags")) {
        /* each is entered with the flags it will not set, so a flag a fault
           leaves out of the frame shows */
        struct {
            const char* name;
            long (*f)(long);
            const char* insn;
            long efl;
        } t[] = {
            {"flags-eq", f_eq, f_eq_insn, 0x44},
            {"flags-lt", f_lt, f_lt_insn, 0x85},
            {"flags-ov", f_ov, f_ov_insn, 0x884},
            {"flags-nz", f_nz, f_nz_insn, 0x4}
        };
        for (int i = 0; i < 4; i++) {
            reset(MAP, 1);
            pg = hole(10 + i);
            r = callf(t[i].f, pg + 8, (EFL ^ t[i].efl) | 0x202);
            line(
                t[i].name, hits, h_addr - pg, h_efl, r, h_rip - (long) t[i].insn
            );
        }
        reset(FLIP, 1);
        pg = hole(14);
        r = callf(f_eq, pg + 8, (EFL ^ 0x44) | 0x202);
        line("flags-flip", hits, h_addr - pg, h_efl, r, ((long*) pg)[1]);
        reset(SKIP, 1);
        adv = 3;
        pg = hole(15);
        r = c_skip(pg + 8);
        line("flags-skip", hits, h_addr - pg, r, h_rip - (long) skip_insn, 0);
    }
    if (pick(only, "regs")) {
        reset(MAP, 1);
        pg = hole(16);
        c_st(pg + 8, 0x5555L);
        line("regs", h_rbx, h_rcx - pg, h_rdx, 0, 0);
    }
    /* katybug leaves r11 at 0x246 after a syscall, so only a named run prints
     * this */
    if (only && pick(only, "syscall")) {
        long o[3];
        c_syscall(o);
        line(
            "syscall", o[0] - (long) sc_after, o[1] & EFL, o[2] > 0,
            (long) sc_after - (long) sc_insn, 0
        );
    }
    if (pick(only, "sigloop")) {
        long pid = sys(NR_GETPID, 0, 0, 0);
        u_hits = 0;
        r = c_sigloop(5000, 1234, pid);
        line(
            "sigloop", u_hits, u_rbx - 1234, u_rbx - u_r12, r / 1000, r % 1000
        );
    }
    if (pick(only, "adc")) {
        uint64_t x[4], y[4], z[4];
        unsigned long h = 7;
        for (int it = 0; it < 400; it++) {
            for (int i = 0; i < 4; i++) {
                x[i] = next();
                y[i] = it % 5 == 0 ? ~x[i] : next();
                if (it % 7 == 0) x[i] = ~0UL;
                if (it % 11 == 0) y[i] = 1;
            }
            /* a carry into a word of ones, and a borrow through equal words */
            if (it % 26 == 0) {
                x[0] = ~0UL;
                y[0] = 1;
                y[1] = y[2] = ~0UL;
            }
            if (it % 26 == 13) {
                x[0] = 0;
                y[0] = 1;
                y[1] = x[1];
                y[2] = x[2];
            }
            long c = c_chain(it & 1, x, y, z);
            for (int i = 0; i < 4; i++) h = h * 1000003 ^ z[i];
            h = h * 31 + (unsigned long) c;
        }
        line("adc", (long) (h >> 1), 0, 0, 0, 0);
    }
    if (pick(only, "incdec")) {
        unsigned long h = 3;
        static const long vs[] = {
            0, 1, -1, 0x7fffffffffffffffL, -0x7fffffffffffffffL - 1
        };
        for (int d = 0; d < 2; d++)
            for (int c = 0; c < 2; c++)
                for (int i = 0; i < 5; i++) {
                    long v = c_incdec(vs[i], d, c);
                    h = h * 31 + (unsigned long) v;
                    line("incdec", d, c, i, v, 0);
                }
        line("incdec hash", (long) (h >> 1), 0, 0, 0, 0);
    }
    if (pick(only, "kinds")) {
        const unsigned ALL = 0, NOOV = 0xf003;
        K(k_add, ALL);
        K(k_sub, ALL);
        K(k_and, ALL);
        K(k_or, ALL);
        K(k_xor, ALL);
        K(k_adc0, ALL);
        K(k_adc1, ALL);
        K(k_sbb0, ALL);
        K(k_sbb1, ALL);
        K(k_cmp, ALL);
        K(k_test, ALL);
        K(k_neg, ALL);
        K(k_inc1, ALL);
        K(k_inc0, ALL);
        K(k_dec1, ALL);
        K(k_dec0, ALL);
        K(k_shl1, ALL);
        K(k_shr1, ALL);
        K(k_sar1, ALL);
        K(k_rol1, ALL);
        K(k_ror1, ALL);
        K(k_shl3, NOOV);
        K(k_shr3, NOOV);
        K(k_sar3, NOOV);
    }
    sys(NR_WRITE, 1, (long) out, used);
    sys(NR_EXIT, 0, 0, 0);
}
