#include <stdlib.h>
#include <string.h>

#include "kb.h"

#define PAGE 4096ull

static int last = -1;

/* the mapping holding va; mappings never overlap */
static struct kb_mapping* find(struct kb_cpu* cpu, uint64_t va) {
    if (last >= 0 && last < cpu->nmaps && va >= cpu->maps[last].start &&
        va < cpu->maps[last].end)
        return &cpu->maps[last];
    for (int i = 0; i < cpu->nmaps; i++)
        if (va >= cpu->maps[i].start && va < cpu->maps[i].end) {
            last = i;
            return &cpu->maps[i];
        }
    return NULL;
}

static void changed(struct kb_cpu* cpu) {
    last = -1;
    cpu->mapgen++;
}

/* kb_host, and when ic is given, ic keeps the mapping */
static uint8_t* translate(
    struct kb_cpu* cpu, struct kb_ic* ic, uint64_t va, uint64_t len
) {
    struct kb_mapping* m = find(cpu, va);
    if (!m || !m->prot || va + len > m->end || va + len < va) return NULL;
    if (ic)
        *ic = (struct kb_ic){m->start, m->end - m->start, m->host, cpu->mapgen};
    return m->host + (va - m->start);
}

/* a mapping across a becomes two at a, the upper part in its own block */
static int split(struct kb_cpu* cpu, uint64_t a) {
    struct kb_mapping* m = find(cpu, a);
    if (!m || m->start == a) return 0;
    if (cpu->nmaps == (int) (sizeof cpu->maps / sizeof cpu->maps[0])) return -1;
    uint8_t* up = malloc(m->end - a);
    if (!up) return -1;
    memcpy(up, m->host + (a - m->start), m->end - a);
    uint8_t* low = realloc(m->host, a - m->start);
    if (low) m->host = low;
    cpu->maps[cpu->nmaps++] = (struct kb_mapping){a, m->end, up, m->prot};
    m->end = a;
    changed(cpu);
    return 0;
}

/** the host bytes behind [va, va + len), or NULL when they are not one
 * accessible mapping */
uint8_t* kb_host(struct kb_cpu* cpu, uint64_t va, uint64_t len) {
    return translate(cpu, NULL, va, len);
}

/** kb_host for a KB_RESOLVE whose inline cache missed; it refills the cache */
uint8_t* kb_host_ic(
    struct kb_cpu* cpu, struct kb_ic* ic, uint64_t va, uint64_t len
) {
#ifdef KB_COUNT
    kb_count.refills++;
#endif
    return translate(cpu, ic, va, len);
}

static struct kb_mapping* add(
    struct kb_cpu* cpu, uint64_t s, uint64_t e, uint8_t* host, int prot
) {
    if (cpu->nmaps == (int) (sizeof cpu->maps / sizeof cpu->maps[0]))
        return NULL;
    struct kb_mapping* m = &cpu->maps[cpu->nmaps++];
    *m = (struct kb_mapping){s, e, host, prot};
    changed(cpu);
    return m;
}

/** a new mapping over [start, start + len), zeroed; what was there goes, as
 * MAP_FIXED does */
struct kb_mapping* kb_map(
    struct kb_cpu* cpu, uint64_t start, uint64_t len, int prot
) {
    uint64_t s = start & ~(PAGE - 1);
    uint64_t e = (start + len + PAGE - 1) & ~(PAGE - 1);
    if (kb_unmap(cpu, s, e - s)) return NULL;
    uint8_t* host = calloc(1, e - s);
    if (!host) return NULL;
    struct kb_mapping* m = add(cpu, s, e, host, prot);
    if (!m) free(host);
    return m;
}

/** the lowest address from at up where len bytes touch no mapping */
uint64_t kb_free_at(struct kb_cpu* cpu, uint64_t at, uint64_t len) {
    for (int i = 0; i < cpu->nmaps; i++)
        if (cpu->maps[i].start < at + len && cpu->maps[i].end > at) {
            at = cpu->maps[i].end + PAGE;
            i = -1;
        }
    return at;
}

/** munmap: the pages of [start, start + len) go, splitting mappings across its
 * ends */
int kb_unmap(struct kb_cpu* cpu, uint64_t start, uint64_t len) {
    uint64_t e = (start + len + PAGE - 1) & ~(PAGE - 1);
    if (split(cpu, start) || split(cpu, e)) return -1;
    for (int i = 0; i < cpu->nmaps; i++) {
        struct kb_mapping* m = &cpu->maps[i];
        if (m->start >= start && m->end <= e) {
            if (m->prot & 4) cpu->codegen++; /* blocks decoded from it go */
            free(m->host);
            *m = cpu->maps[--cpu->nmaps];
            i--;
        }
    }
    changed(cpu);
    return 0;
}

/** mprotect, splitting mappings across the range's ends */
int kb_protect(struct kb_cpu* cpu, uint64_t start, uint64_t len, int prot) {
    uint64_t e = (start + len + PAGE - 1) & ~(PAGE - 1);
    if (split(cpu, start) || split(cpu, e)) return -1;
    for (int i = 0; i < cpu->nmaps; i++) {
        struct kb_mapping* m = &cpu->maps[i];
        if (m->start >= start && m->end <= e) {
            if ((m->prot ^ prot) & 4) cpu->codegen++;
            m->prot = prot;
        }
    }
    changed(cpu);
    return 0;
}

uint64_t kb_load(struct kb_cpu* cpu, uint64_t va, int w) {
    return kb_load_ic(cpu, NULL, va, w);
}

void kb_store(struct kb_cpu* cpu, uint64_t va, uint64_t v, int w) {
    kb_store_ic(cpu, NULL, va, v, w);
}

/* the slow path of a load or store whose inline cache missed; run.c holds the
 * fast one */
uint64_t kb_load_ic(struct kb_cpu* cpu, struct kb_ic* ic, uint64_t va, int w) {
#ifdef KB_COUNT
    kb_count.refills += ic != NULL;
#endif
    uint8_t* p = translate(cpu, ic, va, (uint64_t) w);
    if (!p) {
        cpu->fault = "load outside the address space";
        cpu->fault_sig = 11;
        cpu->fault_addr = va;
        return 0;
    }
    uint64_t v = 0;
    memcpy(&v, p, (size_t) w); /* hosts are little-endian, as both guests are */
    return v;
}

void kb_store_ic(
    struct kb_cpu* cpu, struct kb_ic* ic, uint64_t va, uint64_t v, int w
) {
#ifdef KB_COUNT
    kb_count.refills += ic != NULL;
#endif
    uint8_t* p = translate(cpu, ic, va, (uint64_t) w);
    if (!p) {
        cpu->fault = "store outside the address space";
        cpu->fault_sig = 11;
        cpu->fault_addr = va;
        return;
    }
    memcpy(p, &v, (size_t) w);
}
