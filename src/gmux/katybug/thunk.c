#include <string.h>

#include "kb.h"

/*
 * Library calls found by name. A loaded ELF object imports strlen, memcmp,
 * strcmp, memchr, memcpy, memmove, memset, exp, log and pow (and zlib's
 * entries) through relocated slots (JUMP_SLOT, GLOB_DAT); once
 * the loader has bound a slot, its value is the entry of the implementation the
 * guest's libc chose (musl's function, or the variant glibc's ifunc picked). A
 * block that starts there is that call. The objects are found by their ELF
 * headers at mapping starts, so no state has to cross fork.c's exec
 */

#define MAX_OBJS 32
#define MAX_SLOTS 40

static const struct {
    const char* name;
    int id;
} wanted[] = {
    {"strlen", KB_THUNK_STRLEN},
    {"memcmp", KB_THUNK_MEMCMP},
    {"strcmp", KB_THUNK_STRCMP},
    {"memchr", KB_THUNK_MEMCHR},
    {"memcpy", KB_THUNK_MEMCPY},
    {"memmove", KB_THUNK_MEMMOVE},
    {"memset", KB_THUNK_MEMSET},
    {"exp", KB_THUNK_EXP},
    {"log", KB_THUNK_LOG},
    {"pow", KB_THUNK_POW},
#ifdef KB_ZLIB
    {"crc32", KB_THUNK_CRC32},
    {"adler32", KB_THUNK_ADLER32},
    {"compress2", KB_THUNK_COMPRESS2},
    {"uncompress", KB_THUNK_UNCOMPRESS},
#endif
};

static struct obj {
    uint64_t base, lo, hi;
    uint8_t hdr[64];
    int seen, n;
    struct {
        uint64_t va;
        int id;
    } slot[MAX_SLOTS];
} objs[MAX_OBJS];
static int nobjs;
static uint32_t gen = ~0u;

static uint64_t rd(const uint8_t* p, int w) {
    uint64_t v = 0;
    memcpy(&v, p, (size_t) w);
    return v;
}

static int id_of(
    struct kb_cpu* cpu, uint64_t strtab, uint64_t symtab, uint64_t idx
) {
    uint8_t sym[24];
    char name[16];
    if (!kb_read(cpu, symtab + idx * 24, sym, 24)) return 0;
    uint64_t off = rd(sym, 4);
    if (!kb_read(cpu, strtab + off, name, sizeof name)) return 0;
    for (size_t i = 0; i < sizeof wanted / sizeof *wanted; i++)
        if (!strncmp(name, wanted[i].name, sizeof name)) return wanted[i].id;
    return 0;
}

static void relocs(
    struct kb_cpu* cpu, struct obj* o, uint64_t at, uint64_t size,
    uint64_t strtab, uint64_t symtab
) {
    int x86 = cpu->arch == KB_X86;
    for (uint64_t k = 0; k + 24 <= size && o->n < MAX_SLOTS; k += 24) {
        uint8_t r[24];
        if (!kb_read(cpu, at + k, r, 24)) return;
        uint64_t info = rd(r + 8, 8);
        uint32_t type = (uint32_t) info;
        /* GLOB_DAT and JUMP_SLOT; a plain 64-bit one (a function pointer in
         * data) only when it has no addend */
        int plain = x86 ? type == 1 : type == 257;
        if (x86 ? type != 6 && type != 7 && !plain
                : type != 1025 && type != 1026 && !plain)
            continue;
        if (plain && rd(r + 16, 8)) continue;
        int id = id_of(cpu, strtab, symtab, info >> 32);
        if (!id) continue;
        o->slot[o->n].va = o->base + rd(r, 8), o->slot[o->n++].id = id;
    }
}

/* o's slots from its dynamic section (o->base and the header are set); 0 when
 * the section is not all mapped yet, to try again at the next change */
static int parse(
    struct kb_cpu* cpu, struct obj* o, uint64_t dyn, uint64_t dsz
) {
    uint64_t strtab = 0, symtab = 0, jmprel = 0, jsz = 0, rela = 0, rsz = 0;
    for (uint64_t k = 0; k < dsz && k < 4096; k += 16) {
        uint8_t d[16];
        if (!kb_read(cpu, o->base + dyn + k, d, 16)) return 0;
        uint64_t tag = rd(d, 8), v = rd(d + 8, 8);
        if (!tag) break;
        /* glibc relocates these in place; musl leaves them as offsets */
        uint64_t p = v >= o->base ? v : o->base + v;
        switch (tag) {
            case 5: strtab = p; break;
            case 6: symtab = p; break;
            case 23: jmprel = p; break;
            case 2: jsz = v; break;
            case 7: rela = p; break;
            case 8: rsz = v; break;
        }
    }
    if (!strtab || !symtab) return 0;
    if (jmprel) relocs(cpu, o, jmprel, jsz, strtab, symtab);
    if (rela) relocs(cpu, o, rela, rsz, strtab, symtab);
    return 1;
}

/* the object whose ELF header is at the start of m, parsed when new */
static void probe(struct kb_cpu* cpu, struct kb_mapping* m) {
    uint8_t h[64], ph[56];
    if (m->end - m->start < 4096 || !m->pieces[0]) return;
    if (!kb_read(cpu, m->start, h, 64) || memcmp(h, "\177ELF\2\1", 6)) return;
    uint64_t type = rd(h + 16, 2), mach = rd(h + 18, 2);
    if ((type != 2 && type != 3) || mach != (cpu->arch == KB_X86 ? 62u : 183u))
        return;
    for (int i = 0; i < nobjs; i++)
        if (objs[i].base == (type == 2 ? 0 : m->start) &&
            !memcmp(objs[i].hdr, h, 64)) {
            objs[i].seen = 1;
            return;
        }
    if (nobjs == MAX_OBJS) return;
    uint64_t phoff = rd(h + 32, 8), phnum = rd(h + 56, 2);
    if (rd(h + 54, 2) != 56 || phnum > 64) return;
    struct obj* o = &objs[nobjs];
    memset(o, 0, sizeof *o);
    memcpy(o->hdr, h, 64);
    o->base = type == 2 ? 0 : m->start;
    uint64_t dyn = 0, dsz = 0, lo = ~0ull, hi = 0;
    for (uint64_t i = 0; i < phnum; i++) {
        if (!kb_read(cpu, m->start + phoff + i * 56, ph, 56)) return;
        uint32_t pt = (uint32_t) rd(ph, 4);
        uint64_t va = rd(ph + 16, 8), msz = rd(ph + 40, 8);
        if (pt == 2) dyn = va, dsz = rd(ph + 32, 8);
        if (pt == 1) {
            if (va < lo) lo = va;
            if (va + msz > hi) hi = va + msz;
        }
    }
    if (!dyn || lo > hi || (type == 3 && (lo & ~0xfffull))) return;
    o->lo = o->base + lo, o->hi = o->base + hi;
    if (!parse(cpu, o, dyn, dsz)) return;
    o->seen = 1;
    nobjs++;
}

static void rescan(struct kb_cpu* cpu) {
    gen = cpu->mapgen;
    for (int i = 0; i < nobjs; i++) objs[i].seen = 0;
    for (int i = 0; i < cpu->nmaps; i++) probe(cpu, &cpu->maps[i]);
    int keep = 0;
    for (int i = 0; i < nobjs; i++)
        if (objs[i].seen) objs[keep++] = objs[i];
    nobjs = keep;
}

/** the thunk id (KB_THUNK_*) whose implementation starts at pc, or 0 */
int kb_thunk_at(struct kb_cpu* cpu, uint64_t pc) {
    if (cpu->arch != KB_X86 && cpu->arch != KB_A64) return 0;
    if (gen != cpu->mapgen) rescan(cpu);
    for (int i = 0; i < nobjs; i++) {
        if (pc >= objs[i].lo && pc < objs[i].hi) continue;
        for (int k = 0; k < objs[i].n; k++) {
            uint8_t b[8];
            if (kb_read(cpu, objs[i].slot[k].va, b, 8) && rd(b, 8) == pc)
                return objs[i].slot[k].id;
        }
    }
    return 0;
}
