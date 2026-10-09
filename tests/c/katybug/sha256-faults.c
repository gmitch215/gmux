/* The sha256, md5, sha1 or sha512 block function of the static x86-64
 * coreutils 9.5 (userland-build.sh) called from a program that copies its
 * machine code out of that file: results, and what a buffer or a context that
 * is not all there does. The output must be the same natively and with
 * katybug's kernel on and off. usage: sha256-faults <coreutils>
 * [sha256|md5|sha1|sha512] */
#include <stdint.h>

#define NR_READ 0
#define NR_WRITE 1
#define NR_OPEN 2
#define NR_MMAP 9
#define NR_MUNMAP 11
#define NR_SIGACTION 13
#define NR_PREAD 17
#define NR_ARCH_PRCTL 158
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
__asm__(".globl _start\n_start:\n xor %rbp, %rbp\n mov %rsp, %rdi\n and $-16, "
        "%rsp\n call "
        "sha_main\n hlt\n"
        ".globl restore_rt\nrestore_rt:\n mov $15, %eax\n syscall\n");
volatile long saved_sp;
/* a fault resumes at try_done with the stack as it was, and the callee-saved
 * registers the function had pushed are put back from this frame */
__asm__(
    ".globl call_guarded\ncall_guarded:\n"
    " push %rbx\n push %rbp\n push %r12\n push %r13\n push %r14\n push %r15\n"
    " sub $8, %rsp\n mov %rsp, saved_sp(%rip)\n"
    " mov %rdi, %rax\n mov %rsi, %rdi\n mov %rdx, %rsi\n mov %rcx, %rdx\n"
    " call *%rax\n"
    ".globl try_done\ntry_done:\n"
    " add $8, %rsp\n pop %r15\n pop %r14\n pop %r13\n pop %r12\n pop %rbp\n"
    " pop %rbx\n ret\n"
);
void call_guarded(void* fn, long a, long b, long c);
#define sys(n, a, b, c) sys6(n, a, b, c, 0, 0, 0)
#define SA_SIGINFO 4
#define SA_RESTORER 0x04000000
#define SIGSEGV 11
#define MAP_FIXED_ANON 0x32 /* MAP_PRIVATE | MAP_FIXED | MAP_ANONYMOUS */
void restore_rt(void);
extern char try_done[];

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
static void hex(uint64_t v, int wsz) {
    for (int i = 8 * wsz - 4; i >= 0; i -= 4)
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
    mc[MC_PC / 8] = (long) try_done;
    mc[MC_SP / 8] = saved_sp;
    (void) MC_X0;
}

/* the context: nw state words and the two count words, wsz bytes each (the
 * buffer length field and the buffer come after them) */
struct ctx {
    uint8_t b[80];
};
static const struct hash {
    const char* name;
    long offset, len;
    int nw, wsz, block;
    uint64_t init[8];
} hashes[] = {
    {"sha256",
     0x9db20,
     11154,
     8,
     4,
     64,
     {0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c,
      0x1f83d9ab, 0x5be0cd19}},
    {"md5",
     0x9ae70,
     1881,
     4,
     4,
     64,
     {0x67452301, 0xefcdab89, 0x98badcfe, 0x10325476}},
    {"sha1",
     0x9bea0,
     5127,
     5,
     4,
     64,
     {0x67452301, 0xefcdab89, 0x98badcfe, 0x10325476, 0xc3d2e1f0}},
    {"sha512",
     0xa1060,
     16132,
     8,
     8,
     128,
     {0x6a09e667f3bcc908ull, 0xbb67ae8584caa73bull, 0x3c6ef372fe94f82bull,
      0xa54ff53a5f1d36f1ull, 0x510e527fade682d1ull, 0x9b05688c2b3e6c1full,
      0x1f83d9abfb41bd6bull, 0x5be0cd19137e2179ull}},
};
#define NHASHES (sizeof hashes / sizeof *hashes)
static const struct hash* h = &hashes[0];

static uint64_t word(const struct ctx* c, int i) {
    uint64_t v = 0;
    for (int b = h->wsz - 1; b >= 0; b--) v = v << 8 | c->b[i * h->wsz + b];
    return v;
}
static void set_word(struct ctx* c, int i, uint64_t v) {
    for (int b = 0; b < h->wsz; b++)
        c->b[i * h->wsz + b] = (uint8_t) (v >> 8 * b);
}

static void* code;
static long tls[64];

/* one call: ctx starts at the hash's initial state with a count near the
 * carry; the output is the context afterwards, or where the call faulted (an
 * offset from ref) and the context then */
static void call(
    const char* name, struct ctx* c, int setup, const char* ref,
    const void* buf, long len
) {
    int n = h->nw + 2;
    uint64_t near = h->wsz == 8 ? 0xfffffffffffffff0ull : 0xfffffff0;
    for (int i = 0; setup && i < n; i++)
        set_word(c, i, i < h->nw ? h->init[i] : i == h->nw ? near : 7);
    long before = faults;
    call_guarded(code, (long) buf, len, (long) c);
    put(name);
    put(": ");
    if (faults != before) {
        put("fault ");
        num(f_addr - (long) ref);
        put(" ");
    }
    for (int i = 0; setup && i < n; i++) {
        hex(word(c, i), h->wsz);
        put(i < n - 1 ? " " : "\n");
    }
    if (!setup) put("\n");
    sys(NR_WRITE, 1, (long) out, used);
    used = 0;
}

void sha_main(long* sp) {
    char* path = (char*) sp[2];
    if (sp[0] > 2)
        for (unsigned i = 0; i < NHASHES; i++) {
            const char *want = hashes[i].name, *got = (char*) sp[3];
            while (*want && *want == *got) want++, got++;
            if (!*want && !*got) h = &hashes[i];
        }
    long csz = h->wsz * (h->nw + 2);
    struct ksigaction a = {on_segv, SA_SIGINFO | SA_RESTORER, restore_rt, 0};
    sys6(NR_SIGACTION, SIGSEGV, (long) &a, 0, 8, 0, 0);
    /* the function reads its stack guard at %fs:0x28 */
    sys(NR_ARCH_PRCTL, 0x1002, (long) tls, 0);
    long fd = sys(NR_OPEN, (long) path, 0, 0);
    code = (void*) sys6(NR_MMAP, 0, 16384, 7, 0x22, -1, 0);
    if (fd < 0 || (long) code < 0 ||
        sys6(NR_PREAD, fd, (long) code, h->len, h->offset, 0, 0) != h->len) {
        put("no code\n");
        sys(NR_WRITE, 1, (long) out, used);
        sys(NR_EXIT, 1, 0, 0);
    }
    /* A: a page and a hole; B: two mappings side by side; C: a page, a
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
    for (int i = 0; i < 4096; i++)
        A[i] = (char) (i * 7 + (i >> 5)), C[i] = (char) (i * 13 + 5);
    for (int i = 0; i < 8192; i++) B[i] = (char) (i * 11 + (i >> 7));
    for (int i = 0; i < 4096; i++) C[8192 + i] = (char) (i * 3 + 1);
    static struct ctx ok;
    struct ctx* hole = (struct ctx*) (A + 4096 + 64);
    struct ctx* edge =
        (struct ctx*) (A + 4096 - csz); /* its last byte is the page's */
    struct ctx* split = (struct ctx*) (B + 4096 - 16); /* across two mappings */
    struct ctx* mid = (struct ctx*) (B + 2048);
    struct ctx* none = (struct ctx*) (C + 4096 + 8);

    long bs = h->block;
    call("empty", &ok, 1, A, A, 0);
    call("one block", &ok, 1, A, A + 100, bs);
    call("blocks", &ok, 1, A, A + 64, 3072);
    call("whole page", &ok, 1, A, A, 4096);
    call("page, ends at the page end", &ok, 1, A, A + 4096 - 3 * bs, 3 * bs);
    call("across mappings", &ok, 1, B, B + 4096 - 2 * bs, 4 * bs);
    call("count carries", &ok, 1, A, A, 2 * bs);
    call("len 2^32", &ok, 1, A, A, 1L << 32);
    call("buffer runs into the hole", &ok, 1, A, A + 4096 - bs, 2 * bs);
    call("buffer starts in the hole", &ok, 1, A, A + 4096, bs);
    call("buffer runs into PROT_NONE", &ok, 1, C, C + 4096 - bs, 2 * bs);
    call("buffer past the end", &ok, 1, A, A, 8192);
    call("len 2^40", &ok, 1, A, A, 1L << 40);
    call("len not a multiple of 64", &ok, 1, A, A + 4096 - 192, 100);
    call("len 100 past the end", &ok, 1, A, A + 4096 - 100, 100);
    call("ctx in the hole", hole, 0, A, A, bs);
    call(
        "ctx runs into the hole", (struct ctx*) (A + 4096 - (csz / 2 & ~3)), 0,
        A, A, bs
    );
    call("ctx at the page end", edge, 1, A, B, bs);
    call("ctx across mappings", split, 1, B, A, bs);
    call("ctx runs into PROT_NONE", none, 0, C, A, bs);
    call("buffer over the context", mid, 1, B, (char*) mid, bs);
    call("buffer over the count", mid, 1, B, (char*) mid + h->wsz * h->nw, bs);
    call("buffer just past the count", mid, 1, B, (char*) mid + csz, bs);

    put("faults ");
    num(faults);
    put("\n");
    sys(NR_WRITE, 1, (long) out, used);
    sys(NR_EXIT, 0, 0, 0);
}
