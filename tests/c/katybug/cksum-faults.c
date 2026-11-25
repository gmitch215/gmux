/* The slice-by-8 loop of cksum in the static x86-64 coreutils 9.5
 * (userland-build.sh), its one block copied out of that file and entered with
 * the registers the loop reads (rdx the data, rcx its end, rbx the crc, r14
 * the table), then returned from: every register and the flags the block
 * leaves, and at a fault the registers the signal handler sees. The output
 * must be the same natively and with katybug's kernel on and off.
 * usage: cksum-faults <coreutils> */
#include <stdint.h>

#define NR_WRITE 1
#define NR_OPEN 2
#define NR_MMAP 9
#define NR_MPROTECT 10
#define NR_MUNMAP 11
#define NR_SIGACTION 13
#define NR_PREAD 17
#define NR_EXIT 60
#define BLOCK_OFFSET 0x1d3f8
#define BLOCK_LEN 137
#define TABLE_OFFSET 0x131be0
#define TABLE_LEN 8192
/* ucontext_t's gregs start at word 5; r8 is 0 */
#define G(mc, i) ((mc)[5 + (i)])
enum
{
    R8,
    R9,
    R10,
    R11,
    R12,
    R13,
    R14,
    R15,
    RDI,
    RSI,
    RBP,
    RBX,
    RDX,
    RAX,
    RCX,
    RSP,
    RIP,
    EFL
};

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

/* the loop's inputs in i_*, its registers afterwards in o_*; a fault saves the
 * handler's view of them there too and resumes at try_done, so the stack is as
 * run_loop left it */
volatile uint64_t i_p, i_end, i_crc, i_tab, o_rax, o_rbx, o_rcx, o_rdx, o_rsi,
    o_rdi, o_r8, o_r9, o_r10, o_r11, o_r12, o_r13, o_r14, o_r15, o_flags;
void* volatile code;
volatile long saved_sp;
__asm__(
    ".globl _start\n_start:\n xor %rbp, %rbp\n mov %rsp, %rdi\n and $-16, "
    "%rsp\n call cksum_main\n hlt\n"
    ".globl restore_rt\nrestore_rt:\n mov $15, %eax\n syscall\n"
    ".globl run_loop\nrun_loop:\n"
    " push %rbx\n push %rbp\n push %r12\n push %r13\n push %r14\n push %r15\n"
    " mov %rsp, saved_sp(%rip)\n"
    " mov i_p(%rip), %rdx\n mov i_end(%rip), %rcx\n mov i_crc(%rip), %rbx\n"
    " mov i_tab(%rip), %r14\n"
    " movabs $0x1111111111111111, %rax\n movabs $0x2222222222222222, %rsi\n"
    " movabs $0x3333333333333333, %rdi\n movabs $0x4444444444444444, %r8\n"
    " movabs $0x5555555555555555, %r9\n movabs $0x6666666666666666, %r10\n"
    " movabs $0x7777777777777777, %r11\n movabs $0x8888888888888888, %r12\n"
    " movabs $0x9999999999999999, %r13\n movabs $0xaaaaaaaaaaaaaaaa, %r15\n"
    " call *code(%rip)\n"
    " pushfq\n popq o_flags(%rip)\n"
    " mov %rax, o_rax(%rip)\n mov %rbx, o_rbx(%rip)\n mov %rcx, o_rcx(%rip)\n"
    " mov %rdx, o_rdx(%rip)\n mov %rsi, o_rsi(%rip)\n mov %rdi, o_rdi(%rip)\n"
    " mov %r8, o_r8(%rip)\n mov %r9, o_r9(%rip)\n mov %r10, o_r10(%rip)\n"
    " mov %r11, o_r11(%rip)\n mov %r12, o_r12(%rip)\n mov %r13, o_r13(%rip)\n"
    " mov %r14, o_r14(%rip)\n mov %r15, o_r15(%rip)\n"
    ".globl try_done\ntry_done:\n"
    " pop %r15\n pop %r14\n pop %r13\n pop %r12\n pop %rbp\n pop %rbx\n ret\n"
);
void run_loop(void);
void restore_rt(void);
extern char try_done[];

#define SA_SIGINFO 4
#define SA_RESTORER 0x04000000
#define SIGSEGV 11
#define MAP_FIXED_ANON 0x32 /* MAP_PRIVATE | MAP_FIXED | MAP_ANONYMOUS */

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
static void hex(uint64_t v) {
    for (int i = 60; i >= 0; i -= 4)
        out[used++] = "0123456789abcdef"[v >> i & 15];
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
    o_rax = (uint64_t) G(mc, RAX), o_rbx = (uint64_t) G(mc, RBX);
    o_rcx = (uint64_t) G(mc, RCX), o_rdx = (uint64_t) G(mc, RDX);
    o_rsi = (uint64_t) G(mc, RSI), o_rdi = (uint64_t) G(mc, RDI);
    o_r8 = (uint64_t) G(mc, R8), o_r9 = (uint64_t) G(mc, R9);
    o_r10 = (uint64_t) G(mc, R10), o_r11 = (uint64_t) G(mc, R11);
    o_r12 = (uint64_t) G(mc, R12), o_r13 = (uint64_t) G(mc, R13);
    o_r14 = (uint64_t) G(mc, R14), o_r15 = (uint64_t) G(mc, R15);
    o_flags = (uint64_t) G(mc, EFL);
    G(mc, RIP) = (long) try_done;
    G(mc, RSP) = saved_sp;
}

/* one run: the output is the registers after it, or where it faulted (an
 * offset from ref) and the registers the handler saw. The flags are CF, PF,
 * ZF, SF and OF after a return: AF is left out (katybug does not compute it
 * for a compare), and so is OF at a fault, where the last flag write can be a
 * shift by more than 1, whose OF is undefined */
static void call(
    const char* name, const char* ref, const void* p, long span, uint64_t crc,
    const void* tab
) {
    i_p = (uint64_t) p, i_end = (uint64_t) p + (uint64_t) span;
    i_crc = crc, i_tab = (uint64_t) tab;
    long before = faults;
    run_loop();
    put(name);
    put(": ");
    int fault = faults != before;
    if (fault) {
        put("fault ");
        num(f_addr - (long) ref);
        put(" ");
    }
    uint64_t v[] = {o_rax, o_rbx, o_rcx, o_rdx, o_rsi, o_rdi, o_r8,
                    o_r9,  o_r10, o_r11, o_r12, o_r13, o_r14, o_r15};
    for (unsigned i = 0; i < sizeof v / sizeof *v; i++) {
        hex(v[i]);
        put(" ");
    }
    hex(o_flags & (fault ? 0xc5 : 0x8c5));
    put("\n");
    sys(NR_WRITE, 1, (long) out, used);
    used = 0;
}

static char nm[48];
static void tmp_name(int row, int last) {
    const char* s = last ? "table row N last entry changed"
                         : "table row N first entry changed";
    int n = 0;
    for (; *s; s++) nm[n++] = *s == 'N' ? (char) ('0' + row) : *s;
    nm[n] = 0;
}

void cksum_main(long* sp) {
    char* path = (char*) sp[2];
    struct ksigaction a = {on_segv, SA_SIGINFO | SA_RESTORER, restore_rt, 0};
    sys6(NR_SIGACTION, SIGSEGV, (long) &a, 0, 8, 0, 0);
    long fd = sys(NR_OPEN, (long) path, 0, 0);
    char* block = (char*) sys6(NR_MMAP, 0, 4096, 7, 0x22, -1, 0);
    /* A: a page and a hole; B: two mappings side by side; C: a page, a
     * PROT_NONE page, a page; D: 16 pages and then a hole; E: the table,
     * across two mappings; F: a table of other values */
    char* A = (char*) 0x7e0000000000;
    char* B = A + 0x10000;
    char* C = A + 0x20000;
    char* D = A + 0x100000;
    char* E = A + 0x200000;
    char* F = A + 0x210000;
    if (fd < 0 || (long) block < 0 ||
        sys6(NR_PREAD, fd, (long) block, BLOCK_LEN, BLOCK_OFFSET, 0, 0) !=
            BLOCK_LEN) {
        put("no code\n");
        sys(NR_WRITE, 1, (long) out, used);
        sys(NR_EXIT, 1, 0, 0);
    }
    block[BLOCK_LEN] = (char) 0xc3;
    code = block;
    sys6(NR_MMAP, (long) A, 8192, 3, MAP_FIXED_ANON, -1, 0);
    sys(NR_MUNMAP, (long) (A + 4096), 4096, 0);
    sys6(NR_MMAP, (long) B, 4096, 3, MAP_FIXED_ANON, -1, 0);
    sys6(NR_MMAP, (long) (B + 4096), 4096, 3, MAP_FIXED_ANON, -1, 0);
    sys6(NR_MMAP, (long) C, 4096, 3, MAP_FIXED_ANON, -1, 0);
    sys6(NR_MMAP, (long) (C + 4096), 4096, 0, MAP_FIXED_ANON, -1, 0);
    sys6(NR_MMAP, (long) (C + 8192), 4096, 3, MAP_FIXED_ANON, -1, 0);
    sys6(NR_MMAP, (long) D, 0x10000, 3, MAP_FIXED_ANON, -1, 0);
    sys6(NR_MMAP, (long) E, 4096, 3, MAP_FIXED_ANON, -1, 0);
    sys6(NR_MMAP, (long) (E + 4096), 4096, 3, MAP_FIXED_ANON, -1, 0);
    sys6(NR_MMAP, (long) F, 8192, 3, MAP_FIXED_ANON, -1, 0);
    for (int i = 0; i < 4096; i++)
        A[i] = (char) (i * 7 + (i >> 5)), C[i] = (char) (i * 13 + 5);
    for (int i = 0; i < 8192; i++) B[i] = (char) (i * 11 + (i >> 7));
    for (int i = 0; i < 4096; i++) C[8192 + i] = (char) (i * 3 + 1);
    for (int i = 0; i < 0x10000; i++) D[i] = (char) (i * 5 + (i >> 9) + 1);
    if (sys6(NR_PREAD, fd, (long) E, TABLE_LEN, TABLE_OFFSET, 0, 0) !=
        TABLE_LEN) {
        put("no table\n");
        sys(NR_WRITE, 1, (long) out, used);
        sys(NR_EXIT, 1, 0, 0);
    }
    for (int i = 0; i < TABLE_LEN; i++) F[i] = (char) (E[i] ^ (i * 3 + 1));
    const char* T = E;

    call("one iteration", D, D + 96, 8, 0, T);
    call("two", D, D + 96, 16, 0, T);
    call("three", D, D + 96, 24, 0x12345678, T);
    call("seven", D, D + 100, 56, 0xffffffff, T);
    call("crc with high bits", D, D + 96, 40, 0xdeadbeef12345678ull, T);
    call("a page", D, D + 4096, 4096, 0x80000000, T);
    call("a 64 KiB chunk", D, D, 0x10000, 0, T);
    call("chunk, 5 bytes past", D, D + 5, 0x10000 - 8, 0xabcdef01, T);
    call("ends at the page end", D, D + 0x10000 - 64, 64, 7, T);
    call("last iteration faults", D, D + 0x10000 - 64, 72, 7, T);
    call("second to last faults", D, D + 0x10000 - 64, 80, 7, T);
    call("far past the end", D, D + 0x10000 - 64, 0x1000, 7, T);
    call("load straddles the page end", D, D + 0x10000 - 5, 16, 3, T);
    call("load straddles, 5 iterations", D, D + 0x10000 - 29, 40, 3, T);
    call("buffer starts in the hole", A, A + 4096, 24, 0, T);
    call("buffer runs into the hole", A, A + 4096 - 24, 64, 0, T);
    call("across mappings", B, B + 4096 - 24, 64, 0x1020304, T);
    call("across mappings, odd start", B, B + 4096 - 21, 64, 0x1020304, T);
    call("runs into PROT_NONE", C, C + 4096 - 24, 64, 5, T);
    call("starts in PROT_NONE", C, C + 4096, 24, 5, T);
    call("past PROT_NONE", C, C + 8192 - 32, 64, 5, T);
    call("end below the data", D, D + 0x10000 - 64, -8, 1, T);
    call("span not a multiple of 8", D, D + 0x10000 - 80, 20, 1, T);
    call("table across two mappings", D, D + 96, 4096, 0x55aa55aa, T);
    call("table of other values", D, D + 96, 4096, 0x55aa55aa, F);
    call("table in the hole", A, A + 96, 512, 0x55aa55aa, A + 4096 - 100);
    call("table runs into the hole", A, D, 4096, 0x55aa55aa, A + 4096 - 4000);
    call("table runs off its mapping", E, D, 4096, 0x55aa55aa, E + 4096);
    call("table in PROT_NONE", C, D, 4096, 9, C + 4096 - 8);

    /* G: a writable copy of the table; H: a copy across two mappings; X: an
     * execute-only page; M: three pages, the last one made PROT_NONE and back
     */
    char* G = A + 0x220000;
    char* H = A + 0x230000;
    char* X = A + 0x240000;
    char* M = A + 0x300000;
    sys6(NR_MMAP, (long) G, 8192, 3, MAP_FIXED_ANON, -1, 0);
    sys6(NR_MMAP, (long) H, 4096, 3, MAP_FIXED_ANON, -1, 0);
    sys6(NR_MMAP, (long) (H + 4096), 4096, 3, MAP_FIXED_ANON, -1, 0);
    sys6(NR_MMAP, (long) X, 12288, 3, MAP_FIXED_ANON, -1, 0);
    sys6(NR_MMAP, (long) M, 12288, 3, MAP_FIXED_ANON, -1, 0);
    for (int i = 0; i < TABLE_LEN; i++) G[i] = E[i];
    for (int i = 0; i < 12288; i++) X[i] = (char) (i * 3 + 9);
    for (int i = 0; i < 12288; i++) M[i] = (char) (i * 17 + (i >> 4));
    /* the table's first and last entry of every row changed, one at a time,
     * over a chunk long enough to look every entry up */
    for (int k = 0; k < 8; k++)
        for (int last = 0; last < 2; last++) {
            int at = 4 * (k * 256 + (last ? 255 : 0));
            G[at] ^= 1;
            tmp_name(k, last);
            call(nm, D, D, 0x10000, 0x31415926, G);
            G[at] ^= 1;
        }
    call("table copy intact", D, D, 0x10000, 0x31415926, G);
    /* one process, one table, changed between two calls and put back */
    call("table about to change", D, D + 8, 0x1000, 3, G);
    G[0] ^= 1, G[8192 - 4] ^= 0x10;
    call("table changed", D, D + 8, 0x1000, 3, G);
    G[0] ^= 1, G[8192 - 4] ^= 0x10;
    call("table put back", D, D + 8, 0x1000, 3, G);
    /* the table across two mappings, with its last entry in the second one
     * changed */
    for (int i = 0; i < TABLE_LEN; i++) H[i] = E[i];
    call("copy across two mappings", D, D, 0x10000, 9, H);
    H[8192 - 1] ^= 0x80;
    call("copy across two mappings, last entry", D, D, 0x10000, 9, H);
    /* execute-only pages, where a load faults on the hardware with protection
     * keys and the kernel must give up as it does on a page without R */
    sys6(NR_MPROTECT, (long) (X + 4096), 4096, 4, 0, 0, 0);
    call("data in an execute-only page", X, X + 4096, 4096, 0x77, T);
    call("data runs into an execute-only page", X, X + 4096 - 16, 64, 0x77, T);
    call("table in an execute-only page", D, D + 16, 4096, 0x77, X + 4096);
    call(
        "table runs into an execute-only page", D, D + 16, 4096, 0x77,
        X + 4096 - 100
    );
    /* lengths of 16n and 16n + 8 bytes, aligned and not */
    call("32 bytes", D, D + 16, 32, 1, T);
    call("40 bytes", D, D + 16, 40, 1, T);
    call("48 bytes", D, D + 16, 48, 1, T);
    call("64 bytes", D, D + 16, 64, 2, T);
    call("72 bytes", D, D + 16, 72, 2, T);
    call("128 bytes", D, D + 24, 128, 3, T);
    call("136 bytes", D, D + 24, 136, 3, T);
    call("256 bytes", D, D + 5, 256, 4, T);
    call("264 bytes", D, D + 5, 264, 4, T);
    call("1008 bytes", D, D + 3, 1008, 5, T);
    call("1016 bytes", D, D + 3, 1016, 5, T);
    call("0x8000 bytes", D, D + 1, 0x8000, 6, T);
    call("0x8008 bytes", D, D + 1, 0x8008, 6, T);
    call("ends at the page end, 16n", D, D + 0x10000 - 128, 128, 7, T);
    call("ends at the page end, 16n + 8", D, D + 0x10000 - 136, 136, 7, T);
    call("one past the page end, 16n", D, D + 0x10000 - 120, 128, 7, T);
    call("one past the page end, 16n + 8", D, D + 0x10000 - 128, 136, 7, T);
    /* a declined loop (it runs into a PROT_NONE page and faults there), then
     * the page made readable and the same span run again */
    sys6(NR_MPROTECT, (long) (M + 8192), 4096, 0, 0, 0, 0);
    call("declined, runs into PROT_NONE", M, M + 4096, 8192, 0x1234, T);
    call("declined again, same span", M, M + 4096, 8192, 0x1234, T);
    call("declined, a later entry", M, M + 4096 + 64, 8192 - 64, 0x1234, T);
    sys6(NR_MPROTECT, (long) (M + 8192), 4096, 3, 0, 0, 0);
    call("taken after the page is back", M, M + 4096, 8192, 0x1234, T);
    call("taken, a later entry", M, M + 4096 + 64, 8192 - 64, 0x1234, T);

    put("faults ");
    num(faults);
    put("\n");
    sys(NR_WRITE, 1, (long) out, used);
    sys(NR_EXIT, 0, 0, 0);
}
