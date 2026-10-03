#include <stdint.h>

#define NR_WRITE 1
#define NR_SIGACTION 13
#define NR_KILL 62
#define NR_GETPID 39
#define NR_EXIT 60
#define MC 40
#define SA_SIGINFO 4
#define SA_RESTORER 0x04000000
#define SIGUSR1 10
#define SIGSEGV 11

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

long* volatile gptr;
long gsum, gsum2, gtotal, gseen, gpid, gfaults, gwant;
__attribute__((aligned(16))) long gvec[2] = {
    0x1111111111111111, 0x2222222222222222
};

/* every function keeps its slots in the frame (rsp-relative, no frame pointer):
   a slot is stored, loaded again by a later block and reached by something the
   function's own blocks do not show as rsp-relative */
__asm__(".globl _start\n_start:\n xor %rbp, %rbp\n mov %rsp, %rdi\n and $-16, "
        "%rsp\n call "
        "slots_main\n hlt\n"
        ".globl restore_rt\nrestore_rt:\n mov $15, %eax\n syscall\n"

        /* a pointer to a slot is stored; an unknown store through it hits the
           slot on odd iterations, and the next load must see it */
        ".globl esc\nesc:\n"
        " sub $40, %rsp\n"
        " movq $1, 8(%rsp)\n"
        " lea 8(%rsp), %rax\n"
        " mov %rax, gptr(%rip)\n"
        " xor %rcx, %rcx\n"
        "1: mov 8(%rsp), %rax\n"
        " add $3, %rax\n"
        " mov %rax, 8(%rsp)\n"
        " mov gptr(%rip), %rdx\n"
        " test $1, %rcx\n"
        " jz 2f\n"
        " mov %rcx, (%rdx)\n"
        "2: mov 8(%rsp), %rax\n"
        " add %rax, gsum(%rip)\n"
        " inc %rcx\n"
        " cmp %rdi, %rcx\n"
        " jl 1b\n"
        " mov 8(%rsp), %rax\n"
        " add $40, %rsp\n"
        " ret\n"

        /* a callee reads the slot through a pointer and writes it back */
        ".globl cal\ncal:\n"
        " sub $40, %rsp\n"
        " movq $5, 16(%rsp)\n"
        " xor %rcx, %rcx\n"
        "1: mov 16(%rsp), %rax\n"
        " add $7, %rax\n"
        " mov %rax, 16(%rsp)\n"
        " lea 16(%rsp), %rdi\n"
        " push %rcx\n"
        " call peek\n"
        " pop %rcx\n"
        " mov 16(%rsp), %rax\n"
        " add %rax, gsum(%rip)\n"
        " inc %rcx\n"
        " cmp %rsi, %rcx\n"
        " jl 1b\n"
        " mov 16(%rsp), %rax\n"
        " add $40, %rsp\n"
        " ret\n"
        "peek:\n"
        " mov (%rdi), %rax\n"
        " add %rax, gtotal(%rip)\n"
        " incq (%rdi)\n"
        " ret\n"

        /* a signal arrives every fourth iteration; its handler reads the slot
           and adds to it */
        ".globl sig\nsig:\n"
        " sub $40, %rsp\n"
        " movq $0, 8(%rsp)\n"
        " lea 8(%rsp), %rax\n"
        " mov %rax, gptr(%rip)\n"
        " xor %rcx, %rcx\n"
        "1: mov 8(%rsp), %rax\n"
        " add $11, %rax\n"
        " mov %rax, 8(%rsp)\n"
        " test $3, %rcx\n"
        " jnz 2f\n"
        " push %rcx\n"
        " push %rdi\n"
        " mov $62, %eax\n"
        " mov gpid(%rip), %rdi\n"
        " mov $10, %esi\n"
        " syscall\n"
        " pop %rdi\n"
        " pop %rcx\n"
        "2: mov 8(%rsp), %rax\n"
        " add %rax, gsum(%rip)\n"
        " inc %rcx\n"
        " cmp %rdi, %rcx\n"
        " jl 1b\n"
        " mov 8(%rsp), %rax\n"
        " add $40, %rsp\n"
        " ret\n"

        /* stores of other widths over a slot: the later loads see them */
        ".globl wid\nwid:\n"
        " sub $40, %rsp\n"
        " mov $0x1122334455667788, %rax\n"
        " mov %rax, 8(%rsp)\n"
        " xor %rcx, %rcx\n"
        "1: mov 8(%rsp), %rax\n"
        " add %rcx, %rax\n"
        " mov %rax, 8(%rsp)\n"
        " mov 12(%rsp), %edx\n"
        " add %rdx, gsum(%rip)\n"
        " mov %cl, 9(%rsp)\n"
        " mov 8(%rsp), %rax\n"
        " add %rax, gsum2(%rip)\n"
        " mov %cx, 14(%rsp)\n"
        " movzwl 12(%rsp), %edx\n"
        " add %rdx, gsum(%rip)\n"
        " mov 8(%rsp), %rax\n"
        " add %rax, gsum2(%rip)\n"
        " inc %rcx\n"
        " cmp %rdi, %rcx\n"
        " jl 1b\n"
        " mov 8(%rsp), %rax\n"
        " add $40, %rsp\n"
        " ret\n"

        /* an sse store and rep stos over slots */
        ".globl vec\nvec:\n"
        " sub $56, %rsp\n"
        " movq $3, 8(%rsp)\n"
        " movq $4, 16(%rsp)\n"
        " xor %rcx, %rcx\n"
        "1: mov 8(%rsp), %rax\n"
        " add %rcx, %rax\n"
        " mov %rax, 8(%rsp)\n"
        " mov 16(%rsp), %rdx\n"
        " add %rdx, %rax\n"
        " mov %rax, 16(%rsp)\n"
        " test $1, %rcx\n"
        " jz 2f\n"
        " movups gvec(%rip), %xmm0\n"
        " movups %xmm0, 8(%rsp)\n"
        " jmp 3f\n"
        "2: push %rcx\n"
        " push %rdi\n"
        " lea 8(%rsp), %rdi\n"
        " add $16, %rdi\n"
        " mov %rcx, %rax\n"
        " mov $2, %ecx\n"
        " rep stosq\n"
        " pop %rdi\n"
        " pop %rcx\n"
        "3: mov 8(%rsp), %rax\n"
        " add %rax, gsum(%rip)\n"
        " mov 16(%rsp), %rax\n"
        " add %rax, gsum2(%rip)\n"
        " inc %rcx\n"
        " cmp %rdi, %rcx\n"
        " jl 1b\n"
        " mov 8(%rsp), %rax\n"
        " add $56, %rsp\n"
        " ret\n"

        /* a fault after slot stores: the handler sees the slot's memory */
        ".globl flt\nflt:\n"
        " sub $40, %rsp\n"
        " movq $9, 8(%rsp)\n"
        " lea 8(%rsp), %rax\n"
        " mov %rax, gptr(%rip)\n"
        " xor %rcx, %rcx\n"
        "1: mov 8(%rsp), %rax\n"
        " add $5, %rax\n"
        " mov %rax, 8(%rsp)\n"
        " mov %rsi, %rdx\n"
        " test $7, %rcx\n"
        " jnz 2f\n"
        " mov %rcx, %rdx\n"
        " shl $12, %rdx\n"
        " add $0x70000000, %rdx\n"
        "2: mov (%rdx), %rax\n"
        ".globl flt_resume\nflt_resume:\n"
        " mov 8(%rsp), %rax\n"
        " add %rax, gsum(%rip)\n"
        " inc %rcx\n"
        " cmp %rdi, %rcx\n"
        " jl 1b\n"
        " mov 8(%rsp), %rax\n"
        " add $40, %rsp\n"
        " ret\n");

long esc(long n);
long cal(long n, long m);
long sig(long n);
long wid(long n);
long vec(long n);
long flt(long n, long ok);
void restore_rt(void);
void flt_resume(void);
static long valid_word = 77;

struct ksigaction {
    void (*handler)(int, void*, void*);
    unsigned long flags;
    void (*restorer)(void);
    unsigned long mask;
};

static void on_usr1(int s, void* info, void* uc) {
    (void) s;
    (void) info;
    (void) uc;
    gseen += *gptr;
    *gptr += 1000;
}

static void on_segv(int s, void* info, void* uc) {
    (void) s;
    (void) info;
    gfaults++;
    gseen += *gptr;
    *(long*) ((char*) uc + MC + 16 * 8) = (long) flt_resume;
}

static void handler(int s, void (*h)(int, void*, void*)) {
    struct ksigaction sa = {h, SA_SIGINFO | SA_RESTORER, restore_rt, 0};
    sys6(NR_SIGACTION, s, (long) &sa, 0, 8, 0, 0);
}

static char out[1024];
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

/* an argument names the one case to run */
static int pick(const char* want, const char* name) {
    if (!want) return 1;
    while (*name)
        if (*want++ != *name++) return 0;
    return !*want;
}

void slots_main(long* sp) {
    const char* only = sp[0] > 1 ? ((char**) (sp + 1))[1] : 0;
    gpid = sys(NR_GETPID, 0, 0, 0);
    handler(SIGUSR1, on_usr1);
    handler(SIGSEGV, on_segv);
    long r;
    if (pick(only, "esc")) {
        r = esc(200);
        line("esc", r, gsum, 0);
        gsum = 0;
    }
    if (pick(only, "cal")) {
        r = cal(200, 200);
        line("cal", r, gsum, gtotal);
        gsum = 0;
    }
    if (pick(only, "sig")) {
        r = sig(200);
        line("sig", r, gsum, gseen);
        gsum = gseen = 0;
    }
    if (pick(only, "wid")) {
        r = wid(200);
        line("wid", r, gsum, gsum2);
        gsum = gsum2 = 0;
    }
    if (pick(only, "vec")) {
        r = vec(200);
        line("vec", r, gsum, gsum2);
        gsum = 0;
    }
    if (pick(only, "flt")) {
        r = flt(200, (long) &valid_word);
        line("flt", r, gsum, gseen);
        line("faults", gfaults, 0, 0);
    }
    sys(NR_WRITE, 1, (long) out, used);
    sys(NR_EXIT, 0, 0, 0);
}
