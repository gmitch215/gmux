#define _GNU_SOURCE
#include <fcntl.h>
#include <pthread.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/mman.h>
#include <sys/syscall.h>
#include <sys/wait.h>
#include <unistd.h>
#define CHECK(name, ok) printf("%s %s\n", (ok) ? "PASS" : "FAIL", name)
#define MAP_UNINIT 0x4000000
#define SIDE (1 << 18)
#define LAST "/tmp/zerodata.last"

/* 64 KiB of data every process starts with, and 256 KiB of bss */
static unsigned char init[1 << 16] = {[0 ...(1 << 16) - 1] = 0x5a};
static unsigned char zbss[1 << 18];

/* the word a dirty process leaves at an address: it depends on the address, so
 * a word that survives into another process cannot be a hit by chance */
static uint32_t pattern(uintptr_t at) {
    return 0xc3a5f00du ^ (uint32_t) (at * 0x9e3779b1u);
}

static int region(uintptr_t* lo, uintptr_t* hi) {
    char line[256];
    unsigned long a, b;
    FILE* f = fopen("/proc/self/maps", "r");
    while (f && fgets(line, sizeof line, f))
        if (sscanf(line, "%lx-%lx", &a, &b) == 2 && a <= (uintptr_t) zbss &&
            (uintptr_t) zbss < b) {
            fclose(f);
            *lo = a;
            *hi = b;
            return 0;
        }
    if (f) fclose(f);
    return -1;
}

static void* mapped(int flags) {
    void* p = mmap(
        NULL, SIDE, PROT_READ | PROT_WRITE, MAP_PRIVATE | MAP_ANONYMOUS | flags,
        -1, 0
    );
    return p == MAP_FAILED ? NULL : p;
}

/* fills the data mapping and a mapping of its own with the pattern and exits at
 * once; the words around the thread structure stay, since the kernel reads its
 * robust list at exit */
static int dirty(void) {
    uintptr_t lo, hi;
    uint32_t* side = mapped(0);
    if (region(&lo, &hi) || !side) return 1;
    FILE* f = fopen(LAST, "w");
    if (!f) return 1;
    fprintf(f, "%lu %lu\n", (unsigned long) lo, (unsigned long) hi);
    fclose(f);
    for (uintptr_t i = 0; i < SIDE / 4; i++)
        side[i] = pattern((uintptr_t) (side + i));
    uintptr_t self = (uintptr_t) pthread_self();
    for (uintptr_t a = lo; a < hi; a += 4)
        if (a + 4096 < self || a >= self + 4096)
            *(volatile uint32_t*) a = pattern(a);
    syscall(SYS_exit_group, 0);
    return 1;
}

static unsigned long stale(const uint32_t* from, unsigned long words) {
    unsigned long n = 0;
    for (unsigned long i = 0; i < words; i++)
        if (from[i] == pattern((uintptr_t) (from + i))) n++;
    return n;
}

/* the exit status says which of the five reads saw a byte of the dirty process
 * (bit 0 a stale word anywhere in the data mapping, 1 a nonzero bss byte, 2 a
 * data byte not as built, 3 and 4 the same in a mapping asked for with the
 * uninitialized flag and in a plain one), and bit 5 that the dirty process's
 * mapping was not this one */
static int read_back(void) {
    uintptr_t lo, hi;
    int bad = 0;
    unsigned long last_lo = 0, last_hi = 0;
    FILE* f = fopen(LAST, "r");
    if (f) {
        if (fscanf(f, "%lu %lu", &last_lo, &last_hi) != 2) last_lo = 0;
        fclose(f);
    }
    if (region(&lo, &hi)) return 255;
    if (stale((const uint32_t*) lo, (hi - lo) / 4)) bad |= 1;
    for (size_t i = 0; i < sizeof zbss; i++)
        if (zbss[i]) {
            bad |= 2;
            break;
        }
    for (size_t i = 0; i < sizeof init; i++)
        if (init[i] != 0x5a) {
            bad |= 4;
            break;
        }
    uint32_t* flagged = mapped(MAP_UNINIT);
    uint32_t* plain = mapped(0);
    if (!flagged || !plain) return 255;
    if (stale(flagged, SIDE / 4)) bad |= 8;
    if (stale(plain, SIDE / 4)) bad |= 16;
    if (last_lo != lo || last_hi != hi) bad |= 32;
    return bad;
}

static int spawn(const char* self, const char* mode) {
    int st;
    char* argv[] = {(char*) self, (char*) mode, NULL};
    char* env[] = {NULL};
    pid_t pid = vfork();
    if (pid == 0) {
        execve(self, argv, env);
        _exit(254);
    }
    waitpid(pid, &st, 0);
    return WIFEXITED(st) ? WEXITSTATUS(st) : 253;
}

int main(int argc, char** argv) {
    if (argc > 1 && !strcmp(argv[1], "dirty")) return dirty();
    if (argc > 1 && !strcmp(argv[1], "read")) return read_back();
    int cycles = argc > 1 ? atoi(argv[1]) : 40;
    int counts[6] = {0}, other = 0, failed = 0;
    for (int i = 0; i < cycles; i++) {
        if (spawn("/bin/zerodata", "dirty")) {
            failed++;
            continue;
        }
        int bad = spawn("/bin/zerodata", "read");
        if (bad > 63) other++;
        for (int b = 0; b < 6; b++)
            if (bad <= 63 && (bad & (1 << b))) counts[b]++;
    }
    printf(
        "%d cycles, %d failed to run, %d unreadable\n", cycles, failed, other
    );
    CHECK("the dirty process ran in every cycle", !failed && !other);
    CHECK("no stale word in the data mapping", !counts[0]);
    CHECK("the bss is zero", !counts[1]);
    CHECK("the data is as built", !counts[2]);
    CHECK("a mapping with the uninitialized flag is zeroed", !counts[3]);
    CHECK("a plain mapping is zeroed", !counts[4]);
    /* the pages come back to the next exec, or the cycles prove nothing */
    printf(
        "same data mapping as the dirty process in %d of %d cycles\n",
        cycles - counts[5], cycles
    );
    CHECK(
        "the next exec gets the dirty process's pages", counts[5] < cycles / 2
    );
    return 0;
}
