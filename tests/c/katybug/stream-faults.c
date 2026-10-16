/* The stream function of md5sum, sha1sum, sha256sum or sha512sum (the static
 * x86-64 coreutils 9.5 of userland-build.sh) run from a program that maps that
 * file's code at its own addresses and puts its own malloc, free, fread, feof
 * and ferror in place of libc's: the stream function, its block function, its
 * tail function and its finish function are the build's own bytes, and what
 * the stubs feed them is scripted. Each scenario prints what the stream
 * returned and the digest, the same natively, with katybug's kernels off, with
 * them on, and with the host digest on (tests/c/katybug/digest.sh).
 * usage: stream-faults <coreutils> <md5|sha1|sha224|sha256|sha384|sha512|b2>
 * <scenario> */
#include <stdint.h>

#define NR_WRITE 1
#define NR_OPEN 2
#define NR_MMAP 9
#define NR_MUNMAP 11
#define NR_SIGACTION 13
#define NR_SCHED_YIELD 24
#define NR_GETPID 39
#define NR_CLONE 56
#define NR_FORK 57
#define NR_EXIT 60
#define NR_WAIT4 61
#define NR_KILL 62
#define NR_ARCH_PRCTL 158
#define NR_EXIT_GROUP 231
#define SIGUSR1 10
#define SA_SIGINFO 4
#define SA_RESTORER 0x04000000
#define MAP_FIXED_PRIVATE 0x12
#define MAP_ANON_PRIVATE 0x22
#define BLOCK 32768

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

__asm__(".globl _start\n_start:\n xor %rbp, %rbp\n mov %rsp, %rdi\n and $-16, "
        "%rsp\n call stream_main\n hlt\n"
        ".globl restore_rt\nrestore_rt:\n mov $15, %eax\n syscall\n"
        /* fread: remember the callee-saved register that holds the context */
        ".globl fread_tramp\nfread_tramp:\n mov %r15, cur_ctx(%rip)\n jmp "
        "fread_c\n"
        ".globl thread_entry\nthread_entry:\n"
        "1: cmpl $0, thread_go(%rip)\n jne 2f\n mov $24, %eax\n syscall\n jmp "
        "1b\n"
        "2: mov $60, %eax\n xor %edi, %edi\n syscall\n");
void restore_rt(void);
void fread_tramp(void);
void thread_entry(void);

static char out[8192];
static int used;
static void flush(void) {
    sys(NR_WRITE, 1, (long) out, used);
    used = 0;
}
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
static void hexbytes(const uint8_t* p, int n) {
    for (int i = 0; i < n; i++) {
        out[used++] = "0123456789abcdef"[p[i] >> 4];
        out[used++] = "0123456789abcdef"[p[i] & 15];
    }
}
static void hex32(uint32_t v) {
    for (int i = 28; i >= 0; i -= 4)
        out[used++] = "0123456789abcdef"[v >> i & 15];
}

enum
{
    A_NONE,
    A_SIGNAL,
    A_NESTED,
    A_EXIT,
    A_UNMAP,
    A_READCTX,
    A_FORK
};

/* what the stubs read: bytes of a generated stream, handed out in pieces */
struct src {
    long total, pos;
    int sched[4], ns; /* a read returns at most this many, 0 for the request */
    int calls, fail_at, act_at, act, eof, err;
};
const uint8_t* volatile cur_ctx;
volatile int thread_go;

struct ksigaction {
    void (*handler)(int, void*, void*);
    unsigned long flags;
    void (*restorer)(void);
    unsigned long mask;
};
static void on_usr1(int s, void* info, void* uc) {
    (void) s, (void) info, (void) uc;
    put("handler\n");
    flush();
}
static void install(void) {
    struct ksigaction a = {on_usr1, SA_SIGINFO | SA_RESTORER, restore_rt, 0};
    sys6(NR_SIGACTION, SIGUSR1, (long) &a, 0, 8, 0, 0);
}

static void* malloc_c(long n) {
    /* each buffer gets its own 64 KiB so a page of it can be unmapped */
    long at = sys6(NR_MMAP, 0, 0x10000, 3, MAP_ANON_PRIVATE, -1, 0);
    (void) n;
    return (void*) at;
}
static void free_c(void* p) {
    (void) p;
}
static int feof_c(struct src* s) {
    return s->eof;
}
static int ferror_c(struct src* s) {
    return s->err;
}

static int alg_n;
static long alg_entry;
/* the third argument is blake2b's digest length, which the others ignore */
typedef long (*stream_fn)(struct src*, void*, long);

static long run_stream(struct src* s, uint8_t* res) {
    return ((stream_fn) alg_entry)(s, res, 64);
}

static void act(struct src* s, char* buf) {
    switch (s->act) {
        case A_SIGNAL: sys(NR_KILL, sys(NR_GETPID, 0, 0, 0), SIGUSR1, 0); break;
        case A_NESTED: {
            struct src t = {.total = 70000, .ns = 1};
            uint8_t res[64] = {0};
            long rc = run_stream(&t, res);
            put("nested: rc ");
            num(rc);
            put(" ");
            hexbytes(res, alg_n);
            put("\n");
            break;
        }
        case A_EXIT:
            flush();
            sys(NR_EXIT_GROUP, 7, 0, 0);
            break;
        case A_UNMAP: sys(NR_MUNMAP, (long) buf + 0x4000, 0x1000, 0); break;
        case A_READCTX: {
            const uint32_t* c = (const uint32_t*) cur_ctx;
            put("context ");
            hex32(c[0]);
            put(" ");
            hex32(c[1]);
            put("\n");
            break;
        }
        case A_FORK: {
            long pid = sys(NR_FORK, 0, 0, 0);
            if (pid == 0)
                put("child ");
            else {
                long st = 0;
                sys6(NR_WAIT4, pid, (long) &st, 0, 0, 0, 0);
                put("parent saw ");
                num(st >> 8 & 255);
                put("\n");
            }
            break;
        }
    }
}

/* the stream function reads in pieces; a read returns what the schedule lets it
 */
long fread_c(char* buf, long size, long n, struct src* s) {
    (void) size;
    s->calls++;
    if (s->fail_at && s->calls >= s->fail_at) return s->err = 1, 0;
    long want = n, avail = s->total - s->pos;
    int lim = s->sched[(s->calls - 1) % s->ns];
    if (lim && want > lim) want = lim;
    if (want > avail) want = avail;
    for (long i = 0; i < want; i++) {
        long p = s->pos + i;
        buf[i] = (char) (p * 131 + (p >> 9) * 7 + 5);
    }
    s->pos += want;
    if (want < n && s->pos == s->total) s->eof = 1;
    if (s->act_at == s->calls) act(s, buf);
    return want;
}

static long tls[64];
static const long CALLEES[5] = {
    0x4ed3fc, 0x4aca60, 0x4f52cf, 0x4f4bc1, 0x4f4c01
};

/* the stream function's calls into libc land on these: mov $stub, %rax; jmp
 * *%rax */
static void patch(long at, void* stub) {
    uint8_t* p = (uint8_t*) at;
    p[0] = 0x48, p[1] = 0xb8;
    for (int i = 0; i < 8; i++) p[2 + i] = (uint8_t) ((uint64_t) stub >> 8 * i);
    p[10] = 0xff, p[11] = 0xe0;
}

static long mapped;

static void one(const char* label, struct src* s) {
    uint8_t res[64] = {0};
    long rc = run_stream(s, res);
    put(label);
    put(": rc ");
    num(rc);
    put(" ");
    hexbytes(res, alg_n);
    put(" read ");
    num(s->pos);
    put(" calls ");
    num(s->calls);
    put("\n");
}

static struct src mk(long total, int s0, int s1) {
    struct src s = {.total = total, .ns = 2};
    s.sched[0] = s0, s.sched[1] = s1;
    return s;
}

static int streq(const char* a, const char* b) {
    while (*a && *a == *b) a++, b++;
    return !*a && !*b;
}

void stream_main(long* sp) {
    const char* path = (const char*) sp[2];
    const char* alg = (const char*) sp[3];
    const char* scn = (const char*) sp[4];
    long fd = sys(NR_OPEN, (long) path, 0, 0);
    /* the code and the read-only data at their own addresses, as a private copy
     */
    mapped =
        sys6(NR_MMAP, 0x401000, 0x180000, 7, MAP_FIXED_PRIVATE, fd, 0x1000);
    if (fd < 0 || mapped != 0x401000) {
        put("no code\n");
        flush();
        sys(NR_EXIT, 1, 0, 0);
    }
    /* the writable data: blake2b's final clears its block through a pointer to
     * memset that sits there */
    if (sys6(NR_MMAP, 0x581000, 0xc000, 3, MAP_FIXED_PRIVATE, fd, 0x180000) !=
        0x581000) {
        put("no data\n");
        flush();
        sys(NR_EXIT, 1, 0, 0);
    }
    sys(NR_ARCH_PRCTL, 0x1002, (long) tls, 0);
    void* stubs[5] = {malloc_c, free_c, fread_tramp, feof_c, ferror_c};
    for (int i = 0; i < 5; i++) patch(CALLEES[i], stubs[i]);
    if (streq(alg, "md5"))
        alg_entry = 0x49ac30, alg_n = 16;
    else if (streq(alg, "sha1"))
        alg_entry = 0x49bc30, alg_n = 20;
    else if (streq(alg, "sha256"))
        alg_entry = 0x49d980, alg_n = 32;
    else if (streq(alg, "sha224"))
        alg_entry = 0x49d9a0, alg_n = 28;
    else if (streq(alg, "sha384"))
        alg_entry = 0x4a0ec0, alg_n = 48;
    else if (streq(alg, "b2"))
        alg_entry = 0x411470, alg_n = 64;
    else
        alg_entry = 0x4a0ea0, alg_n = 64;

    if (streq(scn, "plain")) {
        struct src s = mk(5 * BLOCK + 1000, 0, 0);
        one("plain", &s);
    }
    else if (streq(scn, "exact")) {
        struct src s = mk(3 * BLOCK, 0, 0);
        one("exact", &s);
    }
    else if (streq(scn, "short")) {
        struct src s = mk(4 * BLOCK + 77, 10000, 22768);
        one("short reads", &s);
    }
    else if (streq(scn, "small")) {
        struct src a = mk(0, 0, 0), b = mk(100, 0, 0), c = mk(BLOCK - 1, 0, 0);
        one("empty", &a);
        one("100 bytes", &b);
        one("one short of a block", &c);
    }
    else if (streq(scn, "error")) {
        struct src a = mk(5 * BLOCK, 0, 0), b = mk(3 * BLOCK + 5, 0, 0);
        struct src c = mk(5 * BLOCK, 0, 0), d = mk(100, 0, 0);
        a.fail_at = 3;
        one("fails after two blocks", &a);
        one("then a whole stream", &b);
        c.fail_at = 4;
        one("fails again", &c);
        one("then a small one", &d);
    }
    else if (streq(scn, "nested")) {
        struct src s = mk(4 * BLOCK + 9, 0, 0);
        s.act_at = 3, s.act = A_NESTED;
        one("outer", &s);
    }
    else if (streq(scn, "handler")) {
        install();
        struct src s = mk(4 * BLOCK + 9, 0, 0);
        s.act_at = 3, s.act = A_SIGNAL;
        one("with a handler", &s);
    }
    else if (streq(scn, "thread")) {
        long stk = sys6(NR_MMAP, 0, 0x10000, 3, MAP_ANON_PRIVATE, -1, 0);
        register long r10 __asm__("r10") = 0;
        register long r8 __asm__("r8") = 0;
        long r;
        __asm__ volatile(
            "syscall\n test %%rax, %%rax\n jnz 1f\n jmp thread_entry\n 1:"
            : "=a"(r)
            : "a"(NR_CLONE), "D"(0x50f00L), "S"(stk + 0x10000), "d"(0L),
              "r"(r10), "r"(r8)
            : "rcx", "r11", "memory"
        );
        struct src s = mk(4 * BLOCK + 9, 0, 0);
        one("with a thread", &s);
        thread_go = 1;
        for (int i = 0; i < 4; i++) sys(NR_SCHED_YIELD, 0, 0, 0);
    }
    else if (streq(scn, "fork-before")) {
        long pid = sys(NR_FORK, 0, 0, 0);
        struct src s = mk(4 * BLOCK + 9, 0, 0);
        put(pid == 0 ? "child " : "parent ");
        one("hashed", &s);
        if (pid == 0) {
            flush();
            sys(NR_EXIT_GROUP, 0, 0, 0);
        }
        long st = 0;
        sys6(NR_WAIT4, pid, (long) &st, 0, 0, 0, 0);
        put("child status ");
        num(st >> 8 & 255);
        put("\n");
    }
    else if (streq(scn, "fork-after")) {
        struct src s = mk(4 * BLOCK + 9, 0, 0);
        one("hashed", &s);
        long pid = sys(NR_FORK, 0, 0, 0);
        struct src t = mk(3 * BLOCK + 1, 0, 0);
        one(pid == 0 ? "child" : "parent", &t);
        if (pid == 0) {
            flush();
            sys(NR_EXIT_GROUP, 0, 0, 0);
        }
        sys6(NR_WAIT4, pid, 0, 0, 0, 0, 0);
    }
    else if (streq(scn, "fork-mid")) {
        struct src s = mk(4 * BLOCK + 9, 0, 0);
        s.act_at = 3, s.act = A_FORK;
        one("hashed", &s);
    }
    else if (streq(scn, "unmap")) {
        struct src s = mk(4 * BLOCK + 9, 0, 0);
        s.act_at = 3, s.act = A_UNMAP;
        flush();
        one("buffer loses a page", &s);
    }
    else if (streq(scn, "exit")) {
        struct src s = mk(5 * BLOCK, 0, 0);
        s.act_at = 3, s.act = A_EXIT;
        one("exits", &s);
    }
    else if (streq(scn, "context")) {
        struct src s = mk(4 * BLOCK + 9, 0, 0);
        s.act_at = 3, s.act = A_READCTX;
        one("reads the context", &s);
    }
    flush();
    sys(NR_EXIT_GROUP, 0, 0, 0);
}
