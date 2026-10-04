#include <stdint.h>

#define NR_WRITE 1
#define NR_MMAP 9
#define NR_MPROTECT 10
#define NR_MUNMAP 11
#define NR_SIGACTION 13
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

#define A 0x30000000L /* two pages, then two PROT_NONE pages */
#define B 0x40000000L /* one page, then a hole */
#define C 0x50000000L /* four pages */

long gmask = 0x3ff;
long masks[4] = {0x3ff, 0x5ff, 0xf, 0x3ff};
long gresume, gbase, gfaults, gfaddr;
long table[256];
unsigned char bytes[600];

/* every function indexes its base with a masked or bounded register: the access
   is a window from the base to the mask's end, and a window that ends in a page
   the guest cannot reach must leave the access to fault at its own address */
__asm__(
    ".text\n"
    ".globl _start\n_start:\n xor %rbp, %rbp\n mov %rsp, %rdi\n and $-16, "
    "%rsp\n call index_main\n hlt\n"
    ".globl restore_rt\nrestore_rt:\n mov $15, %eax\n syscall\n"

    /* a[(i * 5) & 0x3ff] = i * 3 + 1 */
    ".globl fill\n.type fill,@function\nfill:\n"
    " xor %ecx, %ecx\n"
    "1: lea (%rcx,%rcx,4), %rdx\n"
    " and $0x3ff, %rdx\n"
    " lea 1(%rcx,%rcx,2), %rax\n"
    " mov %rax, (%rdi,%rdx,8)\n"
    " inc %rcx\n"
    " cmp %rsi, %rcx\n"
    " jb 1b\n"
    " ret\n"
    ".size fill, .-fill\n"

    /* a store through the window, read again by a later load of the same block
     */
    ".globl rd\n.type rd,@function\nrd:\n"
    " xor %ecx, %ecx\n"
    " xor %eax, %eax\n"
    "1: lea 7(%rcx,%rcx,2), %rdx\n"
    " and $0x3ff, %rdx\n"
    " mov %rcx, (%rdi,%rdx,8)\n"
    " mov (%rdi,%rdx,8), %r8\n"
    " add %r8, %rax\n"
    " lea 1(%rdx), %r9\n"
    " and $0x3ff, %r9\n"
    " mov (%rdi,%r9,8), %r10\n"
    " add %r10, %rax\n"
    " inc %rcx\n"
    " cmp %rsi, %rcx\n"
    " jb 1b\n"
    " ret\n"
    ".size rd, .-rd\n"

    /* the mask reaches past the mapped part: a load there faults and resumes */
    ".globl edge_ld\n.type edge_ld,@function\nedge_ld:\n"
    " xor %ecx, %ecx\n"
    " xor %eax, %eax\n"
    "1: lea 0(,%rcx,8), %rdx\n"
    " sub %rcx, %rdx\n"
    " and $0x5ff, %rdx\n"
    " xor %r8d, %r8d\n"
    " mov (%rdi,%rdx,8), %r8\n"
    ".globl edge_ld_resume\nedge_ld_resume:\n"
    " add %r8, %rax\n"
    " inc %rcx\n"
    " cmp %rsi, %rcx\n"
    " jb 1b\n"
    " ret\n"
    ".size edge_ld, .-edge_ld\n"

    ".globl edge_st\n.type edge_st,@function\nedge_st:\n"
    " xor %ecx, %ecx\n"
    " xor %eax, %eax\n"
    "1: lea 0(,%rcx,8), %rdx\n"
    " sub %rcx, %rdx\n"
    " add $3, %rdx\n"
    " and $0x5ff, %rdx\n"
    " mov %rcx, (%rdi,%rdx,8)\n"
    ".globl edge_st_resume\nedge_st_resume:\n"
    " add %rdx, %rax\n"
    " inc %rcx\n"
    " cmp %rsi, %rcx\n"
    " jb 1b\n"
    " ret\n"
    ".size edge_st, .-edge_st\n"

    /* the mask is loaded, and changes: it is not a bound */
    ".globl ldmask\n.type ldmask,@function\nldmask:\n"
    " xor %ecx, %ecx\n"
    " xor %eax, %eax\n"
    "1: lea (%rcx,%rcx,2), %rdx\n"
    " mov gmask(%rip), %r9\n"
    " and %r9, %rdx\n"
    " xor %r8d, %r8d\n"
    " mov (%rdi,%rdx,8), %r8\n"
    ".globl ldmask_resume\nldmask_resume:\n"
    " add %r8, %rax\n"
    " mov %rcx, %r10\n"
    " and $3, %r10\n"
    " mov masks(,%r10,8), %r9\n"
    " mov %r9, gmask(%rip)\n"
    " inc %rcx\n"
    " cmp %rsi, %rcx\n"
    " jb 1b\n"
    " ret\n"
    ".size ldmask, .-ldmask\n"

    /* a compare with a constant bounds the index on the path that goes on */
    ".globl cmpb\n.type cmpb,@function\ncmpb:\n"
    " xor %ecx, %ecx\n"
    " xor %eax, %eax\n"
    "1: lea (%rcx,%rcx,8), %rdx\n"
    " and $0x7ff, %rdx\n"
    " cmp $0x7f0, %rdx\n"
    " ja 2f\n"
    " mov (%rdi,%rdx,8), %r8\n"
    " add %r8, %rax\n"
    "2: inc %rcx\n"
    " cmp %rsi, %rcx\n"
    " jb 1b\n"
    " ret\n"
    ".size cmpb, .-cmpb\n"

    /* an index of 0 or 1024 over a window that ends one element into a
       PROT_NONE page */
    ".globl last\n.type last,@function\nlast:\n"
    " xor %ecx, %ecx\n"
    " xor %eax, %eax\n"
    "1: mov %rcx, %rdx\n"
    " and $1, %rdx\n"
    " shl $10, %rdx\n"
    " xor %r8d, %r8d\n"
    " mov (%rdi,%rdx,8), %r8\n"
    ".globl last_resume\nlast_resume:\n"
    " add %r8, %rax\n"
    " inc %rcx\n"
    " cmp %rsi, %rcx\n"
    " jb 1b\n"
    " ret\n"
    ".size last, .-last\n"

    /* a byte read from memory is an index below 256 */
    ".globl tbl\n.type tbl,@function\ntbl:\n"
    " xor %ecx, %ecx\n"
    " xor %eax, %eax\n"
    "1: movzbl (%rdi,%rcx), %r8d\n"
    " add (%rsi,%r8,8), %rax\n"
    " inc %rcx\n"
    " cmp %rdx, %rcx\n"
    " jb 1b\n"
    " ret\n"
    ".size tbl, .-tbl\n"
);

long fill(long base, long n);
long rd(long base, long n);
long edge_ld(long base, long n);
long edge_st(long base, long n);
long ldmask(long base, long n);
long cmpb(long base, long n);
long last(long base, long n);
long tbl(long b, long t, long n);
void restore_rt(void);
void edge_ld_resume(void);
void edge_st_resume(void);
void ldmask_resume(void);
void last_resume(void);

struct ksigaction {
    void (*handler)(int, void*, void*);
    unsigned long flags;
    void (*restorer)(void);
    unsigned long mask;
};

static void on_segv(int s, void* info, void* uc) {
    (void) s;
    gfaults++;
    gfaddr += ((long*) info)[2] - gbase;
    *(long*) ((char*) uc + MC + 16 * 8) = gresume;
}

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
static void line(const char* k, long a, long b, long c) {
    put(k);
    put(" ");
    num(a);
    put(" ");
    num(b);
    put(" ");
    num(c);
    put("\n");
}

static long sum(long* p, long n) {
    long s = 0;
    for (long i = 0; i < n; i++) s = s * 31 + p[i];
    return s;
}

/* a faulting call: the handler resumes at `at`, and the faults it saw are
 * reported */
static void faulting(
    const char* name, long (*fn)(long, long), long base, long n,
    void (*at)(void)
) {
    gresume = (long) at;
    gbase = base;
    gfaults = gfaddr = 0;
    long r = fn(base, n);
    line(name, r, gfaults, gfaddr);
}

/* an argument names the one case to run */
static int pick(const char* want, const char* name) {
    if (!want) return 1;
    while (*name)
        if (*want++ != *name++) return 0;
    return !*want;
}

void index_main(long* sp) {
    const char* only = sp[0] > 1 ? ((char**) (sp + 1))[1] : 0;
    struct ksigaction sa = {on_segv, SA_SIGINFO | SA_RESTORER, restore_rt, 0};
    sys6(NR_SIGACTION, SIGSEGV, (long) &sa, 0, 8, 0, 0);
    sys6(NR_MMAP, A, 4 * 4096, 3, MAP_FIXED_ANON, -1, 0);
    sys(NR_MPROTECT, A + 2 * 4096, 2 * 4096, 0);
    sys6(NR_MMAP, B, 2 * 4096, 3, MAP_FIXED_ANON, -1, 0);
    sys(NR_MUNMAP, B + 4096, 4096, 0);
    sys6(NR_MMAP, C, 4 * 4096, 3, MAP_FIXED_ANON, -1, 0);
    for (int i = 0; i < 256; i++) table[i] = i * i + 5;
    for (int i = 0; i < 600; i++)
        bytes[i] = (unsigned char) (i * 37 + (i >> 3));
    if (pick(only, "fill")) {
        long r = fill(A, 400);
        line("fill", r, sum((long*) A, 1024), 0);
    }
    if (pick(only, "rd")) {
        long r = rd(A, 400);
        line("rd", r, sum((long*) A, 1024), 0);
    }
    if (pick(only, "edge_ld")) {
        faulting("edge_ld A", edge_ld, A, 400, edge_ld_resume);
        faulting("edge_ld B", edge_ld, B, 400, edge_ld_resume);
    }
    if (pick(only, "edge_st")) {
        faulting("edge_st A", edge_st, A, 400, edge_st_resume);
        line("edge_st sum", sum((long*) A, 1024), 0, 0);
        faulting("edge_st B", edge_st, B, 400, edge_st_resume);
    }
    if (pick(only, "ldmask")) {
        gmask = 0x3ff;
        faulting("ldmask A", ldmask, A, 400, ldmask_resume);
        line("ldmask mask", gmask, 0, 0);
    }
    if (pick(only, "last")) {
        faulting("last A", last, A, 400, last_resume);
    }
    if (pick(only, "cmpb")) {
        for (int i = 0; i < 2048; i++) ((long*) C)[i] = i * 3 + 1;
        long r = cmpb(C, 400);
        line("cmpb", r, 0, 0);
    }
    if (pick(only, "tbl")) {
        long r = tbl((long) bytes, (long) table, 600);
        line("tbl", r, 0, 0);
    }
    sys(NR_WRITE, 1, (long) out, used);
    sys(NR_EXIT, 0, 0, 0);
}
