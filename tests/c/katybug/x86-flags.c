#include <stdint.h>

static long sys3(long n, long a, long b, long c) {
    long r;
    __asm__ volatile("syscall"
                     : "=a"(r)
                     : "a"(n), "D"(a), "S"(b), "d"(c)
                     : "rcx", "r11", "memory");
    return r;
}

__asm__(".globl _start\n_start:\n xor %rbp, %rbp\n and $-16, %rsp\n call "
        "flags_main\n hlt\n");

/* the flags of setup are read after a jump through a register into a block with
 * cpuid, which no region holds, so a region leaves with them live */
#define CASE(name, setup, cmov)                                                \
    static long name(long a, long b) {                                         \
        long r = 0, one = 1;                                                   \
        __asm__ volatile("lea 1f(%%rip), %%r10\n" setup "\n jmp *%%r10\n1:\n"  \
                         " mov $0, %%eax\n cpuid\n " cmov " %[one], %[r]\n"    \
                         : [r] "+r"(r), [a] "+r"(a)                            \
                         : [b] "r"(b), [one] "r"(one)                          \
                         : "rax", "rbx", "rcx", "rdx", "r10", "cc");           \
        return r;                                                              \
    }

CASE(gt, "cmp %[b], %[a]", "cmovg")
CASE(below, "cmp %[b], %[a]", "cmovb")
CASE(overflow, "add %[b], %[a]", "cmovo")
CASE(carry, "add %[b], %[a]", "cmovc")
CASE(equal, "sub %[b], %[a]", "cmove")

static const long pairs[][2] = {
    {1, 2},  {2, 1},   {5, 5}, {-1, 1}, {0x7fffffffffffffff, 1},
    {0, -1}, {-2, -2}, {3, 7}, {-5, 4},
};

static void line(const char* name, long (*f)(long, long)) {
    char buf[32];
    int n = 0;
    while (name[n]) buf[n] = name[n], n++;
    buf[n++] = ' ';
    for (unsigned i = 0; i < sizeof pairs / sizeof pairs[0]; i++)
        buf[n++] = (char) ('0' + f(pairs[i][0], pairs[i][1]));
    buf[n++] = '\n';
    sys3(1, 1, (long) buf, n);
}

void flags_main(void) {
    line("gt", gt);
    line("below", below);
    line("overflow", overflow);
    line("carry", carry);
    line("equal", equal);
    sys3(60, 0, 0, 0);
}
