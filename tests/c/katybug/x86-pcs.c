#include <stdint.h>

#define NR_WRITE 1
#define NR_MMAP 9
#define NR_MPROTECT 10
#define NR_SIGACTION 13
#define NR_EXIT 60
#define MAP_FIXED_ANON 0x32
#define SA_SIGINFO 4
#define SA_RESTORER 0x04000000
#define CODE 0x7e0000600000ul

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
        "main_\n hlt\n"
        ".globl restore_rt\nrestore_rt:\n mov $15, %eax\n syscall\n");
void restore_rt(void);

struct ksigaction {
    void (*handler)(int, void*, void*);
    unsigned long flags;
    void (*restorer)(void);
    unsigned long mask;
};

static volatile long seen[8];
static volatile int nseen;

/* the fault's pc, then on to the ret */
static void on_segv(int sig, void* info, void* uc) {
    (void) sig;
    (void) info;
    long* gregs = (long*) ((char*) uc + 40);
    seen[nseen++] = gregs[16] - (long) CODE;
    gregs[16] = (long) CODE + 5;
}

/* the same load, a two byte nop either side of it: one IR, one end, and two
 * different instruction boundaries */
static const unsigned char code_a[6] = {0x66, 0x90, 0x48, 0x8b, 0x03, 0xc3};
static const unsigned char code_b[6] = {0x48, 0x8b, 0x03, 0x66, 0x90, 0xc3};

static void put(const unsigned char* c) {
    sys6(NR_MPROTECT, (long) CODE, 4096, 3, 0, 0, 0);
    for (int i = 0; i < 6; i++) ((volatile unsigned char*) CODE)[i] = c[i];
    sys6(NR_MPROTECT, (long) CODE, 4096, 5, 0, 0, 0);
}

/* rbx is 0, so the load at CODE faults */
static void run(void) {
    __asm__ volatile("xor %%ebx, %%ebx\n call *%0"
                     :
                     : "r"(CODE)
                     : "rax", "rbx", "rcx", "rdx", "rsi", "rdi", "r8", "r9",
                       "r10", "r11", "memory", "cc");
}

void main_(void) {
    sys6(NR_MMAP, (long) CODE, 4096, 3, MAP_FIXED_ANON, -1, 0);
    struct ksigaction sa = {on_segv, SA_SIGINFO | SA_RESTORER, restore_rt, 0};
    sys6(NR_SIGACTION, 11, (long) &sa, 0, 8, 0, 0);
    for (int pass = 0; pass < 2; pass++) {
        put(code_a);
        run();
        put(code_b);
        run();
    }
    char out[] = "pcs 0 0 0 0\n";
    for (int i = 0; i < 4; i++) out[4 + 2 * i] = (char) ('0' + seen[i]);
    sys6(NR_WRITE, 1, (long) out, sizeof out - 1, 0, 0, 0);
    sys6(NR_EXIT, 0, 0, 0, 0, 0, 0);
}
