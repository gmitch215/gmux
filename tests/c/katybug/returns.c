#include <stdint.h>

#if defined(__x86_64__)
    #define NR_WRITE 1
    #define NR_EXIT 60
static long sys3(long n, long a, long b, long c) {
    long r;
    __asm__ volatile("syscall"
                     : "=a"(r)
                     : "a"(n), "D"(a), "S"(b), "d"(c)
                     : "rcx", "r11", "memory");
    return r;
}
__asm__(".globl _start\n_start:\n xor %rbp, %rbp\n and $-16, %rsp\n call "
        "ret_main\n hlt\n");
/* redirect calls inner, which points its own return slot at other */
__asm__(".globl redirect\nredirect:\n call inner\n mov $1, %eax\n ret\n"
        "inner:\n lea other(%rip), %rax\n mov %rax, (%rsp)\n ret\n"
        "other:\n mov $2, %eax\n ret\n");
__asm__(".globl kb_setjmp\nkb_setjmp:\n mov (%rsp), %rax\n mov %rax, 56(%rdi)\n"
        " lea 8(%rsp), %rax\n mov %rax, (%rdi)\n mov %rbp, 8(%rdi)\n"
        " mov %rbx, 16(%rdi)\n mov %r12, 24(%rdi)\n mov %r13, 32(%rdi)\n"
        " mov %r14, 40(%rdi)\n mov %r15, 48(%rdi)\n xor %eax, %eax\n ret\n"
        ".globl kb_longjmp\nkb_longjmp:\n mov 8(%rdi), %rbp\n"
        " mov 16(%rdi), %rbx\n mov 24(%rdi), %r12\n mov 32(%rdi), %r13\n"
        " mov 40(%rdi), %r14\n mov 48(%rdi), %r15\n mov (%rdi), %rsp\n"
        " mov $1, %eax\n jmp *56(%rdi)\n");
#elif defined(__aarch64__)
    #define NR_WRITE 64
    #define NR_EXIT 93
static long sys3(long n, long a, long b, long c) {
    register long x0 __asm__("x0") = a;
    register long x1 __asm__("x1") = b;
    register long x2 __asm__("x2") = c;
    register long x8 __asm__("x8") = n;
    __asm__ volatile("svc 0" : "+r"(x0) : "r"(x1), "r"(x2), "r"(x8) : "memory");
    return x0;
}
__asm__(".globl _start\n_start:\n bl ret_main\n");
__asm__(".globl redirect\nredirect:\n stp x29, x30, [sp, #-16]!\n bl inner\n"
        " mov x0, #1\n ldp x29, x30, [sp], #16\n ret\n"
        "inner:\n adr x1, other\n mov x30, x1\n ret\n"
        "other:\n mov x0, #2\n ldp x29, x30, [sp], #16\n ret\n");
__asm__(".globl kb_setjmp\nkb_setjmp:\n stp x19, x20, [x0]\n"
        " stp x21, x22, [x0, #16]\n stp x23, x24, [x0, #32]\n"
        " stp x25, x26, [x0, #48]\n stp x27, x28, [x0, #64]\n"
        " stp x29, x30, [x0, #80]\n mov x2, sp\n str x2, [x0, #96]\n"
        " mov x0, #0\n ret\n"
        ".globl kb_longjmp\nkb_longjmp:\n ldp x19, x20, [x0]\n"
        " ldp x21, x22, [x0, #16]\n ldp x23, x24, [x0, #32]\n"
        " ldp x25, x26, [x0, #48]\n ldp x27, x28, [x0, #64]\n"
        " ldp x29, x30, [x0, #80]\n ldr x2, [x0, #96]\n mov sp, x2\n"
        " mov x0, #1\n ret\n");
#endif

long redirect(void);
__attribute__((returns_twice)) long kb_setjmp(void* buf);
__attribute__((noreturn)) void kb_longjmp(void* buf);

__attribute__((noinline)) static long fib(long n) {
    if (n < 2) return n;
    long a = fib(n - 1);
    __asm__ volatile("" : "+r"(a));
    return a + fib(n - 2);
}

static long jb[16];

__attribute__((noinline)) static long deep(long n) {
    if (!n) kb_longjmp(jb);
    long r = deep(n - 1);
    __asm__ volatile("" : "+r"(r));
    return r + 1;
}

/* the longjmp lands here, ten frames up */
__attribute__((noinline)) static long unwind(void) {
    if (kb_setjmp(jb) == 0) return deep(10);
    return -1;
}

static void put(const char* name, long v) {
    char buf[64];
    int n = 0, len = 0;
    while (name[len]) buf[n++] = name[len++];
    buf[n++] = ' ';
    char digits[24];
    int d = 0;
    unsigned long u = v < 0 ? 0ul - (unsigned long) v : (unsigned long) v;
    do digits[d++] = (char) ('0' + u % 10);
    while (u /= 10);
    if (v < 0) buf[n++] = '-';
    while (d) buf[n++] = digits[--d];
    buf[n++] = '\n';
    sys3(NR_WRITE, 1, (long) buf, n);
}

void ret_main(void) {
    put("fib", fib(20));
    long sum = 0;
    for (int i = 0; i < 100; i++) sum += redirect();
    put("redirect", sum);
    sum = 0;
    for (int i = 0; i < 50; i++) sum += unwind();
    put("unwind", sum);
    sys3(NR_EXIT, 0, 0, 0);
}
