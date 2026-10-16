#ifndef AOT_H
#define AOT_H

#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "kb.h"
#include "wide.h"

/* the interpreter's flags, conditions and x86 mul/div (src/gmux/katybug/run.c)
   over locals instead of the cpu, so lifted code keeps them in registers; keep
   in step with run.c. Always inlined: the kind is a constant only after
   inlining, and a call spills the flags to memory (measured: 13-17% of the
   lifted runs when clang declined) */

struct aot_fl {
    int n, z, c, v, p;
};

static inline uint64_t aot_mask(int w) {
    return w >= 8 ? ~0ull : (1ull << (8 * w)) - 1;
}

static inline int64_t aot_sext(uint64_t v, int w) {
    int s = 64 - 8 * w;
    return w >= 8 ? (int64_t) v : (int64_t) (v << s) >> s;
}

static inline int aot_parity(uint64_t v) {
    v &= 0xff;
    v ^= v >> 4;
    v ^= v >> 2;
    v ^= v >> 1;
    return !(v & 1);
}

static inline __attribute__((always_inline)) void aot_flags(
    struct aot_fl* f, int kind, uint64_t a, uint64_t b, uint64_t r, int w
) {
    uint64_t m = aot_mask(w), sign = 1ull << (8 * w - 1);
    if ((kind == KB_F_SHL || kind == KB_F_SHR || kind == KB_F_SAR ||
         kind == KB_F_ROL || kind == KB_F_ROR) &&
        b == 0)
        return;
    switch (kind) {
        case KB_F_MULOV: f->c = f->v = b != 0; return;
        case KB_F_SETC: f->c = (int) (b & 1); return;
        case KB_F_ZERO: f->z = (b & m) == 0; return;
        case KB_F_CNT:
            f->c = (b & m) == 0;
            f->z = (r & m) == 0;
            return;
        case KB_F_ROL:
            f->c = (int) (r & 1);
            f->v = !!(r & sign) ^ f->c;
            return;
        case KB_F_ROR:
            f->c = !!(r & sign);
            f->v = !!(r & sign) ^ !!(r & (sign >> 1));
            return;
    }
    a &= m;
    b &= m;
    r &= m;
    f->z = r == 0;
    f->n = !!(r & sign);
    f->p = aot_parity(r);
    switch (kind) {
        case KB_F_ADD:
        case KB_F_A_ADD:
            f->c = r < a;
            f->v = !!(~(a ^ b) & (a ^ r) & sign);
            break;
        case KB_F_ADC: {
            uint64_t cin = (uint64_t) f->c;
            f->c = w < 8 ? a + b + cin > m : (cin ? r <= a : r < a);
            f->v = !!(~(a ^ b) & (a ^ r) & sign);
            break;
        }
        case KB_F_SUB:
            f->c = a < b;
            f->v = !!((a ^ b) & (a ^ r) & sign);
            break;
        case KB_F_SBB: {
            uint64_t cin = (uint64_t) f->c;
            f->c = w < 8 ? a < b + cin : (a < b || (cin && a == b));
            f->v = !!((a ^ b) & (a ^ r) & sign);
            break;
        }
        case KB_F_A_SUB:
            f->c = a >= b;
            f->v = !!((a ^ b) & (a ^ r) & sign);
            break;
        case KB_F_LOGIC:
        case KB_F_A_LOGIC:
            f->c = 0;
            f->v = 0;
            break;
        case KB_F_INC: f->v = r == sign; break;
        case KB_F_DEC: f->v = r == sign - 1; break;
        case KB_F_NEG:
            f->c = b != 0;
            f->v = b == sign;
            break;
        case KB_F_SHL:
            f->c = b <= 8u * (unsigned) w ? !!((a << (b - 1)) & sign) : 0;
            f->v = f->n ^ f->c;
            break;
        case KB_F_SHR:
            f->c = !!((a >> (b - 1)) & 1);
            f->v = !!(a & sign);
            break;
        case KB_F_SAR:
            f->c = !!(((uint64_t) aot_sext(a, w) >> (b - 1)) & 1);
            f->v = 0;
            break;
        case KB_F_NZCV:
            f->n = !!(b & (1u << 31));
            f->z = !!(b & (1u << 30));
            f->c = !!(b & (1u << 29));
            f->v = !!(b & (1u << 28));
            break;
    }
}

static inline __attribute__((always_inline)) int aot_cond(
    const struct aot_fl* f, int cond
) {
    int n = f->n, z = f->z, c = f->c, v = f->v;
    if (cond < KB_C_A64) {
        int r;
        switch (cond >> 1) {
            case 0: r = v; break;
            case 1: r = c; break;
            case 2: r = z; break;
            case 3: r = c || z; break;
            case 4: r = n; break;
            case 5: r = f->p; break;
            case 6: r = n != v; break;
            default: r = z || n != v; break;
        }
        return (cond & 1) ? !r : r;
    }
    int k = cond - KB_C_A64, r;
    if (k >= 14) return 1;
    switch (k >> 1) {
        case 0: r = z; break;
        case 1: r = c; break;
        case 2: r = n; break;
        case 3: r = v; break;
        case 4: r = c && !z; break;
        case 5: r = n == v; break;
        default: r = !z && n == v; break;
    }
    return (k & 1) ? !r : r;
}

/* x86 mul, imul, div and idiv of rdx:rax by v; 1 on a divide error, leaving
 * both untouched */
static inline __attribute__((always_inline)) int aot_muldiv(
    uint64_t* rax, uint64_t* rdx, struct aot_fl* f, int kind, int w, uint64_t v
) {
    if (kind == 4 || kind == 5) {
        f->c = f->v = kb_mul(kind == 5, w, rax, rdx, v);
        return 0;
    }
    return kb_divide(kind == 7, w, rax, rdx, v);
}

/* lift.ts --identity: the host bytes of a guest address. The default is the
   address itself, for a runtime that maps guests at their own addresses
   (-DKB_IDENTITY in mem.c) */
#ifndef AOT_HOST
    #ifdef KB_WINDOW
/* the guest lives in one block of the program's own memory at its own offsets
   (mem.c under -DKB_IDENTITY -DKB_WINDOW=<bytes>); an access is the block's
   address plus the low 32 bits of the guest address */
extern uint8_t kb_window[] __attribute__((visibility("hidden")));
        #define AOT_HOST(va) (kb_window + (uint32_t) (va))
    #else
        #define AOT_HOST(va) ((uint8_t*) (uintptr_t) (va))
    #endif
#endif

/* attribution arms, unsafe outside a measurement:-DAOT_NO_SIGNAL_CHECK moves
   between lifted blocks without looking for a pending signal (the verification
   check stays: an unmatched block has no IR to run), -DAOT_NO_RANGE_CHECK
   trusts a load or store's cached mapping whenever its generation holds */
/* back: the transition goes to the same or a lower address; AOT_POLL (kb.h's
   KB_POLL unless set) polls only there, or every KB_POLL_FUEL transitions */
#ifndef AOT_POLL
    #define AOT_POLL KB_POLL
#endif
/* -DKB_COUNT: moves between lifted blocks and the reads of the pending flag
   among them, and the accesses by kind (printed beside the interpreter's
   counts at exit; not counted under AOT_POLL 3, which polls by fuel) */
#ifdef KB_COUNT
struct aot_stat {
    uint64_t win_enter, win_acc, chk_acc, grp_acc, cont, polls;
    uint64_t ep_in, ep_slow, ep_back;
    uint64_t win_idx, win_slow, win_fail, reval;
    uint64_t flat_hit, flat_sync;
};
static struct aot_stat aot_stat;
    #define AOT_STAT(f, n) (aot_stat.f += (n))
    #define AOT_NOTE(polled) (aot_stat.cont++, aot_stat.polls += (polled))
    #define AOT_NOTE_EP(back) (aot_stat.cont++, aot_stat.ep_back += (back))
#else
    #define AOT_STAT(f, n) ((void) 0)
    #define AOT_NOTE(polled) ((void) 0)
    #define AOT_NOTE_EP(back) ((void) 0)
#endif
/* -DAOT_CLASS (lifted with --classes): each access reports its kind (0 window,
   1 group, 2 checked, 3 slot held in a local, 4 frame window), load or store
   and the mapping it lands in; the tally is appended to $KATYBUG_COUNT at exit
 */
#ifdef AOT_CLASS
struct aot_cls_row {
    uint64_t start, end, n[5][2], straddle[5][2], cross[5][2];
    int prot, bits;
};
static struct aot_cls_row aot_cls_rows[256];
static int aot_cls_nrows;
static uint64_t aot_cls_none[5][2];
/* one entry per load or store the lifter emitted (its site id, counted in
   emission order, so a second lift with the same flags numbers them the same):
   accesses, those on the page of the site's previous access, those at the
   previous address, the mapping start */
static struct aot_site {
    uint64_t n, page, same, last, map;
    int kind, st, w, multi;
} aot_sites[1 << 16];

static __attribute__((noinline)) void aot_cls(
    struct kb_cpu* cpu, int kind, int st, uint64_t va, int w, int site
) {
    static int last = -1;
    const struct kb_mapping* m = NULL;
    if (last >= 0 && last < cpu->nmaps && va >= cpu->maps[last].start &&
        va < cpu->maps[last].end)
        m = &cpu->maps[last];
    for (int i = 0; !m && i < cpu->nmaps; i++)
        if (va >= cpu->maps[i].start && va < cpu->maps[i].end)
            m = &cpu->maps[last = i];
    struct aot_site* s = &aot_sites[site & 0xffff];
    if (!m) {
        aot_cls_none[kind][st]++;
        s->multi |= s->n != 0;
        s->n++;
        return;
    }
    if (s->n && s->map != m->start) s->multi = 1;
    s->page += s->n && (s->last >> 12) == (va >> 12);
    s->same += s->n && s->last == va;
    s->n++, s->last = va, s->map = m->start, s->kind = kind, s->st = st,
            s->w = w;
    struct aot_cls_row* r = NULL;
    for (int i = 0; i < aot_cls_nrows && !r; i++)
        if (aot_cls_rows[i].start == m->start &&
            aot_cls_rows[i].end == m->end && aot_cls_rows[i].prot == m->prot &&
            aot_cls_rows[i].bits == m->bits)
            r = &aot_cls_rows[i];
    if (!r) {
        if (aot_cls_nrows == 256) return;
        r = &aot_cls_rows[aot_cls_nrows++];
        r->start = m->start, r->end = m->end, r->prot = m->prot,
        r->bits = m->bits;
    }
    r->n[kind][st]++;
    r->straddle[kind][st] +=
        (va >> m->bits) != ((va + (uint64_t) w - 1) >> m->bits);
    r->cross[kind][st] += va + (uint64_t) w > m->end;
}

__attribute__((destructor)) static void aot_cls_report(void) {
    const char* path = getenv("KATYBUG_COUNT");
    FILE* f = path ? fopen(path, "a") : NULL;
    if (!f) return;
    for (int k = 0; k < 5; k++)
        for (int s = 0; s < 2; s++) {
            if (aot_cls_none[k][s])
                fprintf(
                    f,
                    "katybug cls: kind %d st %d start 0 end 0 prot -1 bits 0 n "
                    "%llu straddle 0 cross 0\n",
                    k, s, (unsigned long long) aot_cls_none[k][s]
                );
            for (int i = 0; i < aot_cls_nrows; i++) {
                const struct aot_cls_row* r = &aot_cls_rows[i];
                if (!r->n[k][s]) continue;
                fprintf(
                    f,
                    "katybug cls: kind %d st %d start %llx end %llx prot %d "
                    "bits %d n %llu straddle %llu cross %llu\n",
                    k, s, (unsigned long long) r->start,
                    (unsigned long long) r->end, r->prot, r->bits,
                    (unsigned long long) r->n[k][s],
                    (unsigned long long) r->straddle[k][s],
                    (unsigned long long) r->cross[k][s]
                );
            }
        }
    for (int i = 0; i < 1 << 16; i++)
        if (aot_sites[i].n >= 1000)
            fprintf(
                f,
                "katybug site: id %d kind %d st %d w %d n %llu page %llu "
                "same %llu multi %d map %llx\n",
                i, aot_sites[i].kind, aot_sites[i].st, aot_sites[i].w,
                (unsigned long long) aot_sites[i].n,
                (unsigned long long) aot_sites[i].page,
                (unsigned long long) aot_sites[i].same, aot_sites[i].multi,
                (unsigned long long) aot_sites[i].map
            );
    fclose(f);
}
    #define AOT_CLS(site, kind, st, va, w) aot_cls(cpu, kind, st, va, w, site)
#else
    #define AOT_CLS(site, kind, st, va, w) ((void) 0)
#endif
/* -DAOT_WIN_CHECK: an access with an index bound stops the run when its address
   is outside its window (a verification build of the lifter's bounds) */
#ifdef AOT_WIN_CHECK
    #define AOT_WINCHK(dist, room)                                             \
        do {                                                                   \
            if ((dist) > (room)) {                                             \
                fprintf(                                                       \
                    stderr, "katybug: indexed access outside its window\n"     \
                );                                                             \
                abort();                                                       \
            }                                                                  \
        } while (0)
#else
    #define AOT_WINCHK(dist, room) ((void) 0)
#endif
/* lift.ts --epochs: a region keeps the kb_epoch it was entered at (ep) and its
   caches are valid until kb_epoch moves; a back edge tests ep, and a cache is
   cold or current (run.c's KB_IC_COLD) */
#ifdef AOT_EPOCHS
    #if !KB_EPOCH
        #error "lifted with --epochs: build with -DKB_EPOCH=1"
    #endif
    #define AOT_COLD 7
#endif
#ifdef AOT_NO_SIGNAL_CHECK
    #define AOT_CONTINUE(ok, back) (AOT_NOTE(0), (ok))
#elif defined(AOT_EPOCHS)
    #define AOT_CONTINUE(ok, back)                                             \
        (AOT_NOTE_EP(!!(back)), (!(back) || kb_epoch == ep) && (ok))
#elif AOT_POLL == 1 || AOT_POLL == 2
    #define AOT_CONTINUE(ok, back)                                             \
        (AOT_NOTE(!!(back)), (!(back) || !*kb_pending_flag) && (ok))
#elif AOT_POLL == 3
    #define AOT_CONTINUE(ok, back)                                             \
        (AOT_NOTE(0),                                                          \
         (--fuel || (fuel = KB_POLL_FUEL, !*kb_pending_flag)) && (ok))
#else
    #define AOT_CONTINUE(ok, back) (AOT_NOTE(1), !*kb_pending_flag && (ok))
#endif
#if defined(AOT_EPOCHS) && defined(AOT_NO_RANGE_CHECK)
    #define AOT_SLOW(q, gen, va, w) ((q)->host == NULL)
#elif defined(AOT_EPOCHS)
    #define AOT_SLOW(q, gen, va, w) ((va) - (q)->lo >= (q)->span - AOT_COLD)
#elif defined(AOT_NO_RANGE_CHECK)
    #define AOT_SLOW(q, gen, va, w) ((q)->gen != (gen))
#else
    #define AOT_SLOW(q, gen, va, w)                                            \
        ((q)->gen != (gen) || (va) - (q)->lo > (q)->span - (w))
#endif

/* a resolve that fails (the span is not in one accessible piece) is counted
   where the lifted code makes it */
#ifdef KB_COUNT
static inline uint8_t* aot_host_ic_at(
    struct kb_cpu* cpu, struct kb_ic* ic, uint64_t va, uint64_t len, int acc
) {
    uint8_t* p = kb_host_ic_at(cpu, ic, va, len, acc);
    aot_stat.win_fail += !p;
    return p;
}
    #define kb_host_ic_at aot_host_ic_at
#endif

/* lift.ts --bounds=two: a window of len bytes from va that may cross one piece
   boundary. Returns the host bytes of va's piece; *h1 is the next piece's and
   *bd the guest address where it starts, or (uint64_t) -1 when the window ends
   in the first. NULL when either piece does not resolve for acc (KB_R for a
   window that only loads, KB_W for one that stores) */
static inline __attribute__((always_inline)) uint8_t* aot_open2(
    struct kb_cpu* cpu, struct kb_ic* q0, struct kb_ic* q1, uint32_t gen,
    uint64_t va, uint64_t len, int acc, uint8_t** h1, uint64_t* bd
) {
    /* under epochs a cache is cold (no span) or current, so no generation */
#ifdef AOT_EPOCHS
    #define AOT_GEN(q) ((void) gen, 1)
#else
    #define AOT_GEN(q) ((q)->gen == gen)
#endif
    uint8_t* p = AOT_GEN(q0) && va - q0->lo < q0->span
                     ? q0->host + (va - q0->lo)
                     : kb_host_ic_at(cpu, q0, va, 1, acc);
    if (!p) return NULL;
    uint64_t end = q0->lo + q0->span;
    if (va + len <= end) {
        *bd = ~0ull;
        return p;
    }
    uint64_t need = va + len - end;
    uint8_t* r =
        AOT_GEN(q1) && need <= q1->span && end - q1->lo <= q1->span - need
            ? q1->host + (end - q1->lo)
            : kb_host_ic_at(cpu, q1, end, need, acc);
    if (!r) return NULL;
    *h1 = r;
    *bd = end;
    return p;
}

/* the host address of an access at a, w bytes wide, in a two-piece window that
   starts at va (host h0) with its second piece at bd (host h1); NULL when the
   window did not resolve or the access straddles the boundary */
#define AOT_PICK2(a, w, va, h0, h1, bd)                                        \
    ((h0) ? ((a) >= (bd)         ? (h1) + ((a) - (bd))                         \
             : (a) + (w) <= (bd) ? (h0) + ((a) - (va))                         \
                                 : NULL)                                       \
          : NULL)

/* -DAOT_LOOP_CHECK: a loop window used after the mapping generation moved past
   the one it was resolved at stops the run (a verification build of the loop
   guards' revalidation) */
#ifdef AOT_LOOP_CHECK
    #define AOT_LCHK_FAIL()                                                    \
        do {                                                                   \
            fprintf(stderr, "katybug: loop window used past a remap\n");       \
            abort();                                                           \
        } while (0)
    #ifdef AOT_EPOCHS
        #define AOT_LGEN cpu->mapgen
    #else
        #define AOT_LGEN gen
    #endif
    #define AOT_LCHK(q)                                                        \
        do {                                                                   \
            if ((q)->gen != AOT_LGEN) AOT_LCHK_FAIL();                         \
        } while (0)
    #define AOT_LCHK1(q, bd)                                                   \
        do {                                                                   \
            if ((bd) != ~0ull && (q)->gen != AOT_LGEN) AOT_LCHK_FAIL();        \
        } while (0)
#else
    #define AOT_LCHK(q) ((void) 0)
    #define AOT_LCHK1(q, bd) ((void) 0)
#endif

/* -DKB_COUNT: a region's own cpu traffic (entry loads, exit stores, spills
   around helpers) and its block runs, beside the interpreter's (run.c) */
enum
{
    AOT_C_REGION, /* entry loads and exit stores */
    AOT_C_SSE,
    AOT_C_X87,
    AOT_C_STR,
    AOT_C_SYS,
    AOT_C_FS,
    AOT_C_SLOT, /* slots form: loads served by a local [0], stores that updated
                   one [1] */
    AOT_C_FIX,  /* slots form: loads at a stub or edge [0], re-reads after an
                   unknown store [1] */
    AOT_C_MEM, /* slots form: guest loads [0] and stores [1] that went to memory
                */
    AOT_C_CALL /* direct calls into another region [0] */
};

/* A direct call (lift.ts --calls) from region A to a block of region B, a call
 * to B's block that has no other way in than a return address pushed by A's
 * block:
 *  - B's blocks run as `rB_go(cpu, pc, io)`, always inlined into A at the call
 *    site, with A's registers, flags, df, mapping generation and fs base in
 *    io, a struct of locals; nothing goes through the cpu. A holds every
 *    register B holds (B's region registers are a subset of A's), so a
 *    register is never in the cpu on one side and in a local on the other;
 *    B's helper registers (string, SSE, x87) are part of that set
 *  - B runs from the target block and leaves through its own `out` with the
 *    pc it stopped at, its state in io. A takes every field back; a pc that is
 *    A's return site (the pushed address) continues at that block, any other
 *    pc (a fault, a pending signal, a jump elsewhere) leaves through A's out,
 *    which stores every register and the flags in the cpu with the pc exact
 *  - a fault in B sets the cpu's fault and ipc before it leaves, so A's exit
 *    hands the interpreter the faulting pc with all registers and flags as
 *    they stood; a signal handler that returns resumes the interpreter there
 *  - a callee has no syscall (it may fork or switch threads and needs every
 *    register in the cpu), a call that would close a cycle between regions
 *    leaves instead, and a block that did not attach (kb_aot_attach) is never
 *    entered, so the call leaves for the interpreter at that pc
 *  - the slots form re-enters a promoted return site through its stub: the
 *    callee may have written a frame slot through a pointer */

/* -DKB_COUNT: where regions are left, by the guest pc the interpreter resumes
   at; KATYBUG_EXITS=<n> prints the n most common at exit */
#ifdef KB_COUNT
struct aot_exit {
    uint64_t pc, n;
};
static struct aot_exit aot_exits[1024];

static void aot_exit_at(uint64_t pc) {
    for (unsigned h = (unsigned) (pc ^ (pc >> 10)) & 1023, k = 0; k < 1024;
         k++, h = (h + 1) & 1023)
        if (aot_exits[h].n == 0 || aot_exits[h].pc == pc) {
            aot_exits[h].pc = pc;
            aot_exits[h].n++;
            return;
        }
}

static int aot_exit_order(const void* a, const void* b) {
    const struct aot_exit *x = a, *y = b;
    return x->n < y->n ? 1 : x->n > y->n ? -1 : 0;
}

__attribute__((destructor)) static void aot_exit_report(void) {
    const char* e = getenv("KATYBUG_EXITS");
    if (!e) return;
    qsort(aot_exits, 1024, sizeof aot_exits[0], aot_exit_order);
    for (int i = 0; i < atoi(e) && i < 1024 && aot_exits[i].n; i++)
        fprintf(
            stderr, "katybug exit: %llx %llu\n",
            (unsigned long long) aot_exits[i].pc,
            (unsigned long long) aot_exits[i].n
        );
}
    #define AOT_COUNT_EXIT(pc) aot_exit_at(pc)

__attribute__((destructor)) static void aot_stat_report(void) {
    const char* path = getenv("KATYBUG_COUNT");
    FILE* f = path ? fopen(path, "a") : NULL;
    if (!f) return;
    fprintf(
        f,
        "katybug aot: win_enter %llu win_acc %llu chk_acc %llu grp_acc %llu "
        "cont %llu polls %llu ep_in %llu ep_slow %llu ep_back %llu "
        "win_idx %llu win_slow %llu win_fail %llu reval %llu\n",
        (unsigned long long) aot_stat.win_enter,
        (unsigned long long) aot_stat.win_acc,
        (unsigned long long) aot_stat.chk_acc,
        (unsigned long long) aot_stat.grp_acc,
        (unsigned long long) aot_stat.cont, (unsigned long long) aot_stat.polls,
        (unsigned long long) aot_stat.ep_in,
        (unsigned long long) aot_stat.ep_slow,
        (unsigned long long) aot_stat.ep_back,
        (unsigned long long) aot_stat.win_idx,
        (unsigned long long) aot_stat.win_slow,
        (unsigned long long) aot_stat.win_fail,
        (unsigned long long) aot_stat.reval
    );
    fprintf(
        f, "katybug flat: hit %llu sync %llu\n",
        (unsigned long long) aot_stat.flat_hit,
        (unsigned long long) aot_stat.flat_sync
    );
    fclose(f);
}
#else
    #define AOT_COUNT_EXIT(pc) ((void) 0)
#endif

#ifdef KB_COUNT
    #define AOT_COUNT_BLOCK(b) ((b)->runs++)
    #define AOT_COUNT_RD(n) (kb_count.rd += (n))
    #define AOT_COUNT_WR(n) (kb_count.wr += (n))
    #define AOT_COUNT_RDC(c, n) (kb_count.rd += (n), kb_count.cat[c][0] += (n))
    #define AOT_COUNT_WRC(c, n) (kb_count.wr += (n), kb_count.cat[c][1] += (n))
    #define AOT_COUNT_CAT(c, i, n) (kb_count.cat[c][i] += (n))
#else
    #define AOT_COUNT_BLOCK(b) ((void) 0)
    #define AOT_COUNT_RD(n) ((void) 0)
    #define AOT_COUNT_WR(n) ((void) 0)
    #define AOT_COUNT_RDC(c, n) ((void) 0)
    #define AOT_COUNT_WRC(c, n) ((void) 0)
    #define AOT_COUNT_CAT(c, i, n) ((void) 0)
#endif

/* KATYBUG_REGS=1 runs the regions built with lift.ts --regs in their precise
 * form (aot_runp), 2 the one built with --slots (aot_runs); anything else, the
 * form every earlier arm used */
static inline int aot_regs(void) {
    static int on = -1;
    if (on < 0) {
        const char* e = getenv("KATYBUG_REGS");
        on = e && e[0] >= '1' && e[0] <= '2' ? e[0] - '0' : 0;
    }
    return on;
}

struct aot_entry {
    uint64_t pc, next, target;
    int n, region, idx;
    const struct kb_ins* ins;
    const uint32_t* pcs; /* each op's instruction offset, or NULL */
};

#endif
