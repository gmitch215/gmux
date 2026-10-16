#include <stdint.h>

#define NR_WRITE 1
#define NR_MMAP 9
#define NR_MPROTECT 10
#define NR_EXIT 60
#define MAP_FIXED_ANON 0x32
#define CODE 0x7e0000400000ul
#define OTHER 0x7e0000500000ul

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
__asm__(".globl _start\n_start:\n mov %rsp, %rdi\n and $-16, %rsp\n call "
        "main_\n hlt\n");

/* mov eax, imm32; ret, in a mapping that is written and executed */
static void put(int imm) {
    volatile unsigned char* p = (volatile unsigned char*) CODE;
    p[0] = 0xb8;
    p[1] = (unsigned char) imm;
    p[2] = p[3] = p[4] = 0;
    p[5] = 0xc3;
}

__attribute__((noinline)) static int work(int n) {
    int s = 0;
    for (int i = 0; i < n; i++) s += i % 7 ? i : -i;
    return s;
}

static void say(const char* s) {
    long n = 0;
    while (s[n]) n++;
    sys6(NR_WRITE, 1, (long) s, n, 0, 0, 0);
}

/* modes, run in this order against one KATYBUG_CACHE directory:
 *   a: run the code with 7, then rewrite it to 9 and never run it again
 *   b: write 9 first and run it: the blocks run 'a' saved hold 7 and must not
 * come back warm: the execute bit of another mapping changes in the middle, so
 * the blocks before it were decoded under an older code generation; the next
 * 'warm' run must decode none of them */
void main_(long* sp) {
    char* mode = ((char**) (sp + 1))[1];
    sys6(NR_MMAP, (long) CODE, 4096, 7, MAP_FIXED_ANON, -1, 0);
    sys6(NR_MMAP, (long) OTHER, 4096, 7, MAP_FIXED_ANON, -1, 0);
    int (*volatile call)(void) = (int (*)(void)) CODE;
    int got = 0;
    if (mode[0] == 'a') {
        put(7);
        got = call();
        put(9);
    }
    else if (mode[0] == 'b') {
        put(9);
        got = call();
    }
    else {
        got = work(10);
        sys6(NR_MPROTECT, (long) OTHER, 4096, 3, 0, 0, 0);
        sys6(NR_MPROTECT, (long) OTHER, 4096, 7, 0, 0, 0);
        got += work(20);
    }
    static char out[] = "x 00\n";
    out[0] = mode[0];
    out[2] = (char) ('0' + got / 10 % 10);
    out[3] = (char) ('0' + got % 10);
    say(out);
    sys6(NR_EXIT, 0, 0, 0, 0, 0, 0);
}
