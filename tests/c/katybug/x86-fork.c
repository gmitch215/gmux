#include <stdint.h>

#define NR_WRITE 1
#define NR_MMAP 9
#define NR_FORK 57
#define NR_EXIT 60
#define NR_WAIT4 61
#define MAP_FIXED_ANON 0x32
#define CODE 0x7e0000400000ul

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

/* code the parent never runs: only a child's blocks cover it */
__attribute__((noinline)) static int child_only(int n) {
    int s = 0;
    for (int i = 0; i < n; i++) s += i % 5 ? i : -i;
    return s;
}

__attribute__((noinline)) static int both(int n) {
    int s = 1;
    for (int i = 0; i < n; i++) s = s * 3 + i;
    return s & 0x7f;
}

static void say(char who, int v) {
    char out[] = "x 000\n";
    out[0] = who;
    out[2] = (char) ('0' + v / 100 % 10);
    out[3] = (char) ('0' + v / 10 % 10);
    out[4] = (char) ('0' + v % 10);
    sys6(NR_WRITE, 1, (long) out, 6, 0, 0, 0);
}

/* the parent runs the code at CODE, forks twice (the second child starts with
 * the blocks the first one ran), and each child and the parent run it again;
 * every line is the value the process itself must see. Mode s rewrites the
 * code between the parent's run and the fork, so a child runs the new bytes,
 * rewrites it again, and the parent keeps its own. Mode x does not rewrite
 * before the fork: a child runs what the parent decoded, then rewrites it and
 * runs the new bytes. Mode y rewrites it in the child before the child runs it
 * at all. Mode c runs a function only the child runs, then one both ran, maps
 * a page and runs that one again */
void main_(long* sp) {
    char* mode = ((char**) (sp + 1))[1];
    if (!mode) mode = "c";
    sys6(NR_MMAP, (long) CODE, 4096, 7, MAP_FIXED_ANON, -1, 0);
    int (*volatile call)(void) = (int (*)(void)) CODE;
    int pv = 0, status = 0;
    if (mode[0] != 'c') {
        put(7);
        pv = call();
        if (mode[0] == 's') put(9);
    }
    else {
        pv = both(20);
        /* code written under another page's block moves the generation */
        put(7);
        (void) call();
        put(9);
        sys6(NR_MMAP, (long) CODE + 0x10000, 4096, 3, MAP_FIXED_ANON, -1, 0);
        pv = both(20);
    }
    for (int turn = 0; turn < 2; turn++) {
        long pid = sys6(NR_FORK, 0, 0, 0, 0, 0, 0);
        if (pid == 0) {
            if (mode[0] == 'c') {
                say('c', child_only(30) & 0x7f);
                say('d', both(20));
                sys6(
                    NR_MMAP, (long) CODE + 0x20000, 4096, 3, MAP_FIXED_ANON, -1,
                    0
                );
                say('e', both(20));
            }
            else if (mode[0] == 'y') {
                put(5);
                say('c', call());
                put(6);
                say('d', call());
            }
            else {
                say('c', call());
                put(5);
                say('d', call());
            }
            sys6(NR_EXIT, 0, 0, 0, 0, 0, 0);
        }
        sys6(NR_WAIT4, pid, (long) &status, 0, 0, 0, 0);
    }
    say('p', mode[0] == 'c' ? both(20) : call());
    say('q', pv);
    sys6(NR_EXIT, status != 0, 0, 0, 0, 0, 0);
}
