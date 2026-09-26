#include <stdlib.h>
#include <string.h>

#include "kb.h"

#define PAGE 4096ull

static int last = -1;

/* the newest mapping holding va: a MAP_FIXED mapping or a hole covers what is
 * under it */
static struct kb_mapping* find(struct kb_cpu* cpu, uint64_t va) {
    if (last >= 0 && last < cpu->nmaps && va >= cpu->maps[last].start &&
        va < cpu->maps[last].end)
        return &cpu->maps[last];
    for (int i = cpu->nmaps - 1; i >= 0; i--) {
        if (va >= cpu->maps[i].start && va < cpu->maps[i].end) {
            /* only a mapping nothing newer overlaps may be cached */
            int covered = 0;
            for (int j = i + 1; j < cpu->nmaps && !covered; j++)
                covered = cpu->maps[j].start < cpu->maps[i].end &&
                          cpu->maps[j].end > cpu->maps[i].start;
            if (!covered) last = i;
            return &cpu->maps[i];
        }
    }
    return NULL;
}

static void changed(struct kb_cpu* cpu) {
    last = -1;
    cpu->mapgen++;
}

/* kb_host, and when ic is given and the mapping has nothing newer over it, ic
 * keeps it */
static uint8_t* translate(
    struct kb_cpu* cpu, struct kb_ic* ic, uint64_t va, uint64_t len
) {
    struct kb_mapping* m = find(cpu, va);
    if (!m || !m->host || !m->prot || va + len > m->end || va + len < va)
        return NULL;
    if (ic && last >= 0 && m == &cpu->maps[last])
        *ic = (struct kb_ic){m->start, m->end - m->start, m->host, cpu->mapgen};
    return m->host + (va - m->start);
}

/** the host bytes behind [va, va + len), or NULL when they are not one
 * accessible mapping */
uint8_t* kb_host(struct kb_cpu* cpu, uint64_t va, uint64_t len) {
    return translate(cpu, NULL, va, len);
}

static struct kb_mapping* add(
    struct kb_cpu* cpu, uint64_t s, uint64_t e, uint8_t* host, int prot
) {
    if (cpu->nmaps == (int) (sizeof cpu->maps / sizeof cpu->maps[0]))
        return NULL;
    struct kb_mapping* m = &cpu->maps[cpu->nmaps++];
    *m = (struct kb_mapping){s, e, host, prot, 0};
    changed(cpu);
    return m;
}

struct kb_mapping* kb_map(
    struct kb_cpu* cpu, uint64_t start, uint64_t len, int prot
) {
    uint64_t s = start & ~(PAGE - 1);
    uint64_t e = (start + len + PAGE - 1) & ~(PAGE - 1);
    uint8_t* host = calloc(1, e - s);
    if (!host) return NULL;
    struct kb_mapping* m = add(cpu, s, e, host, prot);
    if (!m) free(host);
    return m;
}

/* an exact newest mapping goes away; what is left under the range is covered by
 * a hole */
int kb_unmap(struct kb_cpu* cpu, uint64_t start, uint64_t len) {
    uint64_t e = (start + len + PAGE - 1) & ~(PAGE - 1);
    int i = cpu->nmaps - 1;
    if (i >= 0 && cpu->maps[i].start == start && cpu->maps[i].end == e) {
        free(cpu->maps[i].host);
        cpu->nmaps--;
        changed(cpu);
    }
    for (int j = 0; j < cpu->nmaps; j++)
        if (cpu->maps[j].start < e && cpu->maps[j].end > start)
            return add(cpu, start, e, NULL, 0) ? 0 : -1;
    return 0;
}

/* mprotect: whole newest mappings change; a part of one is left as it is */
void kb_protect(struct kb_cpu* cpu, uint64_t start, uint64_t len, int prot) {
    uint64_t e = (start + len + PAGE - 1) & ~(PAGE - 1);
    for (int i = cpu->nmaps - 1; i >= 0; i--) {
        struct kb_mapping* m = &cpu->maps[i];
        if (m->start >= start && m->end <= e && m->host) m->prot = prot;
    }
    changed(cpu);
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
    uint8_t* p = translate(cpu, ic, va, (uint64_t) w);
    if (!p) {
        cpu->fault = "store outside the address space";
        cpu->fault_sig = 11;
        cpu->fault_addr = va;
        return;
    }
    memcpy(p, &v, (size_t) w);
}
