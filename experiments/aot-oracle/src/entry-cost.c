#define CALLS 10000000L

__asm__(".globl _start\n_start:\n xor %rbp, %rbp\n and $-16, %rsp\n call "
        "entry_main\n hlt\n");

/* the branch stops block fusion from absorbing the leaf */
__attribute__((noinline)) long leaf(long x) {
    if (x & 1) {
        __asm__ volatile("" : "+r"(x));
        return x * 3 + 1;
    }
    __asm__ volatile("" : "+r"(x));
    return (x >> 1) ^ 0x9e3779b9;
}

/* an indirect call leaves a region that does not hold the leaf */
static long (*volatile call_leaf)(long) = leaf;

__attribute__((noinline)) long entry_main(void) {
    long s = 0;
    for (long i = 0; i < CALLS; i++) s = call_leaf(s) + i;
    char buf[24];
    int n = 0;
    unsigned long v = (unsigned long) s;
    do buf[n++] = (char) ('0' + v % 10);
    while ((v /= 10) != 0);
    char out[25];
    for (int i = 0; i < n; i++) out[i] = buf[n - 1 - i];
    out[n] = '\n';
    long r;
    __asm__ volatile("syscall"
                     : "=a"(r)
                     : "a"(1L), "D"(1L), "S"(out), "d"((long) n + 1)
                     : "rcx", "r11", "memory");
    __asm__ volatile("syscall" : : "a"(60L), "D"(0L) : "rcx", "r11", "memory");
    __builtin_unreachable();
}
