#include <stdint.h>

#define NR_WRITE 1
#define NR_MMAP 9
#define NR_SIGACTION 13
#define NR_MUNMAP 11
#define NR_EXIT 60
#define MC 40
#define SA_SIGINFO 4
#define SA_RESTORER 0x04000000
#define SIGSEGV 11
#define MAP_FIXED_ANON 0x32

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

long gin[16], gout[16], gfault[16], saved_rsp, gflags, gfault_flags, gfault_rip;
__attribute__((aligned(16))) double xin[4] = {1.5, -2.25, 1e300, 3.0};
static volatile long faulted;
static long target;

__asm__(".globl _start\n_start:\n xor %rbp, %rbp\n and $-16, %rsp\n call "
        "rep_main\n hlt\n"
        ".globl restore_rt\nrestore_rt:\n mov $15, %eax\n syscall\n");
void restore_rt(void);

#define LD(i, r) " mov gin+" #i "*8(%rip), %" #r "\n"
#define ST(i, r) " mov %" #r ", gout+" #i "*8(%rip)\n"
#define LOADS                                                                  \
    LD(0, rax)                                                                 \
    LD(1, rcx)                                                                 \
    LD(2, rdx)                                                                 \
    LD(3, rbx)                                                                 \
    LD(5, rbp)                                                                 \
    LD(6, rsi)                                                                 \
    LD(7, rdi)                                                                 \
    LD(8, r8)                                                                  \
    LD(9, r9)                                                                  \
    LD(10, r10)                                                                \
    LD(11, r11)                                                                \
    LD(12, r12)                                                                \
    LD(13, r13)                                                                \
    LD(14, r14)                                                                \
    LD(15, r15)
#define STORES                                                                 \
    ST(0, rax)                                                                 \
    ST(1, rcx)                                                                 \
    ST(2, rdx)                                                                 \
    ST(3, rbx)                                                                 \
    ST(5, rbp)                                                                 \
    ST(6, rsi)                                                                 \
    ST(7, rdi)                                                                 \
    ST(8, r8)                                                                  \
    ST(9, r9)                                                                  \
    ST(10, r10)                                                                \
    ST(11, r11)                                                                \
    ST(12, r12)                                                                \
    ST(13, r13)                                                                \
    ST(14, r14)                                                                \
    ST(15, r15)

/* each case loads every register from gin, runs one instruction (flags start as
 * CF PF ZF SF), and stores every register to gout; a fault is resumed at the
 * label after it */
#define STUB(name, insn, kind)                                                 \
    __asm__(".globl " #name "\n" #name ":\n"                                   \
            " push %rbx\n push %rbp\n push %r12\n push %r13\n push %r14\n"     \
            " push %r15\n mov %rsp, saved_rsp(%rip)\n"                         \
            " fninit\n movups xin(%rip), %xmm0\n movups xin+16(%rip), %xmm1\n" \
            " pushq $0xc5\n popfq\n" LOADS insn "\n"                           \
            ".globl " #name "_after\n" #name "_after:\n"                       \
            " pushfq\n popq gflags(%rip)\n cld\n" STORES                       \
            " mov saved_rsp(%rip), %rsp\n pop %r15\n pop %r14\n pop %r13\n"    \
            " pop %r12\n pop %rbp\n pop %rbx\n ret\n");
#define DECL(name, insn, kind) extern char name[], name##_after[];
#define ENTRY(name, insn, kind) {#name, name, name##_after, kind},

enum
{
    PLAIN,
    MEM, /* rbx at mapped memory, then at unmapped memory */
    STR  /* rsi, rdi and rcx for a string op: short, then across the page end */
};

#define CASES(X)                                                               \
    X(sse_movdqu_load, "movdqu (%rbx), %xmm1", MEM)                            \
    X(sse_movaps_load, "movaps (%rbx), %xmm2", MEM)                            \
    X(sse_movsd_load, "movsd (%rbx), %xmm3", MEM)                              \
    X(sse_movss_load, "movss (%rbx), %xmm3", MEM)                              \
    X(sse_movq_load, "movq (%rbx), %xmm0", MEM)                                \
    X(sse_movdqu_store, "movdqu %xmm1, (%rbx)", MEM)                           \
    X(sse_movsd_store, "movsd %xmm1, (%rbx)", MEM)                             \
    X(sse_paddq_mem, "paddq (%rbx), %xmm1", MEM)                               \
    X(sse_cvtsi2sd_reg, "cvtsi2sd %rcx, %xmm0", PLAIN)                         \
    X(sse_cvtsi2sd_mem, "cvtsi2sdl (%rbx), %xmm0", MEM)                        \
    X(sse_cvtsi2ss_reg, "cvtsi2ss %r10d, %xmm0", PLAIN)                        \
    X(sse_cvttsd2si, "cvttsd2si %xmm0, %rdx", PLAIN)                           \
    X(sse_cvttsd2si_mem, "cvttsd2si (%rbx), %r9", MEM)                         \
    X(sse_cvttss2si, "cvttss2si %xmm1, %r9d", PLAIN)                           \
    X(sse_movd_to_gpr, "movd %xmm1, %edx", PLAIN)                              \
    X(sse_movq_to_gpr, "movq %xmm1, %r12", PLAIN)                              \
    X(sse_movd_to_xmm, "movd %ecx, %xmm1", PLAIN)                              \
    X(sse_movq_to_xmm, "movq %r13, %xmm1", PLAIN)                              \
    X(sse_movd_store, "movd %xmm1, (%rbx)", MEM)                               \
    X(sse_pmovmskb, "pmovmskb %xmm1, %esi", PLAIN)                             \
    X(sse_movmskpd, "movmskpd %xmm1, %r8d", PLAIN)                             \
    X(sse_pextrw, "pextrw $1, %xmm1, %edi", PLAIN)                             \
    X(sse_pinsrw, "pinsrw $2, %ecx, %xmm1", PLAIN)                             \
    X(sse_comisd, "comisd %xmm1, %xmm0", PLAIN)                                \
    X(sse_comisd_mem, "comisd (%rbx), %xmm0", MEM)                             \
    X(sse_ucomiss, "ucomiss %xmm1, %xmm0", PLAIN)                              \
    X(sse_stmxcsr, "stmxcsr (%rbx)", MEM)                                      \
    X(x87_fldl, "fldl (%rbx)\n fstp %st(0)", MEM)                              \
    X(x87_fistpll, "fld1\n fistpll (%rbx)", MEM)                               \
    X(x87_fstpl, "fld1\n fstpl (%rbx)", MEM)                                   \
    X(x87_fcomi,                                                               \
      "fld1\n fldz\n fcomi %st(1), %st\n fstp %st(0)\n fstp %st(0)", PLAIN)    \
    X(x87_fucomip, "fld1\n fldz\n fucomip %st(1), %st\n fstp %st(0)", PLAIN)   \
    X(x87_fnstsw, "fld1\n fcom %st(0)\n fnstsw %ax\n fstp %st(0)", PLAIN)      \
    X(x87_fcmovb,                                                              \
      "fld1\n fldz\n fcmovb %st(1), %st\n fstp %st(0)\n fstp %st(0)", PLAIN)   \
    X(str_movsb, "rep movsb", STR)                                             \
    X(str_movsq, "rep movsq", STR)                                             \
    X(str_stosb, "rep stosb", STR)                                             \
    X(str_stosq, "rep stosq", STR)                                             \
    X(str_stosb_down, "std\n rep stosb", STR)                                  \
    X(gpr_load, "mov (%rbx), %rdx", MEM)                                       \
    X(gpr_store, "mov %rax, (%rbx)", MEM)

CASES(STUB)
CASES(DECL)

static const struct {
    const char* name;
    char* entry;
    char* after;
    int kind;
} cases[] = {CASES(ENTRY)};

struct ksigaction {
    void (*handler)(int, void*, void*);
    unsigned long flags;
    void (*restorer)(void);
    unsigned long mask;
};

/* ucontext gregs: r8..r15, rdi, rsi, rbp, rbx, rdx, rax, rcx, rsp, rip, eflags
 */
static const int slot[16] = {13, 14, 12, 11, 15, 10, 9, 8,
                             0,  1,  2,  3,  4,  5,  6, 7};
static void on_segv(int s, void* info, void* uc) {
    (void) s;
    (void) info;
    long* mc = (long*) ((char*) uc + MC);
    for (int i = 0; i < 16; i++) gfault[i] = mc[slot[i]];
    gfault_rip = mc[16];
    gfault_flags = mc[17];
    mc[16] = target;
    faulted++;
}

static char out[1 << 15];
static int used;
static void put(const char* s) {
    while (*s) out[used++] = *s++;
}
static void hex(unsigned long v) {
    char b[18];
    int n = 0;
    do b[n++] = "0123456789abcdef"[v & 15];
    while (v >>= 4);
    put("0x");
    while (n) out[used++] = b[--n];
}
static const char* const reg[16] = {"rax", "rcx", "rdx", "rbx", "rsp", "rbp",
                                    "rsi", "rdi", "r8",  "r9",  "r10", "r11",
                                    "r12", "r13", "r14", "r15"};

static char* page;
static char src[8192];

static void run(
    int c, const char* tag, long rbx, long rsi, long rdi, long rcx
) {
    for (int i = 0; i < 16; i++) gin[i] = 0x1111111111111111L * (i + 1) + i;
    gin[3] = rbx ? rbx : gin[3];
    if (rsi) gin[6] = rsi, gin[7] = rdi, gin[1] = rcx;
    long (*fn)(void) = (long (*)(void)) cases[c].entry;
    for (int i = 0; i < 16; i++) gout[i] = gin[i];
    faulted = 0;
    target = (long) cases[c].after;
    fn();
    put(cases[c].name);
    put(" ");
    put(tag);
    put(faulted ? " fault at +" : " ok");
    if (faulted)
        hex((unsigned long) gfault_rip - (unsigned long) cases[c].entry);
    put("\n");
    for (int i = 0; i < 16; i++)
        if (i != 4 && gout[i] != gin[i]) {
            put("  ");
            put(reg[i]);
            put(" ");
            hex((unsigned long) gout[i]);
            put("\n");
        }
    put("  flags ");
    hex((unsigned long) gflags & 0x8d5);
    put("\n");
    if (faulted) {
        for (int i = 0; i < 16; i++)
            if (i != 4 && gfault[i] != gin[i]) {
                put("  fault ");
                put(reg[i]);
                put(" ");
                hex((unsigned long) gfault[i]);
                put("\n");
            }
        put("  fault flags ");
        hex((unsigned long) gfault_flags & (0x8d5 | 0x400));
        put("\n");
    }
}

void rep_main(void) {
    struct ksigaction a = {on_segv, SA_SIGINFO | SA_RESTORER, restore_rt, 0};
    sys6(NR_SIGACTION, SIGSEGV, (long) &a, 0, 8, 0, 0);
    page = (char*) 0x7e0000000000;
    sys6(NR_MMAP, (long) page, 8192, 3, MAP_FIXED_ANON, -1, 0);
    sys(NR_MUNMAP, (long) (page + 4096), 4096, 0);
    for (int i = 0; i < 4096; i++) page[i] = (char) (i * 7 + 3);
    for (int i = 0; i < 8192; i++) src[i] = (char) (i * 5 + 1);
    for (int c = 0; c < (int) (sizeof cases / sizeof cases[0]); c++) {
        if (cases[c].kind == PLAIN) run(c, "plain", 0, 0, 0, 0);
        if (cases[c].kind == MEM) {
            run(c, "mapped", (long) page, 0, 0, 0);
            run(c, "unmapped", (long) page + 4096, 0, 0, 0);
        }
        if (cases[c].kind == STR) {
            run(c, "short", 0, (long) src, (long) page + 100, 10);
            run(c, "across", 0, (long) src, (long) page + 4096 - 40, 100);
        }
    }
    sys(NR_WRITE, 1, (long) out, used);
    sys(NR_EXIT, 0, 0, 0);
}
