#include <stdint.h>

#define NR_WRITE 1
#define NR_MMAP 9
#define NR_MPROTECT 10
#define NR_EXIT 60
#define MAP_FIXED_ANON 0x32
#define OTHER 0x7e0000200000ul

__attribute__((noinline)) static long sys6(
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
__asm__(".globl _start\n_start:\n xor %rbp, %rbp\n and $-16, %rsp\n call "
        "main_\n hlt\n");

/* region_fn(n) is n * imm. The add's immediate is rewritten between calls, and
 * the block that holds it (the loop) is reached only from the block before it,
 * so a lifted region runs it by a direct edge and never through the run loop */
int region_fn(int n);
extern char region_imm[];
__asm__(".text\n.globl region_fn\nregion_fn:\n"
        " xor %eax, %eax\n test %edi, %edi\n jz 2f\n"
        "1: .byte 0x05\n.globl region_imm\nregion_imm: .long 0\n"
        " dec %edi\n jnz 1b\n"
        "2: ret\n.size region_fn, . - region_fn\n");

void main_(void) {
    sys6(NR_MMAP, (long) OTHER, 4096, 7, MAP_FIXED_ANON, -1, 0);
    long got = 0, want = 0;
    int (*volatile call)(int) = region_fn; /* an indirect call is not fused */
    /* ten calls each with 7 and with 9; a pass changes the code generation
     * (the execute bit of another mapping goes off and on) */
    for (int pass = 0; pass < 60; pass++) {
        int imm = pass / 10 % 2 ? 9 : 7;
        *(volatile int*) region_imm = imm;
        sys6(NR_MPROTECT, (long) OTHER, 4096, pass % 2 ? 7 : 3, 0, 0, 0);
        got += call(100);
        want += 100L * imm;
    }
    static const char ok[] = "region-smc ok\n", bad[] = "region-smc FAIL\n";
    int good = got == want;
    sys6(
        NR_WRITE, 1, (long) (good ? ok : bad),
        good ? sizeof ok - 1 : sizeof bad - 1, 0, 0, 0
    );
    sys6(NR_EXIT, !good, 0, 0, 0, 0, 0);
}
