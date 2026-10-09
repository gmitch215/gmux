#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

#include "kb.h"

/*
 * Decoded blocks kept across processes. With KATYBUG_CACHE=<dir>, a process
 * reads <dir>/<hash of its ELF>.kbc at start and writes it at exit: every
 * block with its planned ops, profile and trace shape. A record goes back into
 * service only while the guest code under it hashes as it did when decoded (so
 * a library at another address, or other code at this one, decodes afresh),
 * and a file only when its provenance matches this process: katybug's own
 * executable (compiler, planner, IR), the op layout, the architecture and
 * every setting the plan depends on
 */

#define VERSION 2

struct header {
    char magic[4];
    uint32_t version;
    uint64_t self, elf;       /* hashes of katybug's executable and the ELF */
    uint32_t arch, ins, ops;  /* sizeof(struct kb_ins), KB_EXIT + 1 */
    uint32_t settings, count; /* the plan's settings; records that follow */
    uint64_t runs;            /* blocks the writer ran: the profile's weight */
};

struct record {
    uint64_t pc, next, target, code; /* code: the hash of the guest bytes */
    uint32_t n, nseg, taken, fall, traced, pcs;
    int flag_writes, dropped, pruned, resolves, insns;
};

struct table {
    struct header h;
    int count;
    struct record* rec;
    struct kb_ins** ins;
    uint32_t** pcs;
    uint64_t** seg;
    char path[4096];
};

static uint64_t fnv(const uint8_t* p, uint64_t n, uint64_t h) {
    for (uint64_t i = 0; i < n; i++) h = (h ^ p[i]) * 0x100000001b3ull;
    return h;
}

static uint64_t file_hash(const char* path) {
    FILE* f = fopen(path, "rb");
    if (!f) return 0;
    uint8_t buf[65536];
    uint64_t h = 0xcbf29ce484222325ull;
    size_t got;
    while ((got = fread(buf, 1, sizeof buf, f)) > 0) h = fnv(buf, got, h);
    fclose(f);
    return h;
}

static uint32_t settings(const struct kb_cpu* cpu) {
    return ((uint32_t) cpu->noplan | KB_FUSE << 1 | KB_CHAIN << 2 |
            KB_LAZY << 3 | (uint32_t) cpu->segments << 5 |
            (uint32_t) KB_POLL << 13) ^
           (uint32_t) (kb_prim_enabled() * 0x9e3779b97f4a7c15ull >> 32);
}

/** the guest bytes a block was decoded from, hashed; *ok is 0 when a range is
 * not one accessible mapping */
uint64_t kb_code_hash(struct kb_cpu* cpu, const struct kb_block* b, int* ok) {
    uint64_t h = 0xcbf29ce484222325ull;
    *ok = b->nseg > 0;
    for (int i = 0; *ok && i < b->nseg; i++) {
        uint64_t lo = b->seg[2 * i], len = b->seg[2 * i + 1] - lo;
        if (!len) {
            *ok = 0;
            break;
        }
        h = fnv((const uint8_t*) &lo, 8, h);
        for (uint64_t done = 0, k; *ok && done < len; done += k) {
            const uint8_t* p = kb_span(cpu, lo + done, &k);
            if (!p)
                *ok = 0;
            else {
                if (k > len - done) k = len - done;
                h = fnv(p, k, h);
            }
        }
    }
    return h;
}

static int take(void* p, size_t n, FILE* f) {
    return fread(p, 1, n, f) == n;
}

void kb_persist_load(struct kb_cpu* cpu, const char* elf) {
    const char* dir = getenv("KATYBUG_CACHE");
    if (!dir || cpu->arch == KB_WASM || cpu->trace) return;
    struct table* t = calloc(1, sizeof *t);
    if (!t) return;
    struct header want = {
        {'K', 'B', 'P', 'C'},
        VERSION,
        file_hash(kb_self),
        file_hash(elf),
        (uint32_t) cpu->arch,
        sizeof(struct kb_ins),
        KB_EXIT + 1,
        settings(cpu),
        0,
        0
    };
    snprintf(
        t->path, sizeof t->path, "%s/%016llx.kbc", dir,
        (unsigned long long) want.elf
    );
    t->h = want;
    cpu->persist = t;
    FILE* f = fopen(t->path, "rb");
    if (!f) return;
    struct header h;
    if (!take(&h, sizeof h, f) || memcmp(h.magic, want.magic, 4) ||
        h.version != want.version || h.self != want.self || h.elf != want.elf ||
        h.arch != want.arch || h.ins != want.ins || h.ops != want.ops ||
        h.settings != want.settings || h.count > 1u << 20) {
        fclose(f);
        return; /* another katybug or setting wrote it: rewritten at exit */
    }
    t->rec = calloc(h.count ? h.count : 1, sizeof *t->rec);
    t->ins = calloc(h.count ? h.count : 1, sizeof *t->ins);
    t->pcs = calloc(h.count ? h.count : 1, sizeof *t->pcs);
    t->seg = calloc(h.count ? h.count : 1, sizeof *t->seg);
    for (uint32_t i = 0; t->rec && t->ins && t->pcs && t->seg && i < h.count;
         i++) {
        struct record* r = &t->rec[i];
        if (!take(r, sizeof *r, f) || r->n > 1u << 16 || r->nseg > KB_SEGS)
            break;
        t->seg[i] = malloc(2 * sizeof(uint64_t) * r->nseg);
        t->ins[i] = malloc(sizeof(struct kb_ins) * (r->n ? r->n : 1));
        t->pcs[i] =
            r->pcs ? malloc(sizeof(uint32_t) * (r->n ? r->n : 1)) : NULL;
        if (!t->seg[i] || !t->ins[i] || (r->pcs && !t->pcs[i]) ||
            !take(t->seg[i], 2 * sizeof(uint64_t) * r->nseg, f) ||
            !take(t->ins[i], sizeof(struct kb_ins) * r->n, f) ||
            (r->pcs && !take(t->pcs[i], sizeof(uint32_t) * r->n, f)))
            break;
        t->count = (int) i + 1;
    }
    fclose(f);
}

/** b, holding only its pc, filled from a record whose code still matches; 0
 * when there is none, and b stays as it was */
int kb_persist_take(struct kb_cpu* cpu, struct kb_block* b) {
    struct table* t = cpu->persist;
    if (!t) return 0;
    /* ponytail: a linear scan per miss; a hash on pc when caches grow large */
    for (int i = 0; i < t->count; i++) {
        struct record* r = &t->rec[i];
        if (r->pc != b->pc || !t->ins[i]) continue;
        /* a string function's whole body decides its first op */
        int had =
            r->n && t->ins[i][0].op == KB_PRIM ? (int) t->ins[i][0].imm : 0;
        if (kb_prim_at(cpu, r->pc) != had) return 0;
        struct kb_block c = {
            .pc = r->pc, .nseg = (int) r->nseg, .seg = t->seg[i]
        };
        int ok;
        if (kb_code_hash(cpu, &c, &ok) != r->code || !ok) return 0;
        b->next = r->next, b->target = r->target, b->n = (int) r->n;
        b->taken = r->taken, b->fall = r->fall, b->traced = (int) r->traced;
        b->flag_writes = r->flag_writes, b->dropped = r->dropped;
        b->pruned = r->pruned, b->resolves = r->resolves;
#ifdef KB_COUNT
        b->insns = r->insns;
#endif
        b->ins = t->ins[i], b->pcs = t->pcs[i], b->nseg = c.nseg,
        b->seg = c.seg;
        t->ins[i] = NULL, t->pcs[i] = NULL,
        t->seg[i] = NULL; /* the block owns them now */
        b->codegen = cpu->codegen;
        if (kb_block_ready(cpu, b)) return 0;
        cpu->loaded++;
        return 1;
    }
    return 0;
}

/** every current block, with its profile, into the cache file (a new file
 * renamed over the old, so a reader never sees half of one) */
void kb_persist_save(struct kb_cpu* cpu) {
    struct table* t = cpu->persist;
    if (!t) return;
    char tmp[4200];
    snprintf(tmp, sizeof tmp, "%s.%ld", t->path, (long) getpid());
    FILE* f = fopen(tmp, "wb");
    if (!f) return;
    struct header h = t->h;
    h.runs = cpu->steps;
    fwrite(&h, sizeof h, 1, f);
    uint32_t count = 0;
    for (int k = 0; k < 4096; k++)
        for (struct kb_block* b = cpu->cache[k]; b; b = b->chain) {
            int ok;
            uint64_t code = b->n && b->codegen == cpu->codegen
                                ? kb_code_hash(cpu, b, &ok)
                                : 0;
            if (!b->n || b->codegen != cpu->codegen || !ok) continue;
            struct record r = {
                b->pc,          b->next,         b->target,
                code,           (uint32_t) b->n, (uint32_t) b->nseg,
                b->taken,       b->fall,         (uint32_t) b->traced,
                b->pcs != NULL, b->flag_writes,  b->dropped,
                b->pruned,      b->resolves,     0
            };
#ifdef KB_COUNT
            r.insns = b->insns;
#endif
            fwrite(&r, sizeof r, 1, f);
            fwrite(b->seg, 2 * sizeof(uint64_t), (size_t) b->nseg, f);
            fwrite(b->ins, sizeof(struct kb_ins), (size_t) b->n, f);
            if (b->pcs) fwrite(b->pcs, sizeof(uint32_t), (size_t) b->n, f);
            count++;
        }
    h.count = count;
    fseek(f, 0, SEEK_SET);
    fwrite(&h, sizeof h, 1, f);
    if (fclose(f) == 0) rename(tmp, t->path);
}
