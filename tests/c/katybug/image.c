#include <stdint.h>

#if defined(__x86_64__)
    #define NR_READ 0
    #define NR_WRITE 1
    #define NR_CLOSE 3
    #define NR_MMAP 9
    #define NR_MPROTECT 10
    #define NR_MUNMAP 11
    #define NR_SIGACTION 13
    #define NR_PREAD 17
    #define NR_PWRITE 18
    #define NR_FTRUNCATE 77
    #define NR_WAIT4 61
    #define NR_EXIT 60
    #define NR_PIPE 22
    #define FORK() sys6(57, 0, 0, 0, 0, 0, 0)
    #define OPEN_RW(path) sys6(2, (long) (path), 2, 0, 0, 0, 0)
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
        "%rsp\n call image_main\n hlt\n");
#elif defined(__aarch64__)
    #define NR_READ 63
    #define NR_WRITE 64
    #define NR_CLOSE 57
    #define NR_MMAP 222
    #define NR_MPROTECT 226
    #define NR_MUNMAP 215
    #define NR_SIGACTION 134
    #define NR_PREAD 67
    #define NR_PWRITE 68
    #define NR_FTRUNCATE 46
    #define NR_WAIT4 260
    #define NR_EXIT 93
    #define NR_PIPE 59
    #define FORK() sys6(220, 17, 0, 0, 0, 0, 0)
    #define OPEN_RW(path) sys6(56, -100, (long) (path), 2, 0, 0, 0)
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
__asm__(".globl _start\n_start:\n mov x0, sp\n bl image_main\n");
#endif

/* the program's own file fills its image a piece at a time, when a piece is
 * first touched: eight pieces of data, each starting on a 64 KiB address and
 * holding "KBL", its number, then one byte value for the rest. They come last
 * in the file, so cutting it short leaves the code */
#define PIECE 0x10000ul
#define NB 8
#define BLOCK(k)                                                               \
    [(k) * PIECE + 0] = 'K', [(k) * PIECE + 1] = 'B', [(k) * PIECE + 2] = 'L', \
                   [(k) * PIECE + 3] = (k),                                    \
                   [(k) * PIECE + 4 ...(k) * PIECE + PIECE - 1] = 0x40 + (k)
static uint8_t big[NB * PIECE]
    __attribute__((aligned(PIECE))) = {BLOCK(0), BLOCK(1), BLOCK(2), BLOCK(3),
                                       BLOCK(4), BLOCK(5), BLOCK(6), BLOCK(7)};

/* the same in a read-only segment: pieces of it are the file's own pages until
 * something writes them */
static const uint8_t rbig[NB * PIECE]
    __attribute__((aligned(PIECE))) = {BLOCK(0), BLOCK(1), BLOCK(2), BLOCK(3),
                                       BLOCK(4), BLOCK(5), BLOCK(6), BLOCK(7)};

#define PROT_RWX 7
#define MAP_FIXED_ANON 0x32 /* MAP_PRIVATE | MAP_FIXED | MAP_ANONYMOUS */

static int failed;
static long self_fd;
static const char* mode_name;

static void say(const char* s) {
    long n = 0;
    while (s[n]) n++;
    sys6(NR_WRITE, 1, (long) s, n, 0, 0, 0);
}

static void report(const char* name, int ok) {
    say(name);
    say(ok ? " ok\n" : " FAIL\n");
    failed |= !ok;
}

/* bytes [from, to) of block k of base are what the file holds there (or zero)
 */
static int blocks_are(
    const uint8_t* base, int k, unsigned long from, unsigned long to, int zero
) {
    volatile const uint8_t* p = base + (unsigned long) k * PIECE;
    for (unsigned long i = from; i < to; i++) {
        uint8_t want = (uint8_t) (0x40 + k);
        if (i == 0) want = 'K';
        if (i == 1) want = 'B';
        if (i == 2) want = 'L';
        if (i == 3) want = (uint8_t) k;
        if (zero) want = 0;
        if (p[i] != want) return 0;
    }
    return 1;
}

static int block_is(int k, unsigned long from, unsigned long to, int zero) {
    return blocks_are(big, k, from, to, zero);
}

/* the read-only pieces under test: the image's own, or a file mapping of the
 * same bytes (fmap) */
static const uint8_t* volatile rbase = rbig;

static int rblock_is(int k, unsigned long from, unsigned long to, int zero) {
    return blocks_are(rbase, k, from, to, zero);
}

/* where the file holds the byte at va, from its own program headers */
static long file_offset(const void* va) {
    uint64_t eh[8], ph[7];
    if (sys6(NR_PREAD, self_fd, (long) eh, 64, 0, 0, 0) != 64) return -1;
    for (unsigned i = 0; i < (eh[7] & 0xffff); i++) {
        if (sys6(
                NR_PREAD, self_fd, (long) ph, 56, (long) (eh[4] + i * 56), 0, 0
            ) != 56)
            return -1;
        if ((uint32_t) ph[0] != 1) continue;
        if ((uint64_t) va >= ph[2] && (uint64_t) va < ph[2] + ph[4])
            return (long) (ph[1] + (uint64_t) va - ph[2]);
    }
    return -1;
}

struct ksigaction {
    void (*handler)(int);
    unsigned long flags;
    void (*restorer)(void);
    unsigned long mask;
};

/* the signal a child died of is its exit status: 100 + the number */
static void on_signal(int s) {
    sys6(NR_EXIT, 100 + s, 0, 0, 0, 0, 0);
}

/* fn in a forked child with SIGSEGV and SIGBUS handled; the child's exit
 * status (fn's value, or 107 for SIGBUS and 111 for SIGSEGV), or -1 */
static long child(int (*fn)(void)) {
    long pid = FORK();
    if (pid < 0) return -1;
    if (pid == 0) {
        struct ksigaction a = {on_signal, 0, 0, 0};
        sys6(NR_SIGACTION, 11, (long) &a, 0, 8, 0, 0);
        sys6(NR_SIGACTION, 7, (long) &a, 0, 8, 0, 0);
        sys6(NR_EXIT, fn(), 0, 0, 0, 0, 0);
    }
    int status = 0;
    if (sys6(NR_WAIT4, pid, (long) &status, 0, 0, 0, 0) != pid) return -1;
    return (status & 0x7f) ? -1 : (status >> 8) & 0xff;
}

static volatile const uint8_t* target;

static int touch(void) {
    return target[0] != 0xfe; /* never equal in these checks: 1 if it returns */
}

static int every_block(void) {
    for (int k = 0; k < NB; k++)
        if (!block_is(k, 0, PIECE, 0)) return 1;
    return 0;
}

static int mode_read(void) {
    static const int order[NB] = {5, 2, 7, 0, 4, 1, 6, 3};
    for (int i = 0; i < NB; i++)
        if (!block_is(order[i], 0, 16, 0)) return 0;
    return !every_block();
}

/* a write to the file reaches a piece that has not been made, and not one that
 * has */
static int mode_rewrite(void) {
    if (!block_is(0, 0, 16, 0)) return 0;
    long f0 = file_offset(big), f5 = file_offset(big + 5 * PIECE);
    uint8_t nw[4] = {'N', 'E', 'W', 9};
    if (f0 < 0 || f5 < 0 ||
        sys6(NR_PWRITE, self_fd, (long) nw, 4, f0, 0, 0) != 4 ||
        sys6(NR_PWRITE, self_fd, (long) nw, 4, f5, 0, 0) != 4)
        return 0;
    volatile const uint8_t* b0 = big;
    volatile const uint8_t* b5 = big + 5 * PIECE;
    return b5[0] == 'N' && b5[1] == 'E' && b5[2] == 'W' && b5[3] == 9 &&
           b5[4] == 0x45 && b0[0] == 'K' && b0[3] == 0 && b0[4] == 0x40;
}

static int touch_7(void) {
    target = big + 7 * PIECE;
    return touch();
}

static int write_from_7(void) {
    return sys6(NR_WRITE, 1, (long) (big + 7 * PIECE), 1, 0, 0, 0) != -14;
}

/* a file cut short ends a piece that needs a page past its end in SIGBUS (and
 * a system call on it in EFAULT); pieces before the cut still read */
static int mode_truncate(void) {
    long f6 = file_offset(big + 6 * PIECE);
    if (f6 < 0 || sys6(NR_FTRUNCATE, self_fd, f6 + 100, 0, 0, 0, 0)) return 0;
    if (child(touch_7) != 107 || child(write_from_7) != 0) return 0;
    return block_is(4, 0, PIECE, 0) && block_is(0, 0, PIECE, 0);
}

static int fork_writes(void) {
    volatile uint8_t* p = (volatile uint8_t*) (big + 2 * PIECE);
    for (unsigned long i = 0; i < PIECE; i++) p[i] = 0xee;
    for (unsigned long i = 0; i < PIECE; i++)
        if (p[i] != 0xee) return 1;
    return 0;
}

/* a child forked before the parent touched a piece, and after, reads the
 * file's bytes; what it writes is its own */
static int mode_fork(void) {
    for (int k = 0; k < NB; k++) {
        if (child(every_block) != 0) return 0;
        if (!block_is(k, 0, PIECE, 0)) return 0;
    }
    return child(fork_writes) == 0 && !every_block();
}

static long map_over(unsigned long va, unsigned long len) {
    return sys6(
        NR_MMAP, (long) va, (long) len, PROT_RWX, MAP_FIXED_ANON, -1, 0
    );
}

static int tail_replaced(void) {
    for (int k = 0; k < 4; k++)
        if (!block_is(k, 0, PIECE, 0)) return 1;
    return !(
        block_is(4, 0, 0x8000, 0) && block_is(4, 0x8000, 0xc000, 1) &&
        block_is(4, 0xc000, PIECE, 0) && block_is(5, 0, PIECE, 0) &&
        block_is(6, 0, PIECE, 1) && block_is(7, 0, PIECE, 1)
    );
}

/* a fixed mapping over the image's last pieces, and over part of a piece the
 * parent has not touched, reads zero there and the file's bytes elsewhere */
static int mode_replace(void) {
    unsigned long b = (unsigned long) big;
    if (map_over(b + 6 * PIECE, 2 * PIECE) != (long) (b + 6 * PIECE) ||
        map_over(b + 4 * PIECE + 0x8000, 0x4000) !=
            (long) (b + 4 * PIECE + 0x8000))
        return 0;
    if (child(tail_replaced) != 0 || tail_replaced()) return 0;
    volatile uint8_t* p = (volatile uint8_t*) (big + 7 * PIECE + 100);
    *p = 0x77;
    if (*p != 0x77) return 0;
    *p = 0;
    return child(tail_replaced) == 0;
}

static int touch_hole(void) {
    return touch();
}

static int protected_ok(void) {
    return !(
        block_is(0, 0, PIECE, 0) && block_is(2, 0, PIECE, 0) &&
        block_is(3, 0, 0x1000, 0) && block_is(3, 0x1000, 0x2000, 1) &&
        block_is(3, 0x2000, PIECE, 0)
    );
}

/* mprotect and munmap in the middle of a piece nobody has touched, and
 * mprotect across one that was: the pages outside the range read the file, the
 * page unmapped or without access faults, a page given back reads the file or
 * zero as it should */
static int mode_protect(void) {
    unsigned long b = (unsigned long) big;
    if (!block_is(0, 0, 16, 0)) return 0;
    if (sys6(NR_MPROTECT, (long) (b + 2 * PIECE + 0x3000), 0x2000, 0, 0, 0, 0))
        return 0;
    target = big + 2 * PIECE + 0x3000;
    if (child(touch_hole) != 111) return 0;
    if (!block_is(2, 0, 0x3000, 0) || !block_is(2, 0x5000, PIECE, 0)) return 0;
    if (sys6(
            NR_MPROTECT, (long) (b + 2 * PIECE + 0x3000), 0x2000, PROT_RWX, 0,
            0, 0
        ))
        return 0;
    if (!block_is(2, 0, PIECE, 0)) return 0;
    if (sys6(NR_MUNMAP, (long) (b + 3 * PIECE + 0x1000), 0x1000, 0, 0, 0, 0))
        return 0;
    target = big + 3 * PIECE + 0x1000;
    if (child(touch_hole) != 111) return 0;
    if (!block_is(3, 0, 0x1000, 0) || !block_is(3, 0x2000, PIECE, 0)) return 0;
    if (map_over(b + 3 * PIECE + 0x1000, 0x1000) !=
        (long) (b + 3 * PIECE + 0x1000))
        return 0;
    if (sys6(NR_MPROTECT, (long) (b + 0x2000), 0x1000, 1, 0, 0, 0)) return 0;
    return block_is(3, 0x1000, 0x2000, 1) && !protected_ok() &&
           child(protected_ok) == 0;
}

static volatile uint8_t* rw(unsigned long off) {
    return (volatile uint8_t*) rbase + off;
}

__attribute__((noinline)) static int peek_at(unsigned long off) {
    return *rw(off);
}

/* through a pointer, so every call is the one load instruction and its cache */
static int (*volatile peeker)(unsigned long) = peek_at;

#define peek(off) peeker(off)

/* a store and then a load in one block: the load's cache may hold a shared
 * piece the store is about to copy */
__attribute__((noinline)) static int store_load(
    volatile uint8_t* s, volatile uint8_t* l, uint8_t v
) {
    *s = v;
    return *l;
}

static int (*volatile store_loader)(
    volatile uint8_t*, volatile uint8_t*, uint8_t
) = store_load;

static int rblocks_ok(void) {
    for (int k = 0; k < NB; k++)
        if (!rblock_is(k, 0, PIECE, 0)) return 0;
    return 1;
}

/* pieces of a read-only segment read in any order give the file's bytes, and a
 * system call that reads one is served */
static int mode_share(void) {
    static const int order[NB] = {3, 0, 6, 1, 7, 2, 5, 4};
    for (int i = 0; i < NB; i++)
        if (!rblock_is(order[i], 0, 16, 0)) return 0;
    long nul = OPEN_RW("/dev/null");
    return nul >= 0 && rblocks_ok() &&
           sys6(NR_WRITE, nul, (long) (rbase + 2 * PIECE), 16, 0, 0, 0) == 16;
}

/* the read-only pieces made writable, which keeps them the file's own pages
 * until something writes one */
static int writable(void) {
    return !sys6(NR_MPROTECT, (long) rbase, NB * PIECE, 3, 0, 0, 0);
}

/* a store and a read() into pieces already read change those bytes only, in
 * this process */
static int mode_sharewrite(void) {
    if (!writable()) return 0;
    if (!rblock_is(1, 0, 16, 0) || !rblock_is(2, 0, 16, 0) ||
        !rblock_is(3, 0, 16, 0))
        return 0;
    if (!rblock_is(6, 0, 16, 0) ||
        store_loader((volatile uint8_t*) big + 8, rw(6 * PIECE + 20), 1) !=
            0x46 ||
        store_loader(rw(6 * PIECE + 20), rw(6 * PIECE + 20), 0x99) != 0x99)
        return 0;
    if (peek(PIECE + 100) != 0x41)
        return 0; /* the load's cache holds the shared piece */
    *rw(PIECE + 100) = 0x99;
    if (peek(PIECE + 100) != 0x99 || !rblock_is(1, 0, 100, 0) ||
        !rblock_is(1, 101, PIECE, 0))
        return 0;
    uint8_t want[8];
    if (sys6(NR_PREAD, self_fd, (long) want, 8, 0, 0, 0) != 8 ||
        sys6(
            NR_PREAD, self_fd, (long) (rbase + 2 * PIECE + 0x200), 8, 0, 0, 0
        ) != 8)
        return 0;
    for (int i = 0; i < 8; i++)
        if (*rw(2 * PIECE + 0x200 + (unsigned long) i) != want[i]) return 0;
    return rblock_is(2, 0, 0x200, 0) && rblock_is(2, 0x208, PIECE, 0) &&
           rblock_is(3, 0, PIECE, 0) && rblock_is(4, 0, PIECE, 0);
}

static int child_reads(void) {
    return !rblocks_ok();
}

static int child_writes(void) {
    for (unsigned long i = 0; i < PIECE; i++) *rw(PIECE + i) = 0xee;
    for (unsigned long i = 0; i < PIECE; i++)
        if (*rw(PIECE + i) != 0xee) return 1;
    return 0;
}

static int pipe_fd[2];

/* waits until the parent has written (and so copied the piece it shares), then
 * reads the file's bytes */
static int child_late(void) {
    char c;
    if (!rblock_is(3, 0, 16, 0)) return 1;
    sys6(NR_READ, pipe_fd[0], (long) &c, 1, 0, 0, 0);
    return !rblock_is(3, 0, PIECE, 0);
}

/* a child forked while pieces are shared reads the file's bytes and what it
 * writes is its own; the parent writing after the fork changes nothing for it
 */
static int mode_sharefork(void) {
    if (!writable()) return 0;
    for (int k = 0; k < NB; k++) {
        if (!rblock_is(k, 0, 16, 0) || child(child_reads) != 0) return 0;
    }
    if (child(child_writes) != 0 || !rblock_is(1, 0, PIECE, 0)) return 0;
    if (sys6(NR_PIPE, (long) pipe_fd, 0, 0, 0, 0, 0)) return 0;
    long pid = FORK();
    if (pid < 0) return 0;
    if (pid == 0) sys6(NR_EXIT, child_late(), 0, 0, 0, 0, 0);
    *rw(3 * PIECE + 5) = 0x77;
    int status = -1;
    sys6(NR_WRITE, pipe_fd[1], (long) "x", 1, 0, 0, 0);
    if (sys6(NR_WAIT4, pid, (long) &status, 0, 0, 0, 0) != pid) return 0;
    return !(status & 0x7f) && !((status >> 8) & 0xff) &&
           *rw(3 * PIECE + 5) == 0x77;
}

/* mprotect and munmap across shared pieces: both halves of a split piece keep
 * the file's bytes, and what is gone or without access faults */
static int mode_shareprot(void) {
    if (!writable()) return 0;
    unsigned long b = (unsigned long) rbase;
    if (!rblock_is(1, 0, 16, 0) || !rblock_is(2, 0, 16, 0) ||
        !rblock_is(3, 0, 16, 0))
        return 0;
    if (sys6(NR_MUNMAP, (long) (b + PIECE + 0x1000), 0x1000, 0, 0, 0, 0))
        return 0;
    target = rbase + PIECE + 0x1000;
    if (child(touch_hole) != 111) return 0;
    if (!rblock_is(1, 0, 0x1000, 0) || !rblock_is(1, 0x2000, PIECE, 0))
        return 0;
    if (sys6(NR_MPROTECT, (long) (b + 2 * PIECE + 0x3000), 0x2000, 0, 0, 0, 0))
        return 0;
    target = rbase + 2 * PIECE + 0x3000;
    if (child(touch_hole) != 111) return 0;
    if (!rblock_is(2, 0, 0x3000, 0) || !rblock_is(2, 0x5000, PIECE, 0))
        return 0;
    if (sys6(
            NR_MPROTECT, (long) (b + 2 * PIECE + 0x3000), 0x2000, PROT_RWX, 0,
            0, 0
        ) ||
        !rblock_is(2, 0, PIECE, 0))
        return 0;
    if (sys6(NR_MUNMAP, (long) (b + 3 * PIECE), PIECE, 0, 0, 0, 0)) return 0;
    target = rbase + 3 * PIECE;
    if (child(touch_hole) != 111) return 0;
    *rw(PIECE + 0x2000) = 0x55;
    return *rw(PIECE + 0x2000) == 0x55 && rblock_is(1, 0x2001, PIECE, 0) &&
           rblock_is(4, 0, PIECE, 0);
}

/* the process that first read a piece exits while its child still holds the
 * shared piece: the child goes on reading the file's bytes (it reports, as the
 * parent leaves at once) */
static int mode_shareexit(void) {
    if (!rblock_is(0, 0, 16, 0) || !rblock_is(5, 0, 16, 0)) return 0;
    if (sys6(NR_PIPE, (long) pipe_fd, 0, 0, 0, 0, 0)) return 0;
    long pid = FORK();
    if (pid < 0) return 0;
    if (pid == 0) {
        char c;
        sys6(NR_CLOSE, pipe_fd[1], 0, 0, 0, 0, 0);
        sys6(NR_READ, pipe_fd[0], (long) &c, 1, 0, 0, 0);
        report(mode_name, rblocks_ok());
        sys6(NR_EXIT, failed, 0, 0, 0, 0, 0);
    }
    sys6(NR_EXIT, 0, 0, 0, 0, 0, 0);
    return 0;
}

/* a write to the file reaches pieces not yet made; one already read may show
 * it or not (as Linux's MAP_PRIVATE leaves it), and the rest of it never
 * changes */
static int mode_sharerewrite(void) {
    if (!rblock_is(0, 0, 16, 0)) return 0;
    long f0 = file_offset(rbig), f5 = file_offset(rbig + 5 * PIECE);
    uint8_t nw[4] = {'N', 'E', 'W', 9};
    if (f0 < 0 || f5 < 0 ||
        sys6(NR_PWRITE, self_fd, (long) nw, 4, f0, 0, 0) != 4 ||
        sys6(NR_PWRITE, self_fd, (long) nw, 4, f5, 0, 0) != 4)
        return 0;
    if (*rw(5 * PIECE) != 'N' || *rw(5 * PIECE + 1) != 'E' ||
        *rw(5 * PIECE + 2) != 'W' || *rw(5 * PIECE + 3) != 9 ||
        !rblock_is(5, 4, PIECE, 0))
        return 0;
    int old = rblock_is(0, 0, 4, 0);
    int new = *rw(0) == 'N' && *rw(1) == 'E' && *rw(2) == 'W' && *rw(3) == 9;
    return (old || new) && rblock_is(0, 4, PIECE, 0);
}

/* a file cut short below its data ends a piece of data that needs a page past
 * the cut in SIGBUS (and a call on it in EFAULT) as before, with read-only
 * pieces shared; those, and the ones not yet read, are before the cut and
 * read */
static int mode_sharetruncate(void) {
    for (int k = 0; k < 3; k++)
        if (!rblock_is(k, 0, 16, 0)) return 0;
    long f6 = file_offset(big + 6 * PIECE);
    if (f6 < 0 || sys6(NR_FTRUNCATE, self_fd, f6 + 100, 0, 0, 0, 0)) return 0;
    if (child(touch_7) != 107 || child(write_from_7) != 0) return 0;
    return rblocks_ok() && block_is(4, 0, PIECE, 0) && block_is(0, 0, PIECE, 0);
}

#define PROT_R 1
#define PROT_RW 3
#define MAP_PRIVATE 2

/* the file's bytes under p, mapped read-only and private and then made
 * writable: the pieces are the file's own until written */
static int fmap(const void* p) {
    long f = file_offset(p);
    long a =
        f < 0 ? f
              : sys6(NR_MMAP, 0, NB * PIECE, PROT_R, MAP_PRIVATE, self_fd, f);
    if (a < 0 && a > -4096) return 0;
    if (sys6(NR_MPROTECT, a, NB * PIECE, PROT_RW, 0, 0, 0)) return 0;
    rbase = (const uint8_t*) a;
    return 1;
}

static int fmode_share(void) {
    return fmap(rbig) && mode_share();
}

static int fmode_sharewrite(void) {
    return fmap(rbig) && mode_sharewrite();
}

static int fmode_sharefork(void) {
    return fmap(rbig) && mode_sharefork();
}

static int fmode_shareprot(void) {
    return fmap(rbig) && mode_shareprot();
}

static int fmode_shareexit(void) {
    return fmap(rbig) && mode_shareexit();
}

static int fmode_sharerewrite(void) {
    return fmap(rbig) && mode_sharerewrite();
}

static int write_from_target(void) {
    return sys6(NR_WRITE, 1, (long) target, 1, 0, 0, 0) != -14;
}

/* a mapping of the data's file range, cut short: the piece of it that needs a
 * page past the cut is SIGBUS and EFAULT, those before it read */
static int fmode_sharetruncate(void) {
    if (!fmap(big)) return 0;
    for (int k = 0; k < 3; k++)
        if (!rblock_is(k, 0, 16, 0)) return 0;
    long f6 = file_offset(big + 6 * PIECE);
    if (f6 < 0 || sys6(NR_FTRUNCATE, self_fd, f6 + 100, 0, 0, 0, 0)) return 0;
    target = rbase + 7 * PIECE;
    if (child(touch) != 107 || child(write_from_target) != 0) return 0;
    return rblock_is(0, 0, PIECE, 0) && rblock_is(4, 0, PIECE, 0) &&
           rblock_is(5, 0, PIECE, 0);
}

long image_main(long* sp) {
    const char* mode = (const char*) sp[2];
    mode_name = mode;
    self_fd = OPEN_RW(sp[1]);
    static const struct {
        const char* name;
        int (*fn)(void);
    } modes[] = {
        {"read", mode_read},
        {"rewrite", mode_rewrite},
        {"truncate", mode_truncate},
        {"fork", mode_fork},
        {"replace", mode_replace},
        {"protect", mode_protect},
        {"share", mode_share},
        {"sharewrite", mode_sharewrite},
        {"sharefork", mode_sharefork},
        {"shareprot", mode_shareprot},
        {"shareexit", mode_shareexit},
        {"sharerewrite", mode_sharerewrite},
        {"sharetruncate", mode_sharetruncate},
        {"fshare", fmode_share},
        {"fsharewrite", fmode_sharewrite},
        {"fsharefork", fmode_sharefork},
        {"fshareprot", fmode_shareprot},
        {"fshareexit", fmode_shareexit},
        {"fsharerewrite", fmode_sharerewrite},
        {"fsharetruncate", fmode_sharetruncate},
    };
    for (unsigned i = 0; i < sizeof modes / sizeof modes[0]; i++) {
        const char* a = modes[i].name;
        const char* b = mode;
        while (*a && *a == *b) a++, b++;
        if (!*a && !*b) report(modes[i].name, self_fd >= 0 && modes[i].fn());
    }
    sys6(NR_EXIT, failed, 0, 0, 0, 0, 0);
    return 0;
}
