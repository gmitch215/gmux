#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

#include "kb.h"

#define STACK_TOP 0x7ffffff00000ull
#define STACK_SIZE (8ull << 20)
#define PIE_BASE 0x555555554000ull

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
    memcpy(kb_host(cpu, *sp, n), p, n);
    return *sp;
}

static void push_word(struct kb_cpu* cpu, uint64_t* sp, uint64_t v) {
    push_bytes(cpu, sp, &v, 8);
}

/** loads a static ELF and builds its initial stack; 0 on success */
int kb_load_elf(
    struct kb_cpu* cpu, const char* path, int argc, char** argv, char** envp
) {
    FILE* f = fopen(path, "rb");
    if (!f) return -1;
    fseek(f, 0, SEEK_END);
    long size = ftell(f);
    fseek(f, 0, SEEK_SET);
    uint8_t* file = malloc((size_t) size);
    if (!file || fread(file, 1, (size_t) size, f) != (size_t) size) {
        fclose(f);
        free(file);
        return -1;
    }
    fclose(f);
    struct ehdr* eh = (struct ehdr*) file;
    if (size < (long) sizeof *eh || memcmp(eh->ident, "\177ELF\2\1", 6) != 0)
        return -2;
    if (eh->machine == 62)
        cpu->arch = KB_X86;
    else if (eh->machine == 183)
        cpu->arch = KB_A64;
    else
        return -3;
    uint64_t base = eh->type == 3 ? PIE_BASE : 0;
    struct phdr* ph = (struct phdr*) (file + eh->phoff);
    uint64_t lo = ~0ull, hi = 0, phdr_va = 0;
    for (int i = 0; i < eh->phnum; i++) {
        if (ph[i].type == 3)
            return -4; /* PT_INTERP: dynamic executables are not supported yet
                        */
        if (ph[i].type != 1) continue;
        if (ph[i].vaddr < lo) lo = ph[i].vaddr;
        if (ph[i].vaddr + ph[i].memsz > hi) hi = ph[i].vaddr + ph[i].memsz;
        if (eh->phoff >= ph[i].offset &&
            eh->phoff < ph[i].offset + ph[i].filesz)
            phdr_va = ph[i].vaddr + (eh->phoff - ph[i].offset);
    }
    if (lo > hi) return -5;
    /* one mapping for the whole image: segments may share pages */
    if (!kb_map(cpu, base + lo, hi - lo, 7)) return -6;
    for (int i = 0; i < eh->phnum; i++) {
        if (ph[i].type != 1 || !ph[i].filesz) continue;
        memcpy(
            kb_host(cpu, base + ph[i].vaddr, ph[i].filesz), file + ph[i].offset,
            ph[i].filesz
        );
    }
    cpu->brk_start = cpu->brk_end = (base + hi + 0xfffull) & ~0xfffull;
    cpu->mmap_next = 0x100000000000ull;

    if (!kb_map(cpu, STACK_TOP - STACK_SIZE, STACK_SIZE, 3)) return -6;
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
    uint64_t aux[][2] = {
        {3, base + phdr_va},
        {4, sizeof(struct phdr)},
        {5, eh->phnum},
        {6, 4096},
        {7, 0},
        {9, base + eh->entry},
        {11, (uint64_t) getuid()},
        {12, (uint64_t) geteuid()},
        {13, (uint64_t) getgid()},
        {14, (uint64_t) getegid()},
        {15, platform},
        {16, 0},
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
    cpu->pc = base + eh->entry;
    free(av);
    free(ev);
    free(file);
    return 0;
}
