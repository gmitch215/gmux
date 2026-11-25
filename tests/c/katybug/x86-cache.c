#include <stdint.h>

#define NR_WRITE 1
#define NR_EXIT 60
#define CALLS 40
#define SIZE 16384

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

/* a byte loop whose head is a block of its own: the head runs once a call, the
 * body (with the jump back fused into it) once a byte */
__asm__(".globl crc_head\ncrc_head:\n cmp %rdx, %rsi\n je 2f\n"
        " movzbl (%rsi), %edi\n inc %rsi\n xor %eax, %edi\n shr $8, %eax\n"
        " movzbl %dil, %edi\n xor (%rcx,%rdi,4), %eax\n jmp crc_head\n"
        "2: ret\n");

void crc_head(void);

static uint32_t table[256];
static uint8_t buf[SIZE];

static uint32_t crc_asm(uint32_t c, const uint8_t* p, long n) {
    register const uint8_t* rsi __asm__("rsi") = p;
    register const uint8_t* rdx __asm__("rdx") = p + n;
    register const uint32_t* rcx __asm__("rcx") = table;
    void (*fn)(void) = crc_head;
    __asm__ volatile("call *%4"
                     : "+a"(c), "+r"(rsi), "+r"(rdx), "+r"(rcx)
                     : "r"(fn)
                     : "rdi", "r9", "r10", "r11", "memory", "cc");
    return c;
}

static uint32_t crc_c(uint32_t c, const uint8_t* p, long n) {
    for (long i = 0; i < n; i++) c = table[(c ^ p[i]) & 0xff] ^ (c >> 8);
    return c;
}

void main_(void) {
    for (uint32_t i = 0; i < 256; i++) {
        uint32_t c = i;
        for (int k = 0; k < 8; k++) c = c & 1 ? 0xedb88320u ^ c >> 1 : c >> 1;
        table[i] = c;
    }
    uint32_t s = 12345;
    for (int i = 0; i < SIZE; i++)
        buf[i] = (uint8_t) ((s = s * 1103515245u + 12345u) >> 16);
    uint32_t a = 0, b = 0;
    for (int i = 0; i < CALLS; i++) {
        a = crc_asm(a, buf, SIZE);
        b = crc_c(b, buf, SIZE);
    }
    sys6(
        NR_WRITE, 1, a == b ? (long) "cache ok\n" : (long) "cache bad\n",
        9 + (a != b), 0, 0, 0
    );
    sys6(NR_EXIT, 0, 0, 0, 0, 0, 0);
}
