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
static volatile long faulted;
static long target;

__asm__(".globl _start\n_start:\n xor %rbp, %rbp\n and $-16, %rsp\n call "
        "rep_main\n hlt\n"
        ".globl restore_rt\nrestore_rt:\n mov $15, %eax\n syscall\n");
void restore_rt(void);

#define LOADS                                                                  \
    " mov gin(%rip), %rax\n mov gin+8(%rip), %rcx\n"                           \
    " mov gin+16(%rip), %rdx\n mov gin+24(%rip), %rbx\n"                       \
    " mov gin+40(%rip), %rbp\n mov gin+48(%rip), %rsi\n"                       \
    " mov gin+56(%rip), %rdi\n mov gin+64(%rip), %r8\n"                        \
    " mov gin+72(%rip), %r9\n mov gin+80(%rip), %r10\n"                        \
    " mov gin+88(%rip), %r11\n mov gin+96(%rip), %r12\n"                       \
    " mov gin+104(%rip), %r13\n mov gin+112(%rip), %r14\n"                     \
    " mov gin+120(%rip), %r15\n"
#define STORES                                                                 \
    " mov %rax, gout(%rip)\n mov %rcx, gout+8(%rip)\n"                         \
    " mov %rdx, gout+16(%rip)\n mov %rbx, gout+24(%rip)\n"                     \
    " mov %rbp, gout+40(%rip)\n mov %rsi, gout+48(%rip)\n"                     \
    " mov %rdi, gout+56(%rip)\n mov %r8, gout+64(%rip)\n"                      \
    " mov %r9, gout+72(%rip)\n mov %r10, gout+80(%rip)\n"                      \
    " mov %r11, gout+88(%rip)\n mov %r12, gout+96(%rip)\n"                     \
    " mov %r13, gout+104(%rip)\n mov %r14, gout+112(%rip)\n"                   \
    " mov %r15, gout+120(%rip)\n"

/* a global function of its own symbol and size, which lift.ts takes as a region
 */
#define FN(name, body)                                                         \
    __asm__(".globl " #name "\n.type " #name ",@function\n" #name ":\n" body   \
            ".size " #name ", .-" #name "\n");

/* every register loaded from gin and flags CF PF ZF SF, one call into the
 * functions under test, every register and the flags stored to gout */
#define HARNESS(name, fn)                                                      \
    FN(name, " push %rbx\n push %rbp\n push %r12\n push %r13\n push %r14\n"    \
             " push %r15\n mov %rsp, saved_rsp(%rip)\n"                        \
             " pushq $0xc5\n popfq\n" LOADS " call " #fn "\n"                  \
             " pushfq\n popq gflags(%rip)\n cld\n" STORES                      \
             " mov saved_rsp(%rip), %rsp\n pop %r15\n pop %r14\n pop %r13\n"   \
             " pop %r12\n pop %rbp\n pop %rbx\n ret\n")

/* a callee that touches the caller-saved registers, keeps rbx and rbp, sets the
 * flags last and may fault on its first access (resumed at _resume) */
#define INNER(name, insn)                                                      \
    FN(name,                                                                   \
       " push %rbx\n push %rbp\n " insn "\n" #name "_resume:\n"                \
       " xor %rax, %rdx\n lea 0x77(%rdx,%rcx), %r11\n mov $0x1234, %rbp\n"     \
       " cmp %rsi, %rdi\n pop %rbp\n pop %rbx\n ret\n")
#define OUTER(name, callee)                                                    \
    FN(name, " add %rcx, %rax\n xor %rsi, %r8\n call " #callee "\n"            \
             " sbb %r9, %r10\n add %rdx, %r8\n ret\n")

HARNESS(stub_load, outer_load)
OUTER(outer_load, inner_load)
INNER(inner_load, "mov (%rbx), %rdx")
HARNESS(stub_store, outer_store)
OUTER(outer_store, inner_store)
INNER(inner_store, "mov %rax, (%rbx)")

/* three levels, the leaf faults */
HARNESS(stub_deep, outer_deep)
FN(outer_deep, " add %rcx, %rax\n call mid_deep\n sbb %r9, %r10\n ret\n")
FN(mid_deep, " push %r12\n mov %rax, %r12\n add %rdx, %r12\n"
             " call leaf_deep\n xor %r12, %r8\n pop %r12\n ret\n")
FN(leaf_deep, " mov (%rbx), %rdx\n leaf_deep_resume:\n add %rdx, %rax\n"
              " cmp %r8, %rdi\n ret\n")

/* the callee returns to another place in its caller */
HARNESS(stub_alt, outer_alt)
FN(outer_alt, " call inner_alt\n mov $0xdead, %r12\n ret\n"
              "alt_site:\n mov $0xbeef, %r12\n ret\n")
FN(inner_alt, " push %r15\n lea alt_site(%rip), %r15\n"
              " mov %r15, 8(%rsp)\n pop %r15\n add %rcx, %rax\n ret\n")

/* a loop of calls, flags carried from one to the next */
HARNESS(stub_loop, outer_loop5)
FN(outer_loop5,
   " mov $5, %r12\n 1: call step_loop5\n dec %r12\n jnz 1b\n ret\n")
FN(step_loop5, " add %rcx, %rax\n adc $0, %rdx\n ret\n")

/* two functions calling each other */
HARNESS(stub_ping, ping)
FN(ping, " test %rdi, %rdi\n jz 1f\n dec %rdi\n add $3, %rax\n call pong\n"
         " add $1, %rcx\n 1: ret\n")
FN(pong, " test %rdi, %rdi\n jz 1f\n dec %rdi\n add $5, %rax\n call ping\n"
         " add $2, %rdx\n 1: ret\n")

extern char stub_load[], stub_store[], stub_deep[], stub_alt[], stub_loop[],
    stub_ping[];
extern char inner_load[], inner_load_resume[], inner_store[],
    inner_store_resume[], leaf_deep[], leaf_deep_resume[], outer_alt[],
    outer_loop5[], ping[];

enum
{
    PLAIN,
    MEM /* rbx at mapped memory, then at unmapped memory */
};
static const struct {
    const char* name;
    char* stub;
    char* entry;  /* the fault's rip is reported from here */
    char* resume; /* where the handler resumes */
    int kind;
    long rdi;
} cases[] = {
    {"call_load", stub_load, inner_load, inner_load_resume, MEM, 0},
    {"call_store", stub_store, inner_store, inner_store_resume, MEM, 0},
    {"deep_load", stub_deep, leaf_deep, leaf_deep_resume, MEM, 0},
    {"return_elsewhere", stub_alt, outer_alt, 0, PLAIN, 0},
    {"loop_of_calls", stub_loop, outer_loop5, 0, PLAIN, 0},
    {"mutual_calls", stub_ping, ping, 0, PLAIN, 7},
};

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

static char out[1 << 14];
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

static void run(int c, const char* tag, long rbx) {
    for (int i = 0; i < 16; i++) gin[i] = 0x1111111111111111L * (i + 1) + i;
    if (rbx) gin[3] = rbx;
    if (cases[c].rdi) gin[7] = cases[c].rdi;
    long (*fn)(void) = (long (*)(void)) cases[c].stub;
    for (int i = 0; i < 16; i++) gout[i] = gin[i];
    faulted = 0;
    target = (long) cases[c].resume;
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
    hex((unsigned long) gflags & 0x8c5);
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
        hex((unsigned long) gfault_flags & (0x8c5 | 0x400));
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
    for (int c = 0; c < (int) (sizeof cases / sizeof cases[0]); c++) {
        if (cases[c].kind == PLAIN) run(c, "plain", 0);
        if (cases[c].kind == MEM) {
            run(c, "mapped", (long) page);
            run(c, "unmapped", (long) page + 4096);
        }
    }
    sys(NR_WRITE, 1, (long) out, used);
    sys(NR_EXIT, 0, 0, 0);
}
