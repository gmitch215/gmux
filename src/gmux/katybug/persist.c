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

#define VERSION 4

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
    int *head, *next; /* records by pc: a bucket's first, the one after */
    uint32_t mask;
    uint8_t* blob; /* a fork's table: ins, pcs and seg point into it, and a
                      block takes copies */
    char path[4096];
};

static void record_of(const struct kb_block* b, struct record* r) {
    *r = (struct record){b->pc,          b->next,         b->target,
                         b->code,        (uint32_t) b->n, (uint32_t) b->nseg,
                         b->taken,       b->fall,         (uint32_t) b->traced,
                         b->pcs != NULL, b->flag_writes,  b->dropped,
                         b->pruned,      b->resolves,     0};
#ifdef KB_COUNT
    r->insns = b->insns;
#endif
}

static uint32_t bucket(const struct table* t, uint64_t pc) {
    return (uint32_t) (pc * 0x9e3779b97f4a7c15ull >> 32) & t->mask;
}

/* records are looked up by pc; with no index none are used */
static void index_records(struct table* t) {
    uint32_t n = 16;
    while (n < 2u * (uint32_t) t->count) n *= 2;
    t->head = malloc(n * sizeof *t->head);
    t->next = malloc((size_t) (t->count ? t->count : 1) * sizeof *t->next);
    if (!t->head || !t->next) {
        free(t->head);
        free(t->next);
        t->head = t->next = NULL;
        t->count = 0;
        return;
    }
    t->mask = n - 1;
    for (uint32_t i = 0; i < n; i++) t->head[i] = -1;
    for (int i = 0; i < t->count; i++) {
        uint32_t k = bucket(t, t->rec[i].pc);
        t->next[i] = t->head[k];
        t->head[k] = i;
    }
}

_Static_assert(__BYTE_ORDER__ == __ORDER_LITTLE_ENDIAN__, "word hash");

/* a stream hashed eight bytes a step: w holds the n pending bytes, so the
 * value does not depend on how the stream was cut into calls */
struct hash {
    uint64_t h, w;
    unsigned n;
};

static void mix(struct hash* s, uint64_t w) {
    s->h = (s->h ^ w) * 0x9e3779b97f4a7c15ull;
    s->h ^= s->h >> 32;
}

static void hash_add(struct hash* s, const uint8_t* p, uint64_t n) {
    for (; n && s->n; n--) {
        s->w |= (uint64_t) *p++ << 8 * s->n;
        if (++s->n == 8) mix(s, s->w), s->w = 0, s->n = 0;
    }
    for (; n >= 8; p += 8, n -= 8) {
        uint64_t w;
        memcpy(&w, p, 8);
        mix(s, w);
    }
    for (; n; n--) s->w |= (uint64_t) *p++ << 8 * s->n++;
}

static uint64_t hash_end(struct hash* s) {
    if (s->n) mix(s, s->w | (uint64_t) s->n << 56);
    return s->h;
}

static uint64_t file_hash(const char* path) {
    FILE* f = fopen(path, "rb");
    if (!f) return 0;
    uint8_t buf[65536];
    struct hash s = {0xcbf29ce484222325ull, 0, 0};
    size_t got;
    while ((got = fread(buf, 1, sizeof buf, f)) > 0) hash_add(&s, buf, got);
    fclose(f);
    return hash_end(&s);
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
    struct hash s = {0xcbf29ce484222325ull, 0, 0};
    *ok = b->nseg > 0;
    for (int i = 0; *ok && i < b->nseg; i++) {
        uint64_t lo = b->seg[2 * i], len = b->seg[2 * i + 1] - lo;
        if (!len) {
            *ok = 0;
            break;
        }
        hash_add(&s, (const uint8_t*) &lo, 8);
        for (uint64_t done = 0, k; *ok && done < len; done += k) {
            const uint8_t* p = kb_span_x(cpu, lo + done, &k);
            if (!p)
                *ok = 0;
            else {
                if (k > len - done) k = len - done;
                hash_add(&s, p, k);
            }
        }
    }
    return hash_end(&s);
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
    if (t->count) index_records(t);
}

/** b, holding only its pc, filled from a record whose code still matches; 0
 * when there is none, and b stays as it was */
int kb_persist_take(struct kb_cpu* cpu, struct kb_block* b) {
    struct table* t = cpu->persist;
    if (!t || !t->head) return 0;
    for (int i = t->head[bucket(t, b->pc)]; i >= 0; i = t->next[i]) {
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
        struct kb_ins* ins = t->ins[i];
        uint32_t* pcs = t->pcs[i];
        uint64_t* seg = t->seg[i];
        if (t->blob) {
            ins = malloc(sizeof *ins * (r->n ? r->n : 1));
            pcs = r->pcs ? malloc(sizeof *pcs * (r->n ? r->n : 1)) : NULL;
            seg = malloc(2 * sizeof *seg * r->nseg);
            if (!ins || !seg || (r->pcs && !pcs)) {
                free(ins);
                free(pcs);
                free(seg);
                return 0;
            }
            memcpy(ins, t->ins[i], sizeof *ins * r->n);
            if (pcs) memcpy(pcs, t->pcs[i], sizeof *pcs * r->n);
            memcpy(seg, t->seg[i], 2 * sizeof *seg * r->nseg);
        }
        b->next = r->next, b->target = r->target, b->n = (int) r->n;
        b->taken = r->taken, b->fall = r->fall, b->traced = (int) r->traced;
        b->flag_writes = r->flag_writes, b->dropped = r->dropped;
        b->pruned = r->pruned, b->resolves = r->resolves;
#ifdef KB_COUNT
        b->insns = r->insns;
#endif
        b->ins = ins, b->pcs = pcs, b->nseg = c.nseg, b->seg = seg;
        t->ins[i] = NULL, t->pcs[i] = NULL,
        t->seg[i] = NULL; /* the block owns them now */
        b->code = r->code, b->hashed = 1;
        b->codegen = cpu->codegen;
        if (kb_block_ready(cpu, b)) return 0;
        kb_marks_add(cpu, b);
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
            if (!b->n || !b->ins || !b->hashed) continue;
            struct record r;
            record_of(b, &r);
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

#define PACK_MAGIC 0x4b464b42u /* "BKFK" */
#define PACK_HEAD 16

static int pack_room(uint8_t** p, size_t* cap, size_t used, size_t more) {
    if (used + more <= *cap) return 1;
    size_t want = *cap ? *cap : 1u << 16;
    while (used + more > want) want *= 2;
    uint8_t* q = realloc(*p, want);
    if (!q) return 0;
    *p = q, *cap = want;
    return 1;
}

/** the blocks a fork's child may start with: every block that is current and
 * that want names (any, when it is NULL), with the hash of its guest bytes, in
 * one malloc'd buffer of *n bytes for kb_persist_adopt (NULL when there are
 * none). A block current under cpu->codegen holds the bytes it was decoded
 * from, so hashing them now gives the hash they had then */
uint8_t* kb_persist_pack(
    struct kb_cpu* cpu, size_t* n, int (*want)(uint64_t pc)
) {
    *n = 0;
    if (cpu->arch == KB_WASM || cpu->trace) return NULL;
    uint8_t* p = NULL;
    size_t cap = 0, used = PACK_HEAD;
    uint32_t count = 0;
    if (!pack_room(&p, &cap, 0, PACK_HEAD)) return NULL;
    for (int k = 0; k < 4096; k++)
        for (struct kb_block* b = cpu->cache[k]; b; b = b->chain) {
            if (b->codegen != cpu->codegen || !b->n || !b->ins) continue;
            if (want && !want(b->pc)) continue;
            if (!b->hashed) b->code = kb_code_hash(cpu, b, &b->hashed);
            if (!b->hashed) continue;
            size_t segb = 2 * sizeof(uint64_t) * (size_t) b->nseg;
            size_t insb = sizeof(struct kb_ins) * (size_t) b->n;
            size_t pcsb =
                b->pcs ? (sizeof(uint32_t) * (size_t) b->n + 7) & ~(size_t) 7
                       : 0;
            if (!pack_room(
                    &p, &cap, used, sizeof(struct record) + segb + insb + pcsb
                )) {
                free(p);
                return NULL;
            }
            struct record r;
            memset(&r, 0, sizeof r);
            record_of(b, &r);
            memcpy(p + used, &r, sizeof r);
            used += sizeof r;
            memcpy(p + used, b->seg, segb);
            used += segb;
            memcpy(p + used, b->ins, insb);
            used += insb;
            if (b->pcs) {
                memset(p + used, 0, pcsb);
                memcpy(p + used, b->pcs, sizeof(uint32_t) * (size_t) b->n);
                used += pcsb;
            }
            count++;
        }
    if (!count) {
        free(p);
        return NULL;
    }
    uint32_t magic = PACK_MAGIC;
    memset(p, 0, PACK_HEAD);
    memcpy(p, &magic, 4);
    memcpy(p + 4, &count, 4);
    *n = used;
    return p;
}

/** the child's table over the buffer kb_persist_pack made, which the table
 * keeps; blocks come out of it through kb_persist_take */
void kb_persist_adopt(struct kb_cpu* cpu, uint8_t* blob, size_t n) {
    cpu->persist = NULL;
    uint32_t magic, count;
    struct table* t = n >= PACK_HEAD ? calloc(1, sizeof *t) : NULL;
    if (!t) {
        free(blob);
        return;
    }
    memcpy(&magic, blob, 4);
    memcpy(&count, blob + 4, 4);
    if (magic != PACK_MAGIC || count > n / sizeof(struct record)) count = 0;
    t->rec = calloc(count ? count : 1, sizeof *t->rec);
    t->ins = calloc(count ? count : 1, sizeof *t->ins);
    t->pcs = calloc(count ? count : 1, sizeof *t->pcs);
    t->seg = calloc(count ? count : 1, sizeof *t->seg);
    size_t at = PACK_HEAD;
    for (uint32_t i = 0; t->rec && t->ins && t->pcs && t->seg && i < count;
         i++) {
        struct record* r = &t->rec[i];
        if (n - at < sizeof *r) break;
        memcpy(r, blob + at, sizeof *r);
        if (r->n == 0 || r->n > 1u << 16 || r->nseg > KB_SEGS) break;
        size_t segb = 2 * sizeof(uint64_t) * r->nseg;
        size_t insb = sizeof(struct kb_ins) * r->n;
        size_t pcsb = r->pcs ? (sizeof(uint32_t) * r->n + 7) & ~(size_t) 7 : 0;
        if (n - at - sizeof *r < segb + insb + pcsb) break;
        t->seg[i] = (uint64_t*) (blob + at + sizeof *r);
        t->ins[i] = (struct kb_ins*) (blob + at + sizeof *r + segb);
        t->pcs[i] =
            r->pcs ? (uint32_t*) (blob + at + sizeof *r + segb + insb) : NULL;
        at += sizeof *r + segb + insb + pcsb;
        t->count = (int) i + 1;
    }
    if (!t->count) {
        free(t->rec), free(t->ins), free(t->pcs), free(t->seg), free(t);
        free(blob);
        return;
    }
    t->blob = blob;
    index_records(t);
    if (!t->head) {
        free(t->rec), free(t->ins), free(t->pcs), free(t->seg), free(t);
        free(blob);
        return;
    }
    cpu->persist = t;
}
