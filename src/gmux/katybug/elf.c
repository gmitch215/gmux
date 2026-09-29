#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

#include "kb.h"

#define STACK_TOP 0x7ffffff00000ull
#define STACK_SIZE (8ull << 20)
#define PIE_BASE 0x555555554000ull
#define LD_BASE 0x7ffff0000000ull /* the dynamic loader, below the stack */

struct ehdr {
    uint8_t ident[16];
    uint16_t type, machine;
    uint32_t version;
    uint64_t entry, phoff, shoff;
    uint32_t flags;
    uint16_t ehsize, phentsize, phnum, shentsize, shnum, shstrndx;
};

struct phdr {
    uint32_t type, flags;
    uint64_t offset, vaddr, paddr, filesz, memsz, align;
};

static uint64_t push_bytes(
    struct kb_cpu* cpu, uint64_t* sp, const void* p, size_t n
) {
    *sp -= n;
    kb_write(cpu, *sp, p, n);
    return *sp;
}

static void push_word(struct kb_cpu* cpu, uint64_t* sp, uint64_t v) {
    push_bytes(cpu, sp, &v, 8);
}

struct image {
    uint64_t base, entry, phdr, end;
    int phnum;
    char interp[4096]; /* PT_INTERP, empty when there is none */
};

static int phdr_at(FILE* f, const struct ehdr* eh, int i, struct phdr* ph) {
    return fseek(f, (long) (eh->phoff + (uint64_t) i * sizeof *ph), SEEK_SET) ||
           fread(ph, sizeof *ph, 1, f) != 1;
}

/* the file's [off, off + n) straight into the guest at va, a piece at a
 * time: no buffer, so nothing is as large as the file */
static int load_bytes(
    struct kb_cpu* cpu, FILE* f, uint64_t off, uint64_t va, uint64_t n
) {
    if (fseek(f, (long) off, SEEK_SET)) return -2;
    for (uint64_t done = 0, k; done < n; done += k) {
        uint8_t* p = kb_span(cpu, va + done, &k);
        if (!p) return -6;
        if (k > n - done) k = n - done;
        if (fread(p, 1, (size_t) k, f) != (size_t) k) return -2;
    }
    return 0;
}

/* maps an ELF image's PT_LOAD segments at base (ET_EXEC: at their own
 * addresses); 0 on success */
static int map_image(
    struct kb_cpu* cpu, FILE* f, uint64_t base, struct image* im
) {
    struct ehdr eh;
    if (fread(&eh, sizeof eh, 1, f) != 1 ||
        memcmp(eh.ident, "\177ELF\2\1", 6) != 0 ||
        eh.phentsize != sizeof(struct phdr))
        return -2;
    int arch = eh.machine == 62 ? KB_X86 : eh.machine == 183 ? KB_A64 : -1;
    if (arch < 0) return -3;
    cpu->arch = arch;
    if (eh.type != 3) base = 0;
    struct phdr ph;
    uint64_t lo = ~0ull, hi = 0, phdr_va = 0;
    im->interp[0] = 0;
    for (int i = 0; i < eh.phnum; i++) {
        if (phdr_at(f, &eh, i, &ph)) return -2;
        if (ph.type == 6) phdr_va = ph.vaddr; /* PT_PHDR */
        if (ph.type == 3) {                   /* PT_INTERP */
            if (!ph.filesz || ph.filesz > sizeof im->interp) return -2;
            if (fseek(f, (long) ph.offset, SEEK_SET) ||
                fread(im->interp, 1, (size_t) ph.filesz, f) != ph.filesz)
                return -2;
            im->interp[ph.filesz - 1] = 0;
        }
        if (ph.type != 1) continue;
        if (ph.vaddr < lo) lo = ph.vaddr;
        if (ph.vaddr + ph.memsz > hi) hi = ph.vaddr + ph.memsz;
        if (!phdr_va && eh.phoff >= ph.offset &&
            eh.phoff < ph.offset + ph.filesz)
            phdr_va = ph.vaddr + (eh.phoff - ph.offset);
    }
    if (lo > hi) return -5;
    lo &= ~0xfffull;
    /* one mapping for the whole image: segments may share pages */
    if (!kb_map(cpu, base + lo, hi - lo, 7)) return -6;
    for (int i = 0; i < eh.phnum; i++) {
        if (phdr_at(f, &eh, i, &ph)) return -2;
        if (ph.type != 1 || !ph.filesz) continue;
        int e = load_bytes(cpu, f, ph.offset, base + ph.vaddr, ph.filesz);
        if (e) return e;
    }
    im->base = base, im->entry = base + eh.entry, im->phdr = base + phdr_va;
    im->end = base + hi, im->phnum = eh.phnum;
    return 0;
}

/* opens path and maps it; 0 on success, -1 when it cannot be opened */
static int map_file(
    struct kb_cpu* cpu, const char* path, uint64_t base, struct image* im
) {
    FILE* f = fopen(path, "rb");
    if (!f) return -1;
    int e = map_image(cpu, f, base, im);
    fclose(f);
    return e;
}

/** loads an ELF, and the dynamic loader its PT_INTERP names, and builds the
 * initial stack; 0 on success */
int kb_load_elf(
    struct kb_cpu* cpu, const char* path, int argc, char** argv, char** envp
) {
    struct image im, ld = {0};
    int e = map_file(cpu, path, PIE_BASE, &im);
    if (e) return e;
    if (im.interp[0]) {
        int arch = cpu->arch;
        e = map_file(cpu, im.interp, LD_BASE, &ld);
        if (e || cpu->arch != arch) return e ? e : -3;
    }
    cpu->brk_start = cpu->brk_end = (im.end + 0xfffull) & ~0xfffull;
    cpu->mmap_next = 0x100000000000ull;

    if (!kb_map(cpu, STACK_TOP - STACK_SIZE, STACK_SIZE, 3)) return -6;
    if (cpu->arch == KB_A64) {
        if (!kb_map(cpu, KB_A64_SIGTRAMP, 4096, 5)) return -6;
        kb_store(cpu, KB_A64_SIGTRAMP, 0xd4000001d2801168ull, 8);
    }
    uint64_t sp = STACK_TOP;
    int envc = 0;
    while (envp && envp[envc]) envc++;
    uint64_t* av = calloc((size_t) argc + 1, 8);
    uint64_t* ev = calloc((size_t) envc + 1, 8);
    for (int i = argc - 1; i >= 0; i--)
        av[i] = push_bytes(cpu, &sp, argv[i], strlen(argv[i]) + 1);
    for (int i = envc - 1; i >= 0; i--)
        ev[i] = push_bytes(cpu, &sp, envp[i], strlen(envp[i]) + 1);
    uint8_t rnd[16];
    for (int i = 0; i < 16; i++) rnd[i] = (uint8_t) (rand() >> 7);
    uint64_t random = push_bytes(cpu, &sp, rnd, 16);
    const char* plat = cpu->arch == KB_X86 ? "x86_64" : "aarch64";
    uint64_t platform = push_bytes(cpu, &sp, plat, strlen(plat) + 1);
    sp &= ~15ull;
    /* AT_HWCAP on AArch64: fp and asimd */
    uint64_t aux[][2] = {
        {3, im.phdr},
        {4, sizeof(struct phdr)},
        {5, (uint64_t) im.phnum},
        {6, 4096},
        {7, ld.base},
        {9, im.entry},
        {11, (uint64_t) getuid()},
        {12, (uint64_t) geteuid()},
        {13, (uint64_t) getgid()},
        {14, (uint64_t) getegid()},
        {15, platform},
        {16, cpu->arch == KB_A64 ? 3 : 0},
        {23, 0},
        {25, random},
        {31, av[0]},
        {0, 0},
    };
    int nwords =
        1 + argc + 1 + envc + 1 + 2 * (int) (sizeof aux / sizeof aux[0]);
    if (nwords & 1) push_word(cpu, &sp, 0); /* keep argc 16-byte aligned */
    for (int i = (int) (sizeof aux / sizeof aux[0]) - 1; i >= 0; i--) {
        push_word(cpu, &sp, aux[i][1]);
        push_word(cpu, &sp, aux[i][0]);
    }
    push_word(cpu, &sp, 0);
    for (int i = envc - 1; i >= 0; i--) push_word(cpu, &sp, ev[i]);
    push_word(cpu, &sp, 0);
    for (int i = argc - 1; i >= 0; i--) push_word(cpu, &sp, av[i]);
    push_word(cpu, &sp, (uint64_t) argc);
    cpu->r[cpu->arch == KB_X86 ? 4 : 31] = sp;
    cpu->fcw = 0x037f; /* x87 at reset: extended precision, round to nearest,
                          all masked */
    cpu->mxcsr = 0x1f80;
    cpu->excl = ~0ull;
    cpu->pc = ld.entry ? ld.entry : im.entry;
    free(av);
    free(ev);
    return 0;
}
