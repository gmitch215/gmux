#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>

#include "kb.h"
#include "wide.h"

#ifdef KB_HOT
    #include <unistd.h>
#endif

void kb_put(
    struct kb_emit* e, int op, int w, int a, int b, int c, int64_t imm
) {
    if (e->n == e->cap) {
        e->cap = e->cap ? e->cap * 2 : 64;
        e->ins = realloc(e->ins, (size_t) e->cap * sizeof *e->ins);
    }
    e->ins[e->n++] = (struct kb_ins){(uint8_t) op, (uint8_t) w, (uint8_t) a,
                                     (uint8_t) b,  (uint8_t) c, imm};
}

static uint64_t mask(int w) {
    return w >= 8 ? ~0ull : (1ull << (8 * w)) - 1;
}

static int64_t sext(uint64_t v, int w) {
    int s = 64 - 8 * w;
    return w >= 8 ? (int64_t) v : (int64_t) (v << s) >> s;
}

static int parity(uint64_t v) {
    v &= 0xff;
    v ^= v >> 4;
    v ^= v >> 2;
    v ^= v >> 1;
    return !(v & 1);
}

KB_NOINLINE static void flags(
    struct kb_cpu* cpu, int kind, uint64_t a, uint64_t b, uint64_t r, int w
) {
    uint64_t m = mask(w), sign = 1ull << (8 * w - 1);
    if ((kind == KB_F_SHL || kind == KB_F_SHR || kind == KB_F_SAR ||
         kind == KB_F_ROL || kind == KB_F_ROR) &&
        b == 0)
        return;
    /* kinds that read an operand whole, before masking */
    switch (kind) {
        case KB_F_MULOV: cpu->c = cpu->v = b != 0; return;
        case KB_F_SETC: cpu->c = (int) (b & 1); return;
        case KB_F_ZERO: cpu->z = (b & m) == 0; return;
        case KB_F_CNT:
            cpu->c = (b & m) == 0;
            cpu->z = (r & m) == 0;
            return;
        case KB_F_ROL:
            cpu->c = (int) (r & 1);
            cpu->v = !!(r & sign) ^ cpu->c;
            return;
        case KB_F_ROR:
            cpu->c = !!(r & sign);
            cpu->v = !!(r & sign) ^ !!(r & (sign >> 1));
            return;
    }
    a &= m;
    b &= m;
    r &= m;
    cpu->z = r == 0;
    cpu->n = !!(r & sign);
    cpu->p = parity(r);
    switch (kind) {
        case KB_F_ADD:
        case KB_F_A_ADD:
            cpu->c = r < a;
            cpu->v = !!(~(a ^ b) & (a ^ r) & sign);
            break;
        case KB_F_ADC: {
            /* r = a + b + the carry still held from before the op */
            uint64_t cin = (uint64_t) cpu->c;
            cpu->c = w < 8 ? a + b + cin > m : (cin ? r <= a : r < a);
            cpu->v = !!(~(a ^ b) & (a ^ r) & sign);
            break;
        }
        case KB_F_SUB:
            cpu->c = a < b;
            cpu->v = !!((a ^ b) & (a ^ r) & sign);
            break;
        case KB_F_SBB: {
            uint64_t cin = (uint64_t) cpu->c;
            cpu->c = w < 8 ? a < b + cin : (a < b || (cin && a == b));
            cpu->v = !!((a ^ b) & (a ^ r) & sign);
            break;
        }
        case KB_F_A_SUB:
            cpu->c = a >= b;
            cpu->v = !!((a ^ b) & (a ^ r) & sign);
            break;
        case KB_F_LOGIC:
        case KB_F_A_LOGIC:
            cpu->c = 0;
            cpu->v = 0;
            break;
        case KB_F_INC: cpu->v = r == sign; break;
        case KB_F_DEC: cpu->v = r == sign - 1; break;
        case KB_F_NEG:
            cpu->c = b != 0;
            cpu->v = b == sign;
            break;
        case KB_F_SHL:
            /* b is the count, nonzero: the decoder skips flags for a zero count
             */
            cpu->c = b <= 8u * (unsigned) w ? !!((a << (b - 1)) & sign) : 0;
            cpu->v = cpu->n ^ cpu->c;
            break;
        case KB_F_SHR:
            cpu->c = !!((a >> (b - 1)) & 1);
            cpu->v = !!(a & sign);
            break;
        case KB_F_SAR:
            cpu->c = !!(((uint64_t) sext(a, w) >> (b - 1)) & 1);
            cpu->v = 0;
            break;
        case KB_F_NZCV:
            cpu->n = !!(b & (1u << 31));
            cpu->z = !!(b & (1u << 30));
            cpu->c = !!(b & (1u << 29));
            cpu->v = !!(b & (1u << 28));
            break;
    }
}

/*
 * K17, lazy flags: a KB_FLAGS op of a kind that sets every flag records its
 * kind and operands instead (cpu->lz); a condition reads the record directly
 * (KB_LAZY 2) and anything else that reads or writes the flags materializes
 * it first (KB_SYNC). KB_LAZY 1 materializes for conditions too; 0 is eager
 */
static int lazy_kind(int kind) {
    switch (kind) {
        case KB_F_ADD:
        case KB_F_A_ADD:
        case KB_F_SUB:
        case KB_F_A_SUB:
        case KB_F_LOGIC:
        case KB_F_A_LOGIC:
        case KB_F_NEG: return 1;
    }
    return 0;
}

void kb_flags_sync(struct kb_cpu* cpu) {
    int kind = cpu->lz - 1;
    cpu->lz = 0;
    flags(cpu, kind, cpu->lz_b, cpu->lz_c, cpu->lz_r, cpu->lz_w);
}

static int eval_cond(int cond, int n, int z, int c, int v, int p) {
    if (cond < KB_C_A64) {
        int r;
        switch (cond >> 1) {
            case 0: r = v; break;
            case 1: r = c; break;
            case 2: r = z; break;
            case 3: r = c || z; break;
            case 4: r = n; break;
            case 5: r = p; break;
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

int kb_cond(struct kb_cpu* cpu, int cond) {
#if KB_LAZY >= 2
    /* n z c v straight from the record; parity materializes */
    if (cpu->lz && !(cond < KB_C_A64 && cond >> 1 == 5)) {
        int kind = cpu->lz - 1, w = cpu->lz_w;
        uint64_t m = mask(w), sign = 1ull << (8 * w - 1);
        uint64_t a = cpu->lz_b & m, b = cpu->lz_c & m, r = cpu->lz_r & m;
        int n = !!(r & sign), z = r == 0, c = 0, v = 0;
        switch (kind) {
            case KB_F_ADD:
            case KB_F_A_ADD:
                c = r < a;
                v = !!(~(a ^ b) & (a ^ r) & sign);
                break;
            case KB_F_SUB:
            case KB_F_A_SUB:
                c = kind == KB_F_SUB ? a < b : a >= b;
                v = !!((a ^ b) & (a ^ r) & sign);
                break;
            case KB_F_NEG:
                c = b != 0;
                v = b == sign;
                break;
        }
        return eval_cond(cond, n, z, c, v, 0);
    }
#endif
    if (cpu->lz) kb_flags_sync(cpu);
    return eval_cond(cond, cpu->n, cpu->z, cpu->c, cpu->v, cpu->p);
}

/* x86 mul, imul, div and idiv of rdx:rax (ax for bytes) by v; 1 on a divide
 * error */
static int muldiv(struct kb_cpu* cpu, int kind, int w, uint64_t v) {
    uint64_t* r = cpu->r;
    if (kind == 4 || kind == 5) {
        cpu->c = cpu->v = kb_mul(kind == 5, w, &r[0], &r[2], v);
        return 0;
    }
    if (kb_divide(kind == 7, w, &r[0], &r[2], v)) {
        cpu->fault = "divide error";
        cpu->fault_sig = 8;
        return 1;
    }
    return 0;
}

/* x86 movs and stos, down when the direction flag is set (memmove copies
 * backward that way) */
/* a forward rep in one go over host memory: up to 1 MiB, cut at the end of
 * either range's piece, or 0 when no whole element is left there; an
 * overlapping movs keeps the element order */
static uint64_t string_bulk(struct kb_cpu* cpu, int stos, int w, uint64_t n) {
    uint64_t* r = cpu->r;
    if (n > (1u << 20) / (unsigned) w) n = (1u << 20) / (unsigned) w;
    uint64_t len = n * (uint64_t) w, kd, ks = len;
    uint8_t* d = kb_span(cpu, r[7], &kd);
    uint8_t* s = stos ? NULL : kb_span(cpu, r[6], &ks);
    if (!d || (!stos && !s)) return 0;
    if (kd < len) len = kd;
    if (ks < len) len = ks;
    len -= len % (uint64_t) w;
    if (!len) return 0;
    n = len / (uint64_t) w;
    if (stos && w == 1)
        memset(d, (int) (uint8_t) r[0], len);
    else if (stos)
        for (uint64_t i = 0; i < len; i += (uint64_t) w)
            memcpy(d + i, &r[0], (size_t) w);
    else if (r[7] > r[6] && r[7] - r[6] < len)
        for (uint64_t i = 0; i < len; i += (uint64_t) w) {
            uint64_t v;
            memcpy(&v, s + i, (size_t) w);
            memcpy(d + i, &v, (size_t) w);
        }
    else
        memmove(d, s, len);
    r[7] += len;
    if (!stos) r[6] += len;
    r[1] -= n;
    return n;
}

/* one element; 0 on a fault, which leaves the registers at that element */
static int string_one(struct kb_cpu* cpu, int stos, int w, int rep) {
    uint64_t* r = cpu->r;
    uint64_t v = stos ? r[0] : kb_load(cpu, r[6], w);
    if (!cpu->fault) kb_store(cpu, r[7], v, w);
    if (cpu->fault) return 0;
    uint64_t step = cpu->df ? (uint64_t) -(int64_t) w : (uint64_t) w;
    r[7] += step;
    if (!stos) r[6] += step;
    if (rep) r[1]--;
    return 1;
}

static void string(struct kb_cpu* cpu, int stos, int w, int rep) {
    uint64_t* r = cpu->r;
    uint64_t n = rep ? r[1] : 1;
    while (n) {
        uint64_t k = n;
        if (rep && !cpu->df) {
            uint64_t done = string_bulk(cpu, stos, w, n);
            if (done) {
                n -= done;
                continue;
            }
            /* element by element to the next page, where a fault is exact */
            k = (4096 - (r[7] & 4095) + (uint64_t) w - 1) / (uint64_t) w;
            uint64_t ks =
                (4096 - (r[6] & 4095) + (uint64_t) w - 1) / (uint64_t) w;
            if (!stos && ks < k) k = ks;
            if (k > n) k = n;
        }
        for (n -= k; k; k--)
            if (!string_one(cpu, stos, w, rep)) return;
    }
}

enum
{
    FN = 1,
    FZ = 2,
    FC = 4,
    FV = 8,
    FP = 16,
    FALL = 31
};

#ifdef KB_AOT
void kb_aot_string(struct kb_cpu* cpu, int stos, int w, int rep) {
    string(cpu, stos, w, rep);
}
#endif

/* the flags a condition reads, as kb_cond does */
static int cond_reads(int cond) {
    static const int x86[8] = {FV, FC, FZ,      FC | FZ,
                               FN, FP, FN | FV, FZ | FN | FV};
    static const int a64[7] = {FZ, FC, FN, FV, FC | FZ, FN | FV, FZ | FN | FV};
    if (cond < KB_C_A64) return x86[cond >> 1];
    return cond - KB_C_A64 >= 14 ? 0 : a64[(cond - KB_C_A64) >> 1];
}

/* the flags a KB_FLAGS kind may write, and those it always writes (a shift by 0
 * writes none) */
static int flags_may(int kind) {
    switch (kind) {
        case KB_F_MULOV:
        case KB_F_ROL:
        case KB_F_ROR: return FC | FV;
        case KB_F_SETC: return FC;
        case KB_F_ZERO: return FZ;
        case KB_F_CNT: return FC | FZ;
        case KB_F_INC:
        case KB_F_DEC: return FN | FZ | FP | FV;
        default: return FALL;
    }
}

static int flags_must(int kind) {
    switch (kind) {
        case KB_F_ROL:
        case KB_F_ROR:
        case KB_F_SHL:
        case KB_F_SHR:
        case KB_F_SAR: return 0;
        default: return flags_may(kind);
    }
}

enum
{
    PURE_DEF = KB_K_PURE | KB_K_DEF,
    OPAQUE = KB_K_READ | KB_K_WRITE | KB_K_FAULT | KB_K_HOST | KB_K_CLOBBER
};
const uint16_t kb_class[] = {
    [KB_MOVI] = PURE_DEF,
    [KB_MOV] = PURE_DEF,
    [KB_ADD] = PURE_DEF,
    [KB_SUB] = PURE_DEF,
    [KB_AND] = PURE_DEF,
    [KB_OR] = PURE_DEF,
    [KB_XOR] = PURE_DEF,
    [KB_SHL] = PURE_DEF,
    [KB_SHR] = PURE_DEF,
    [KB_SAR] = PURE_DEF,
    [KB_ROR] = PURE_DEF,
    [KB_MUL] = PURE_DEF,
    [KB_UMULH] = PURE_DEF,
    [KB_SMULH] = PURE_DEF,
    [KB_UDIV] = PURE_DEF,
    [KB_SDIV] = PURE_DEF,
    [KB_UREM] = PURE_DEF,
    [KB_SREM] = PURE_DEF,
    [KB_ZEXT] = PURE_DEF,
    [KB_SEXT] = PURE_DEF,
    [KB_INS] = PURE_DEF,
    [KB_LD] = KB_K_DEF | KB_K_READ | KB_K_FAULT,
    [KB_LDS] = KB_K_DEF | KB_K_READ | KB_K_FAULT,
    [KB_ST] = KB_K_WRITE | KB_K_FAULT,
    [KB_FLAGS] = KB_K_FLAGS_W,
    [KB_SETCC] = KB_K_DEF | KB_K_FLAGS_R,
    [KB_SEL] = KB_K_DEF | KB_K_FLAGS_R,
    [KB_BR] = KB_K_CONTROL | KB_K_FLAGS_R,
    [KB_JMP] = KB_K_CONTROL,
    [KB_SYSCALL] = KB_K_CONTROL | OPAQUE,
    [KB_TRAP] = KB_K_CONTROL | KB_K_FAULT,
    [KB_CARRY] = KB_K_DEF | KB_K_FLAGS_R,
    [KB_BSWAP] = PURE_DEF,
    [KB_CLZ] = PURE_DEF,
    [KB_CTZ] = PURE_DEF,
    [KB_TPIDR] = PURE_DEF,
    [KB_X86MD] = KB_K_FLAGS_W | KB_K_FAULT | KB_K_CLOBBER,
    [KB_X86STR] = KB_K_READ | KB_K_WRITE | KB_K_FAULT | KB_K_CLOBBER,
    [KB_FSBASE] = PURE_DEF,
    [KB_BRZ] = KB_K_CONTROL,
    [KB_CCMP] = KB_K_FLAGS_R | KB_K_FLAGS_W,
    [KB_SETTP] = KB_K_HOST,
    [KB_PC] = KB_K_PURE, /* bookkeeping: where a fault reports */
    [KB_SSE] = KB_K_VECTOR | OPAQUE,
    [KB_X86SHD] = KB_K_DEF | KB_K_FLAGS_W,
    [KB_X86FLAGS] = KB_K_FLAGS_R | KB_K_FLAGS_W | KB_K_HOST, /* imm 0: a */
    [KB_X87] = KB_K_VECTOR | OPAQUE,
    [KB_POPCNT] = PURE_DEF,
    [KB_WTRAP] = KB_K_CONTROL | KB_K_FAULT,
    [KB_WEXIT] = KB_K_CONTROL | KB_K_HOST,
    [KB_RESOLVE] = KB_K_ADDRESS,
    [KB_NZCV] = KB_K_DEF | KB_K_FLAGS_R,
    [KB_CRC32] = PURE_DEF,
    [KB_CLOCK] = KB_K_DEF | KB_K_HOST,
    [KB_CPUID] = OPAQUE,
    [KB_EXCL] = KB_K_DEF | KB_K_WRITE | KB_K_FAULT | KB_K_HOST | KB_K_CLOBBER,
    [KB_EXIT] = KB_K_CONTROL | KB_K_FLAGS_R,
    /* fcmp writes flags, fcsel reads them: read-all keeps earlier writes */
    [KB_A64V] = KB_K_VECTOR | OPAQUE | KB_K_FLAGS_R,
    [KB_PRIM] = KB_K_CONTROL | OPAQUE | KB_K_FLAGS_R,
};

/*
 * the flag-demand plan: a KB_FLAGS whose flags are all written again before
 * anything reads them is dropped. A block's exits and any op that can fault (a
 * signal frame carries rflags) read every flag
 */
static void plan_flags(struct kb_cpu* cpu, struct kb_block* b) {
    enum
    {
        DROPPED = 0xff
    };
    int live = FALL, n = 0;
    for (int i = b->n - 1; i >= 0; i--) {
        struct kb_ins* x = &b->ins[i];
        if (x->op == KB_FLAGS) {
            int kind = (int) x->imm;
            cpu->plan_flags++;
            b->flag_writes++;
            if (!(flags_may(kind) & live)) {
                x->op = DROPPED;
                cpu->plan_flags_removed++;
                b->dropped++;
                continue;
            }
            live = (live & ~flags_must(kind)) |
                   (kind == KB_F_ADC || kind == KB_F_SBB ? FC : 0);
        }
        else if (x->op == KB_SETCC || x->op == KB_SEL)
            live |= cond_reads((int) x->imm);
        else if (x->op == KB_CARRY)
            live |= FC;
        else if (!(kb_class[x->op] & KB_K_PURE))
            live = FALL;
    }
    for (int i = 0; i < b->n; i++)
        if (b->ins[i].op != DROPPED) b->ins[n++] = b->ins[i];
    b->n = n;
}

/*
 * backward demand, after the flag plan: a pure op whose result nothing reads
 * is dropped. Guest registers are read at the block's end and at every op that
 * is not pure or a known flag or select op (a fault shows a handler them all);
 * temps only where an op names them. A write to KB_ZERO is never read
 */
static void plan_demand(struct kb_cpu* cpu, struct kb_block* b) {
    enum
    {
        DROPPED = 0xff
    };
    uint64_t live = 0xffffffffull; /* bit r: register r is read later */
    int n = 0;
    for (int i = b->n - 1; i >= 0; i--) {
        struct kb_ins* x = &b->ins[i];
        uint64_t a = 1ull << x->a, reads = 1ull << x->b | 1ull << x->c;
        if ((kb_class[x->op] & PURE_DEF) == PURE_DEF) {
            cpu->plan_ops++;
            if (!(live & a) || x->a == KB_ZERO) {
                x->op = DROPPED;
                cpu->plan_ops_removed++;
                b->pruned++;
                continue;
            }
            live = (live & ~a) | reads | (x->op == KB_INS ? a : 0);
        }
        else if (x->op == KB_FLAGS)
            live |= a | reads;
        else if (
            x->op == KB_SETCC || x->op == KB_SEL || x->op == KB_CARRY ||
            x->op == KB_NZCV
        )
            live = (live & ~a) | reads;
        else if (x->op != KB_PC)
            live = ~0ull;
    }
    for (int i = 0; i < b->n; i++)
        if (b->ins[i].op != DROPPED) b->ins[n++] = b->ins[i];
    b->n = n;
}

/* ops that write their a field (and no other register); a write to KB_ZERO
 * goes to KB_SINK, so the zero register is never written */
static int writes_a(const struct kb_ins* x) {
    return (kb_class[x->op] & KB_K_DEF) ||
           (x->op == KB_X86FLAGS && x->imm == 0);
}

/* a plain load or store: memory and nothing opaque */
static int is_access(int op) {
    int k = kb_class[op];
    return (k & (KB_K_READ | KB_K_WRITE)) && !(k & KB_K_CLOBBER);
}

/*
 * the memory plan: each register's value is followed through the block as a
 * register's value at entry (or 0) plus a constant; loads and stores whose
 * address is one root plus an offset share a KB_RESOLVE at the block's start
 * that resolves the span of their offsets once (at most 4,080 bytes). An
 * access in a group reads the group's host base; a span that is not one
 * accessible mapping leaves every access to its own check, so faults stay
 * where they were. Ops with effects beyond their a field end the analysis
 */
static void plan_mem(struct kb_cpu* cpu, struct kb_block* b) {
    enum
    {
        GROUPS = 8,
        UNKNOWN = -1,
        CONST = KB_ZERO,
        SPAN = 16 * 255
    };
    int root[KB_NREGS];
    uint64_t off[KB_NREGS]; /* wrapping, as addresses do */
    for (int r = 0; r < KB_NREGS; r++) root[r] = r, off[r] = 0;
    root[KB_ZERO] = CONST;
    int groot[GROUPS], gn[GROUPS], ng = 0;
    uint64_t glo[GROUPS], ghi[GROUPS];
    int* group = calloc((size_t) (b->n ? b->n : 1), sizeof *group);
    if (!group) return;
    for (int i = 0; i < b->n; i++) {
        struct kb_ins* x = &b->ins[i];
        if (is_access(x->op)) {
            cpu->plan_mem++;
            int rt = root[x->b];
            uint64_t o = off[x->b] + (uint64_t) x->imm, e = o + x->w;
            int g = 0;
            while (g < ng && groot[g] != rt) g++;
            if (rt != UNKNOWN && g < GROUPS) {
                uint64_t lo = g < ng && (int64_t) (glo[g] - o) < 0 ? glo[g] : o;
                uint64_t hi = g < ng && (int64_t) (ghi[g] - e) > 0 ? ghi[g] : e;
                if (hi - lo <= SPAN) {
                    if (g == ng) groot[ng] = rt, gn[ng++] = 0;
                    glo[g] = lo, ghi[g] = hi, gn[g]++;
                    group[i] = g + 1;
                }
            }
        }
        else if (kb_class[x->op] & KB_K_CLOBBER)
            break;
        if (!writes_a(x) || x->a == KB_ZERO) continue;
        int a = x->a, rb = root[x->b], rc = root[x->c];
        if (x->op == KB_MOVI)
            root[a] = CONST, off[a] = (uint64_t) x->imm;
        else if (x->op == KB_MOV)
            root[a] = rb, off[a] = off[x->b];
        else if (x->op == KB_ADD && rc == CONST && rb != UNKNOWN)
            root[a] = rb, off[a] = off[x->b] + off[x->c];
        else if (x->op == KB_ADD && rb == CONST && rc != UNKNOWN)
            root[a] = rc, off[a] = off[x->b] + off[x->c];
        else if (x->op == KB_SUB && rc == CONST && rb != UNKNOWN)
            root[a] = rb, off[a] = off[x->b] - off[x->c];
        else
            root[a] = UNKNOWN;
    }
    int keep[GROUPS], nk = 0;
    for (int g = 0; g < ng; g++) keep[g] = gn[g] >= 2 ? ++nk : 0;
    if (!nk) {
        free(group);
        return;
    }
    struct kb_ins* ins = malloc((size_t) (b->n + nk) * sizeof *ins);
    if (!ins) {
        free(group);
        return;
    }
    for (int g = 0; g < ng; g++)
        if (keep[g])
            ins[keep[g] - 1] = (struct kb_ins){
                KB_RESOLVE,
                (uint8_t) ((ghi[g] - glo[g] + 15) / 16),
                (uint8_t) (keep[g] - 1),
                (uint8_t) groot[g],
                0,
                (int64_t) glo[g]
            };
    for (int i = 0; i < b->n; i++) {
        ins[nk + i] = b->ins[i];
        if (group[i] && keep[group[i] - 1]) {
            ins[nk + i].c = (uint8_t) keep[group[i] - 1];
            cpu->plan_mem_grouped++;
        }
    }
    free(group);
    free(b->ins);
    b->ins = ins;
    b->n += nk;
    b->resolves = nk;
}

/* KB_PC ops out of the stream, each op's instruction kept beside it for a fault
 * to report (a trace keeps them: it prints each instruction as it runs) */
static struct kb_block* peek(struct kb_cpu* cpu, uint64_t pc) {
    unsigned h = (unsigned) ((pc >> 2) ^ (pc >> 14)) & 4095u;
    for (struct kb_block* b = cpu->cache[h]; b; b = b->chain)
        if (b->pc == pc) return b;
    return NULL;
}

/** block fusion: ops that end in a direct jump (a constant into a temp, then
 * a jump to it) lose it, and decoding goes on at the target, when that is not
 * code the block holds (a loop stays a block transition, where polls happen)
 * and is within the pcs' 31 bits; 1 when it fused */
int kb_fuse(
    struct kb_emit* e, const struct kb_block* b, struct kb_fuse* f,
    uint64_t end, uint64_t* at
) {
    if (e->n < 1 || f->n + 1 >= KB_SEGS) return 0;
    struct kb_ins* j = &e->ins[e->n - 1];
    int jump = KB_FUSE && e->n >= 2 && j->op == KB_JMP && j[-1].op == KB_MOVI &&
               j[-1].a == j->b && f->jumps < (f->trace ? KB_SEGS : KB_FUSE_MAX);
    int branch = f->trace && (j->op == KB_BR || j->op == KB_BRZ) &&
                 f->n + 1 < f->cpu->segments &&
                 !(j->op == KB_BR && j->imm >= KB_C_A64 + 14);
    uint64_t t = 0, cold = 0;
    int taken = 0;
    if (jump)
        t = (uint64_t) j[-1].imm;
    else if (branch) {
        /* the hot side, from the profile of the block this branch ended alone
         */
        const struct kb_block* s = peek(f->cpu, f->head);
        uint32_t tot = s ? s->taken + s->fall : 0;
        if (tot < 16) return 0;
        taken = (uint64_t) s->taken * 10 >= (uint64_t) tot * 9;
        if (!taken && (uint64_t) s->fall * 10 < (uint64_t) tot * 9) return 0;
        t = taken ? b->target : end;
        cold = taken ? end : b->target;
    }
    else
        return 0;
    if (t - b->pc + 0x80000000ull >= 0x100000000ull) return 0;
    if (branch && cold - b->pc + 0x80000000ull >= 0x100000000ull) return 0;
    if (kb_prim_at(f->cpu, t)) return 0; /* a call into one stays a block */
    f->hi[f->n] = end;
    for (int i = 0; i <= f->n; i++)
        if (t >= f->lo[i] && t < f->hi[i]) return 0;
    f->lo[++f->n] = t;
    if (jump) {
        e->n -= 2;
        f->jumps++;
    }
    else {
        /* the branch becomes an exit to its cold side, carried as an offset
         * from the block's pc */
        int zero = j->op == KB_BRZ;
        int64_t c = j->imm,
                flip = c >= KB_C_A64 ? KB_C_A64 + ((c - KB_C_A64) ^ 1) : c ^ 1;
        int64_t cond = zero ? 0x100 | (taken ? c ^ 1 : c) : taken ? flip : c;
        j->op = KB_EXIT;
        j->imm = cond | (int64_t) (uint32_t) (cold - b->pc) << 16;
        f->head = t;
    }
    *at = t;
    return 1;
}

void kb_fuse_done(struct kb_block* b, struct kb_fuse* f, uint64_t end) {
    f->hi[f->n] = end;
    free(b->seg);
    b->nseg = f->n + 1;
    b->seg = malloc(2 * sizeof *b->seg * (size_t) b->nseg);
    for (int i = 0; b->seg && i < b->nseg; i++)
        b->seg[2 * i] = f->lo[i], b->seg[2 * i + 1] = f->hi[i];
}

static int lean_pcs(struct kb_cpu* cpu, struct kb_block* b) {
    if (cpu->trace) return 0;
    if (!(b->pcs = malloc((size_t) (b->n ? b->n : 1) * sizeof *b->pcs)))
        return 1;
    uint64_t at = b->pc;
    int n = 0;
    for (int i = 0; i < b->n; i++) {
        if (b->ins[i].op == KB_PC) {
            at = (uint64_t) b->ins[i].imm;
            continue;
        }
        b->pcs[n] = (uint32_t) (at - b->pc);
        b->ins[n++] = b->ins[i];
    }
    b->n = n;
    return 0;
}

#if KB_POLL == 2
int kb_syscalled;
#endif

volatile uint32_t kb_epoch = 1;

/* a cache that every address misses: the fast path accepts an offset below span
 * - 7, so an access of up to 8 bytes that starts there fits */
#define KB_IC_COLD 7

#ifdef KB_COUNT
    /* evaluates to 0, counting the check as it goes */
    #define KB_CK(field) (kb_count.field++, 0)
#else
    #define KB_CK(field) 0
#endif

#ifdef KB_COUNT
struct kb_count kb_count;

/* the flags a KB_FLAGS kind stores, and the ones it reads first */
static void flag_traffic(int kind, int* rd, int* wr) {
    switch (kind) {
        case KB_F_MULOV:
        case KB_F_CNT: *wr += 2; return;
        case KB_F_SETC:
        case KB_F_ZERO: *wr += 1; return;
        case KB_F_ROL:
            *rd += 1;
            *wr += 2;
            return;
        case KB_F_ROR: *wr += 2; return;
        case KB_F_INC:
        case KB_F_DEC: *wr += 4; return;
        case KB_F_NZCV: *wr += 7; return;
        case KB_F_ADC:
        case KB_F_SBB:
        case KB_F_SHL: *rd += 1; /* fall through */
        default: *wr += 5; return;
    }
}

/* the cpu words step() touches for one block besides the ops' register
 * operands: results, flags, the mapping generation, pc and helper state; the
 * driver's bookkeeping and the helpers' insides (SSE, x87, syscalls, string
 * ops) are left out, in both arms */
static void traffic(const struct kb_block* b, int* rd, int* wr) {
    for (int i = 0; i < b->n; i++) {
        const struct kb_ins* x = &b->ins[i];
        int r = 0, w = 0;
        switch (x->op) {
            case KB_LD:
            case KB_LDS:
                r += 1;
                w += 1;
                break; /* cpu->mapgen */
            case KB_ST: r += 2; break;
            case KB_INS:
                r += 1;
                w += 1;
                break;
            case KB_FLAGS: flag_traffic((int) x->imm, &r, &w); break;
            case KB_SETCC:
            case KB_SEL:
                r += 4 + ((int) x->imm < KB_C_A64 && x->imm >> 1 == 5);
                w += 1;
                break;
            case KB_BR:
                r += 4 + ((int) x->imm < KB_C_A64 && x->imm >> 1 == 5);
                break;
            case KB_BRZ: r += 1; break;
            case KB_CCMP:
                r += 5;
                w += 5;
                break;
            case KB_CARRY:
            case KB_TPIDR:
            case KB_FSBASE:
                r += 1;
                w += 1;
                break;
            case KB_SETTP: w += 1; break;
            case KB_PC:
                r += 1;
                w += 1;
                break;
            case KB_SYSCALL:
                r += 2;
                w += 1;
                break;
            case KB_X86MD:
                r += 2;
                w += x->imm < 6 ? 4 : 2;
                break;
            case KB_X86SHD:
                r += 1;
                w += 6;
                break;
            case KB_X86FLAGS:
                if (x->imm == 0)
                    r += 6, w += 1;
                else if (x->imm == 1)
                    r += 1, w += 6;
                else
                    w += 1 + (x->imm == 2), r += x->imm == 2;
                break;
            case KB_POPCNT:
            case KB_BSWAP:
            case KB_CLZ:
            case KB_CTZ: w += 1; break;
            default:
                if (x->op <= KB_SEXT) w += 1;
                break;
        }
        *rd += r;
        *wr += w;
    }
}
#endif

/* decodes and plans the code at b->pc into b; nonzero when there is none */
static int translate(struct kb_cpu* cpu, struct kb_block* b) {
    b->codegen = cpu->codegen;
    int bad = cpu->arch == KB_X86   ? kb_x86_block(cpu, b)
              : cpu->arch == KB_A64 ? kb_a64_block(cpu, b)
                                    : kb_wasm_block(cpu, b);
    int prim = !bad && cpu->arch != KB_WASM ? kb_prim_at(cpu, b->pc) : 0;
    if (prim) {
        void* p = realloc(b->ins, ((size_t) b->n + 1) * sizeof *b->ins);
        if (!p) bad = 1;
        if (p) {
            b->ins = p;
            memmove(b->ins + 1, b->ins, (size_t) b->n * sizeof *b->ins);
            b->ins[0] = (struct kb_ins){KB_PRIM, 8, 0, 0, 0, prim};
            b->n++;
        }
    }
    if (!bad && !cpu->noplan) plan_flags(cpu, b);
    if (!bad && !cpu->noplan) plan_demand(cpu, b);
    if (!bad && !cpu->noplan) plan_mem(cpu, b);
    for (int i = 0; !bad && i < b->n; i++)
        if (b->ins[i].a == KB_ZERO && writes_a(&b->ins[i]))
            b->ins[i].a = KB_SINK;
#ifdef KB_COUNT
    for (int i = 0; !bad && i < b->n; i++) b->insns += b->ins[i].op == KB_PC;
#endif
    if (!bad) bad = lean_pcs(cpu, b);
    if (!bad && b->n) {
        /* the decoder's buffer doubled from 64 ops; keep what is used */
        void* p = realloc(b->ins, (size_t) b->n * sizeof *b->ins);
        if (p) b->ins = p;
        if (b->pcs && (p = realloc(b->pcs, (size_t) b->n * sizeof *b->pcs)))
            b->pcs = p;
    }
    if (!bad) bad = kb_block_ready(cpu, b);
    if (bad) {
        free(b->ins);
        free(b->pcs);
        b->ins = NULL;
        b->pcs = NULL;
        return 1;
    }
    cpu->decoded++;
    return 0;
}

static void cold_caches(struct kb_block* b) {
    for (int i = 0; i < b->nic; i++)
        b->ic[i] = (struct kb_ic){0, KB_IC_COLD, NULL, 0};
}

/** a block's run-time parts from its ops: the inline caches (one per access
 * and KB_RESOLVE) and a lifted region; nonzero when out of memory */
int kb_block_ready(struct kb_cpu* cpu, struct kb_block* b) {
#ifdef KB_COUNT
    traffic(b, &b->rd, &b->wr);
#endif
    int mem = 0;
    for (int i = 0; i < b->n; i++)
        mem += is_access(b->ins[i].op) || b->ins[i].op == KB_RESOLVE;
    if (mem && !(b->ic = calloc((size_t) mem, sizeof *b->ic))) return 1;
    b->nic = mem;
    cold_caches(b);
#ifdef KB_AOT
    if (!cpu->trace && !cpu->tracing) kb_aot_attach(cpu, b);
#else
    (void) cpu;
#endif
    return 0;
}

#ifdef KB_AOT
/* a region moves between its blocks by direct edges, which the guard that
 * finds old code never sees: when the code generation moves, each block
 * leaves its region until it has been through the guard again */
void kb_aot_stale(struct kb_cpu* cpu) {
    for (int h = 0; h < 4096; h++)
        for (struct kb_block* b = cpu->cache[h]; b; b = b->chain)
            if (b->aot) kb_aot_detach(b);
}
#endif

/* b emptied for its code to be decoded again: pc and its place in the cache
 * stay, so blocks linked to it stay linked */
static void reset(struct kb_block* b) {
#ifdef KB_AOT
    if (b->aot) kb_aot_detach(b);
#endif
    free(b->ins);
    free(b->pcs);
    free(b->ic);
    free(b->seg);
#ifdef KB_HOT
    free(b->exits);
#endif
    struct kb_block keep = {.pc = b->pc, .chain = b->chain};
    *b = keep;
}

KB_NOINLINE static struct kb_block* block(struct kb_cpu* cpu, uint64_t pc) {
    cpu->lookups++;
    unsigned h = (unsigned) ((pc >> 2) ^ (pc >> 14)) & 4095u;
    for (struct kb_block* b = cpu->cache[h]; b; b = b->chain) {
        if (b->pc != pc) continue;
        if (b->codegen == cpu->codegen) return b;
        /* the code under it was unmapped or changed protection since */
        reset(b);
        if (translate(cpu, b)) {
            b->codegen = cpu->codegen - 1;
            return NULL;
        }
        return b;
    }
    struct kb_block* b = calloc(1, sizeof *b);
    b->pc = pc;
    if (!kb_persist_take(cpu, b) && translate(cpu, b)) {
        free(b->seg);
        free(b);
        return NULL;
    }
    b->chain = cpu->cache[h];
    cpu->cache[h] = b;
    return b;
}

#if KB_TRACE > 1
/* K6f: a hot block decoded again in place as a trace; one with no biased
 * branch to follow stays as it was */
static void retrace(struct kb_cpu* cpu, struct kb_block* b) {
    b->traced = 1;
    if (cpu->arch == KB_WASM || cpu->trace) return;
    #ifdef KB_AOT
    /* a promoted block keeps the IR its region was lifted from */
    if (b->aot) return;
    #endif
    struct kb_block t = {.pc = b->pc};
    cpu->tracing = 1;
    int bad = translate(cpu, &t), exits = 0;
    cpu->tracing = 0;
    for (int i = 0; !bad && i < t.n; i++) exits += t.ins[i].op == KB_EXIT;
    if (bad || !exits) {
        free(t.ins);
        free(t.pcs);
        free(t.ic);
        free(t.seg);
        return;
    }
    struct kb_block* chain = b->chain;
    reset(b);
    *b = t;
    b->chain = chain;
    b->traced = 1;
    cpu->traces++;
    #ifdef KB_AOT
    if (!cpu->trace) kb_aot_attach(cpu, b);
    #endif
}
#endif

/* K16: the block cpu->pc names, through prev's cached successor when prev
 * ended there; a successor of an older code generation is looked up again */
static struct kb_block* next_block(struct kb_cpu* cpu, struct kb_block* prev) {
#if !KB_CHAIN
    (void) prev;
    return block(cpu, cpu->pc);
#endif
    (void) KB_CK(ck_link);
    struct kb_block** link = !prev                     ? NULL
                             : cpu->pc == prev->target ? &prev->to_target
                             : cpu->pc == prev->next   ? &prev->to_next
                                                       : NULL;
    if (!link) return block(cpu, cpu->pc);
#if KB_EPOCH
    /* a successor of an older code generation is found by kb_run's guard */
    if (!*link) *link = block(cpu, cpu->pc);
#else
    if (!*link || KB_CK(ck_code) || (*link)->codegen != cpu->codegen)
        *link = block(cpu, cpu->pc);
#endif
    return *link;
}

#ifdef KB_HOT
void kb_hot_dump(struct kb_cpu* cpu) {
    const char* dir = getenv("KATYBUG_HOT");
    if (!dir) return;
    char path[4096];
    snprintf(path, sizeof path, "%s/%ld.hot", dir, (long) getpid());
    FILE* f = fopen(path, "w");
    if (!f) return;
    fprintf(f, "arch %d\n", cpu->arch);
    for (int h = 0; h < 4096; h++)
        for (struct kb_block* b = cpu->cache[h]; b; b = b->chain) {
            if (!b->runs) continue;
            fprintf(
                f, "block %llx %llx %llx %d %llu\n", (unsigned long long) b->pc,
                (unsigned long long) b->next, (unsigned long long) b->target,
                b->n, (unsigned long long) b->runs
            );
            for (int i = 0; i < b->n; i++)
                fprintf(
                    f, "%d %d %d %d %d %lld\n", b->ins[i].op, b->ins[i].w,
                    b->ins[i].a, b->ins[i].b, b->ins[i].c,
                    (long long) b->ins[i].imm
                );
            if (b->exits) {
                fprintf(f, "exits");
                for (int i = 0; i < b->n; i++)
                    if (b->exits[i])
                        fprintf(
                            f, " %d:%llu", i, (unsigned long long) b->exits[i]
                        );
                fprintf(f, "\n");
            }
            if (b->pcs) {
                fprintf(f, "pcs");
                for (int i = 0; i < b->n; i++)
                    fprintf(f, " %u", (unsigned) b->pcs[i]);
                fprintf(f, "\n");
            }
        }
    fclose(f);
}
#endif

/* a load or store translated once per mapping, not per access; kb_load_ic
 * refills a cache that misses. With epochs the block has already seen the
 * mapping generation (guard in kb_run), so the range is all that is left */
#if KB_EPOCH
    #define IC_MISS(cpu, ic, va, w)                                            \
        (KB_CK(ck_range) || (va) - (ic)->lo >= (ic)->span - KB_IC_COLD)
#else
    #define IC_MISS(cpu, ic, va, w)                                            \
        (KB_CK(ck_gen) || (ic)->gen != (cpu)->mapgen || KB_CK(ck_range) ||     \
         (va) - (ic)->lo > (ic)->span - (uint64_t) (w))
#endif

KB_NOINLINE static inline uint64_t load(
    struct kb_cpu* cpu, struct kb_ic* ic, uint64_t va, int w
) {
    if (IC_MISS(cpu, ic, va, w)) return kb_load_ic(cpu, ic, va, w);
    uint64_t v = 0;
    memcpy(&v, ic->host + (va - ic->lo), (size_t) w);
    return v;
}

KB_NOINLINE static inline void store(
    struct kb_cpu* cpu, struct kb_ic* ic, uint64_t va, uint64_t v, int w
) {
    if (IC_MISS(cpu, ic, va, w))
        kb_store_ic(cpu, ic, va, v, w);
    else
        memcpy(ic->host + (va - ic->lo), &v, (size_t) w);
}

/* an op's b and c registers, read only in the cases that use them */
#define B (r[x->b])
#define C (r[x->c])
/* a fault in op i leaves the block at its start, and names the instruction from
 * the side table (a trace's KB_PC ops name it as they run) */
#define FAULTED()                                                              \
    ((blk->pcs                                                                 \
          ? (void) (cpu->ipc =                                                 \
                        blk->pc + (uint64_t) (int64_t) (int32_t) blk->pcs[i])  \
          : (void) 0),                                                         \
     blk->pc)
/* only the ops that can raise a fault check for one after them */
#define CHECK()                                                                \
    if (KB_CK(ck_fault) || cpu->fault) return FAULTED()

/* runs one block; returns the next pc. The memory plan's groups are for lifted
 * code: the interpreter skips the leading KB_RESOLVE ops and checks each access
 * itself (measured: using the groups here cost 2-3%, skipping them nothing) */
static uint64_t step(struct kb_cpu* cpu, struct kb_block* blk) {
    uint64_t* r = cpu->r;
    struct kb_ic* ic = blk->ic + blk->resolves; /* the next load or store's; ops
                                                   never jump inside a block */
    for (int i = blk->resolves; i < blk->n; i++) {
        struct kb_ins* x = &blk->ins[i];
        switch (x->op) {
            case KB_MOVI: r[x->a] = (uint64_t) x->imm; break;
            case KB_MOV: r[x->a] = B; break;
            case KB_ADD: r[x->a] = B + C; break;
            case KB_SUB: r[x->a] = B - C; break;
            case KB_AND: r[x->a] = B & C; break;
            case KB_OR: r[x->a] = B | C; break;
            case KB_XOR: r[x->a] = B ^ C; break;
            case KB_SHL: r[x->a] = C >= 64 ? 0 : B << C; break;
            case KB_SHR: r[x->a] = C >= 64 ? 0 : B >> C; break;
            case KB_SAR:
                r[x->a] = (uint64_t) ((int64_t) B >> (C >= 64 ? 63 : C));
                break;
            case KB_ROR: {
                int bits = 8 * x->w;
                uint64_t v = B & mask(x->w), n = C % (uint64_t) bits;
                r[x->a] = n ? ((v >> n) | (v << (bits - n))) & mask(x->w) : v;
                break;
            }
            case KB_MUL: r[x->a] = B * C; break;
            case KB_UMULH: r[x->a] = kb_umulh(B, C); break;
            case KB_SMULH: r[x->a] = kb_smulh(B, C); break;
            case KB_UDIV: r[x->a] = C ? B / C : 0; break;
            case KB_SDIV:
                r[x->a] = C ? ((int64_t) B == INT64_MIN && (int64_t) C == -1
                                   ? B
                                   : (uint64_t) ((int64_t) B / (int64_t) C))
                            : 0;
                break;
            case KB_UREM: r[x->a] = C ? B % C : B; break;
            case KB_SREM:
                r[x->a] = C ? ((int64_t) C == -1
                                   ? 0
                                   : (uint64_t) ((int64_t) B % (int64_t) C))
                            : B;
                break;
            case KB_ZEXT: r[x->a] = B & mask(x->w); break;
            case KB_SEXT: r[x->a] = (uint64_t) sext(B, x->w); break;
            case KB_INS: {
                uint64_t m = mask(x->w) << x->imm;
                r[x->a] = (r[x->a] & ~m) | ((B << x->imm) & m);
                break;
            }
            case KB_LD:
                r[x->a] = load(cpu, ic++, B + (uint64_t) x->imm, x->w);
                CHECK();
                break;
            case KB_LDS:
                r[x->a] = (uint64_t) sext(
                    load(cpu, ic++, B + (uint64_t) x->imm, x->w), x->w
                );
                CHECK();
                break;
            case KB_ST:
                store(cpu, ic++, B + (uint64_t) x->imm, r[x->a], x->w);
                CHECK();
                break;
            case KB_FLAGS:
#if KB_LAZY
                if (lazy_kind((int) x->imm)) {
                    cpu->lz = (int) x->imm + 1;
                    cpu->lz_w = x->w;
                    cpu->lz_b = B, cpu->lz_c = C, cpu->lz_r = r[x->a];
                    break;
                }
                KB_SYNC(cpu);
#endif
                flags(cpu, (int) x->imm, B, C, r[x->a], x->w);
                break;
            case KB_SETCC:
                r[x->a] = (uint64_t) kb_cond(cpu, (int) x->imm);
                break;
            case KB_SEL: r[x->a] = kb_cond(cpu, (int) x->imm) ? B : C; break;
            case KB_BR:
                if (kb_cond(cpu, (int) x->imm)) return blk->target;
                break;
            case KB_EXIT:
                if (KB_CK(exits) ||
                    (x->imm & 0x100 ? (r[x->a] == 0) == !(x->imm & 1)
                                    : kb_cond(cpu, (int) (x->imm & 0xff)))) {
                    cpu->trace_exits++;
#ifdef KB_HOT
                    if (!blk->exits)
                        blk->exits =
                            calloc((size_t) blk->n, sizeof *blk->exits);
                    if (blk->exits) blk->exits[i]++;
#endif
                    cpu->plan_ops_ran -=
                        (uint64_t) (blk->n - 1 - i); /* not run */
                    return blk->pc +
                           (uint64_t) (int64_t) (int32_t) (x->imm >> 16);
                }
                break;
            case KB_JMP: (void) KB_CK(ijmp); return B;
            case KB_SYSCALL:
                cpu->pc = blk->next;
                kb_syscall(cpu);
                if (cpu->exited) return 0;
#if KB_EPOCH
                /* a block that goes on past its syscall must not read caches
                 * from before it */
                if (blk->mapgen != cpu->mapgen) {
                    cold_caches(blk);
                    blk->mapgen = cpu->mapgen;
                }
#endif
                if (cpu->sigreturned) {
                    cpu->sigreturned = 0;
                    return cpu->pc;
                }
                CHECK();
                break;
            case KB_TRAP:
                cpu->fault = "unknown instruction";
                cpu->fault_sig = 4;
                return FAULTED();
            case KB_PC:
                cpu->ipc = (uint64_t) x->imm;
                if (cpu->trace)
                    fprintf(
                        cpu->trace, "%llx\n", (unsigned long long) cpu->ipc
                    );
                break;
            case KB_X86FLAGS:
                KB_SYNC(cpu);
                switch (x->imm) {
                    case 0:
                        r[x->a] = 0x202 | (uint64_t) cpu->c |
                                  ((uint64_t) cpu->p << 2) |
                                  ((uint64_t) cpu->z << 6) |
                                  ((uint64_t) cpu->n << 7) |
                                  ((uint64_t) cpu->df << 10) |
                                  ((uint64_t) cpu->v << 11);
                        break;
                    case 1: {
                        uint64_t f = r[x->a];
                        cpu->c = (int) (f & 1);
                        cpu->p = (int) ((f >> 2) & 1);
                        cpu->z = (int) ((f >> 6) & 1);
                        cpu->n = (int) ((f >> 7) & 1);
                        cpu->v = (int) ((f >> 11) & 1);
                        cpu->df = (int) ((f >> 10) & 1);
                        break;
                    }
                    case 2: cpu->c = !cpu->c; break;
                    case 3: cpu->c = 0; break;
                    case 4: cpu->c = 1; break;
                    case 5: cpu->df = 0; break;
                    default: cpu->df = 1; break;
                }
                break;
            case KB_X86SHD: {
                KB_SYNC(cpu);
                int bits = 8 * x->w;
                uint64_t m = mask(x->w), v = r[x->a] & m, in = B & m, n = C;
                if (!n) break;
                uint64_t out, cf;
                if (x->imm == 0) {
                    out = n == (uint64_t) bits
                              ? in
                              : ((v << n) | (in >> (bits - n))) & m;
                    cf = (v >> (bits - n)) & 1;
                }
                else {
                    out = ((v >> n) | (in << (bits - n))) & m;
                    cf = (v >> (n - 1)) & 1;
                }
                r[x->a] = out;
                flags(cpu, KB_F_LOGIC, out, out, out, x->w);
                cpu->c = (int) cf;
                break;
            }
            case KB_X87:
                KB_SYNC(cpu);
                if (kb_x87(cpu, x) && !cpu->fault) {
                    cpu->fault = "unknown x87 instruction";
                    cpu->fault_sig = 4;
                }
                CHECK();
                break;
            case KB_SSE:
                KB_SYNC(cpu);
                if (kb_sse(cpu, x) && !cpu->fault) {
                    cpu->fault = "unknown sse instruction";
                    cpu->fault_sig = 4;
                }
                CHECK();
                break;
            case KB_A64V:
                KB_SYNC(cpu);
                if (kb_a64v(cpu, x) && !cpu->fault) {
                    cpu->fault = "unknown instruction";
                    cpu->fault_sig = 4;
                }
                CHECK();
                break;
            case KB_CARRY:
                KB_SYNC(cpu);
                r[x->a] = (uint64_t) cpu->c;
                break;
            case KB_BSWAP: {
                uint64_t v = __builtin_bswap64(B);
                r[x->a] = v >> (64 - 8 * x->w);
                break;
            }
            case KB_CLZ: {
                uint64_t v = B & mask(x->w);
                r[x->a] = v ? (uint64_t) (__builtin_clzll(v) - (64 - 8 * x->w))
                            : (uint64_t) (8 * x->w);
                break;
            }
            case KB_CTZ: {
                uint64_t v = B & mask(x->w);
                r[x->a] =
                    v ? (uint64_t) __builtin_ctzll(v) : (uint64_t) (8 * x->w);
                break;
            }
            case KB_POPCNT:
                r[x->a] = (uint64_t) __builtin_popcountll(B & mask(x->w));
                break;
            case KB_WTRAP:
                cpu->fault = kb_wasm_traps[x->imm];
                cpu->fault_sig = 4;
                return FAULTED();
            case KB_WEXIT: cpu->exited = 1; return 0;
            case KB_TPIDR: r[x->a] = cpu->tpidr; break;
            case KB_NZCV:
                KB_SYNC(cpu);
                r[x->a] = (uint64_t) (cpu->n << 31 | cpu->z << 30 |
                                      cpu->c << 29 | cpu->v << 28) &
                          0xf0000000u;
                break;
            case KB_CLOCK: {
                struct timespec ts;
                clock_gettime(CLOCK_MONOTONIC, &ts);
                r[x->a] = (uint64_t) ts.tv_sec * 1000000000ull +
                          (uint64_t) ts.tv_nsec;
                break;
            }
            case KB_EXCL:
                if (!x->imm || x->imm == 3) {
                    cpu->excl = x->imm ? ~0ull : kb_switches;
                    break;
                }
                {
                    /* a switch or a signal since the ldxr clears the monitor */
                    int held = cpu->excl == kb_switches;
                    cpu->excl = ~0ull;
                    if (held) {
                        kb_store(cpu, B, C, x->w);
                        if ((x->imm & 0xff) == 2)
                            kb_store(
                                cpu, B + (uint64_t) x->w, r[x->imm >> 8], x->w
                            );
                        CHECK();
                    }
                    r[x->a] = !held;
                }
                break;
            case KB_CPUID: {
                /* the x86-64 baseline as qemu64 reports it (glibc reads leaf 1
                 * only for a vendor it knows); mmx is claimed but faults if run
                 */
                uint32_t leaf = (uint32_t) r[0], v[4] = {0, 0, 0, 0};
                (void) KB_CK(rd_cpuid);
                if (leaf == 0) {
                    v[0] = 1;
                    memcpy(&v[1], "Auth", 4);
                    memcpy(&v[3], "enti", 4);
                    memcpy(&v[2], "cAMD", 4);
                }
                else if (leaf == 1) {
                    v[0] = 0x00060fb1; /* family 15, model 107, stepping 1 */
                    v[1] = 0x00010800; /* one logical cpu, 64-byte clflush */
                    v[3] = 1u | 1u << 4 | 1u << 8 | 1u << 15 | 1u << 23 |
                           1u << 24 | 1u << 25 | 1u << 26;
                }
                else if (leaf == 0x80000000)
                    v[0] = 0x80000001;
                else if (leaf == 0x80000001)
                    v[3] = 1u << 11 | 1u << 29;
                r[0] = v[0];
                r[3] = v[1];
                r[1] = v[2];
                r[2] = v[3];
                break;
            }
            case KB_CRC32: {
                /* the reflected polynomials, bit by bit */
                uint32_t crc = (uint32_t) B,
                         poly = x->imm ? 0x82f63b78u : 0xedb88320u;
                uint64_t v = C;
                for (int k = 0; k < 8 * x->w; k++, v >>= 1)
                    crc = ((crc ^ (uint32_t) (v & 1)) & 1) ? (crc >> 1) ^ poly
                                                           : crc >> 1;
                r[x->a] = crc;
                break;
            }
            case KB_FSBASE:
                (void) KB_CK(rd_fs);
                r[x->a] = cpu->fs;
                break;
            case KB_SETTP: cpu->tpidr = B; break;
            case KB_BRZ:
                if ((r[x->a] != 0) == (x->imm != 0)) return blk->target;
                break;
            case KB_CCMP: {
                KB_SYNC(cpu);
                int cond = (int) (x->imm & 15),
                    nzcv = (int) ((x->imm >> 4) & 15);
                uint64_t a = r[x->a];
                if (kb_cond(cpu, KB_C_A64 + cond)) {
                    int add = (int) ((x->imm >> 8) & 1);
                    uint64_t bb = B;
                    flags(
                        cpu, add ? KB_F_A_ADD : KB_F_A_SUB, a, bb,
                        add ? a + bb : a - bb, x->w
                    );
                }
                else
                    flags(cpu, KB_F_NZCV, 0, (uint64_t) nzcv << 28, 0, x->w);
                break;
            }
            case KB_X86MD:
                KB_SYNC(cpu);
                if (muldiv(cpu, (int) x->imm, x->w, B)) return FAULTED();
                break;
            case KB_X86STR:
                string(cpu, (int) x->imm, x->w, x->c);
                CHECK();
                break;
            case KB_PRIM: {
                uint64_t ret;
                if (kb_prim(cpu, (int) x->imm, &ret) == 1) return ret;
                break;
            }
        }
    }
    return blk->next;
}

#ifdef KB_COUNT
/* mapping checks a run of the block makes: every access when interpreted;
 * lifted, the accesses outside a group and each KB_RESOLVE */
static int mem_ops(const struct kb_block* b) {
    int mem = 0, lifted = 0;
    #ifdef KB_AOT
    lifted = b->aot != NULL;
    #endif
    for (int i = 0; i < b->n; i++)
        mem += lifted ? (is_access(b->ins[i].op) && !b->ins[i].c) ||
                            b->ins[i].op == KB_RESOLVE
                      : is_access(b->ins[i].op);
    return mem;
}

static int distinct_maps(const struct kb_block* b, uint64_t* seen, int n) {
    int slots = 0;
    for (int i = 0; i < b->n; i++)
        slots += is_access(b->ins[i].op) || b->ins[i].op == KB_RESOLVE;
    for (int k = 0; k < slots; k++) {
        if (!b->ic[k].host) continue;
        int j = 0;
        while (j < n && seen[j] != b->ic[k].lo) j++;
        if (j == n && n < 64) seen[n++] = b->ic[k].lo;
    }
    return n;
}

/* one line per process: guest instructions, cpu words read and written,
 * mapping checks and refills, the mappings a block's (and a lifted region's)
 * accesses fall in, weighted by runs */
void kb_count_report(struct kb_cpu* cpu) {
    uint64_t insns = 0, blocks = 0, checks = 0, maps = 0, lifted = 0,
             lchecks = 0;
    for (int h = 0; h < 4096; h++)
        for (struct kb_block* b = cpu->cache[h]; b; b = b->chain) {
            if (!b->runs) continue;
            uint64_t seen[64];
            int mem = mem_ops(b);
            insns += b->runs * (uint64_t) b->insns;
            blocks += b->runs;
            checks += b->runs * (uint64_t) mem;
            maps += b->runs * (uint64_t) distinct_maps(b, seen, 0);
    #ifdef KB_AOT
            if (b->aot) {
                lifted += b->runs * (uint64_t) b->insns;
                lchecks += b->runs * (uint64_t) mem;
            }
    #endif
        }
    /* a region's mappings: the union over its blocks */
    uint64_t rmaps = 0, regions = 0;
    #ifdef KB_AOT
    for (int h = 0; h < 4096; h++)
        for (struct kb_block* b = cpu->cache[h]; b; b = b->chain) {
            if (!b->aot || !b->runs) continue;
            struct kb_block* rep = NULL;
            for (int g = 0; g < 4096 && !rep; g++)
                for (struct kb_block* o = cpu->cache[g]; o && !rep;
                     o = o->chain)
                    if (o->aot == b->aot && o->runs) rep = o;
            if (rep != b) continue;
            regions++;
            uint64_t seen[64];
            int n = 0;
            for (int g = 0; g < 4096; g++)
                for (struct kb_block* o = cpu->cache[g]; o; o = o->chain)
                    if (o->aot == b->aot && o->runs)
                        n = distinct_maps(o, seen, n);
            rmaps += (uint64_t) n;
        }
    #endif
    /* a file, not stderr: coreutils closes its stderr on the way out */
    FILE* f = fopen(getenv("KATYBUG_COUNT"), "a");
    if (!f) return;
    fprintf(
        f,
        "katybug count: insns %llu blocks %llu rd %llu wr %llu checks %llu "
        "refills %llu blockmaps %llu lifted %llu lchecks %llu entries %llu "
        "regionmaps %llu regions %llu signals %llu latsum %llu latmax %llu",
        (unsigned long long) insns, (unsigned long long) blocks,
        (unsigned long long) kb_count.rd, (unsigned long long) kb_count.wr,
        (unsigned long long) checks, (unsigned long long) kb_count.refills,
        (unsigned long long) maps, (unsigned long long) lifted,
        (unsigned long long) lchecks, (unsigned long long) kb_count.entries,
        (unsigned long long) rmaps, (unsigned long long) regions,
        (unsigned long long) kb_count.lat_n,
        (unsigned long long) kb_count.lat_sum,
        (unsigned long long) kb_count.lat_max
    );
    for (int c = 0; c < 10; c++)
        fprintf(
            f, " c%drd %llu c%dwr %llu", c,
            (unsigned long long) kb_count.cat[c][0], c,
            (unsigned long long) kb_count.cat[c][1]
        );
    fprintf(
        f,
        " ck_gen %llu ck_range %llu ck_code %llu ck_poll %llu ck_thread %llu "
        "ck_fault %llu ck_link %llu ck_exit %llu ck_epoch %llu deopt_map %llu "
        "deopt_code %llu polls %llu rd_fs %llu rd_cpuid %llu ijmp %llu "
        "exits %llu bump_map %llu bump_sig %llu lookups %llu",
        (unsigned long long) kb_count.ck_gen,
        (unsigned long long) kb_count.ck_range,
        (unsigned long long) kb_count.ck_code,
        (unsigned long long) kb_count.ck_poll,
        (unsigned long long) kb_count.ck_thread,
        (unsigned long long) kb_count.ck_fault,
        (unsigned long long) kb_count.ck_link,
        (unsigned long long) kb_count.ck_exit,
        (unsigned long long) kb_count.ck_epoch,
        (unsigned long long) kb_count.deopt_map,
        (unsigned long long) kb_count.deopt_code,
        (unsigned long long) kb_count.polls,
        (unsigned long long) kb_count.rd_fs,
        (unsigned long long) kb_count.rd_cpuid,
        (unsigned long long) kb_count.ijmp, (unsigned long long) kb_count.exits,
        (unsigned long long) kb_count.bump_map,
        (unsigned long long) kb_count.bump_sig,
        (unsigned long long) cpu->lookups
    );
    fprintf(f, "\n");
    fprintf(f, "katybug syscalls:");
    for (int nr = 0; nr < 512; nr++)
        if (kb_count.sys[nr])
            fprintf(f, " %d=%llu", nr, (unsigned long long) kb_count.sys[nr]);
    fprintf(f, "\n");
    fclose(f);
}
#endif

/** runs the guest until it exits; the exit status (128 + a signal when one
 * ended it) */
int kb_run(struct kb_cpu* cpu) {
#if KB_POLL == 3
    int fuel = 0;
#endif
    int slice = 0;
    struct kb_block* prev = NULL;
    while (KB_CK(ck_exit) || !cpu->exited) {
        struct kb_block* b = next_block(cpu, prev);
        prev = b;
#if KB_EPOCH
        if (b && (KB_CK(ck_epoch) || b->epoch != kb_epoch)) {
            /* read before the checks: a bump during them is seen next time */
            uint32_t e = kb_epoch;
            uint64_t pc = cpu->pc;
            (void) KB_CK(polls);
            kb_signals(cpu);
            if (cpu->exited) break;
            if (cpu->pc != pc) {
                prev = NULL; /* a handler's frame: another block */
                continue;
            }
            if (b->codegen != cpu->codegen) {
                (void) KB_CK(deopt_code);
                reset(b);
                if (translate(cpu, b)) {
                    b->codegen = cpu->codegen - 1;
                    b = prev = NULL;
                }
            }
            if (b && b->mapgen != cpu->mapgen) {
                (void) KB_CK(deopt_map);
                cold_caches(b);
                b->mapgen = cpu->mapgen;
            }
            if (b) b->epoch = e;
        }
#endif
        if (!b) {
            /* no instruction here at all: the jump itself faulted */
            cpu->fault = "jump outside the address space";
            if (kb_bus(cpu->pc) ? kb_fault(cpu, 7, 2, cpu->pc)
                                : kb_fault(cpu, 11, 1, cpu->pc))
                continue;
            break;
        }
        cpu->ipc = b->pc;
#ifdef KB_HOT
        b->runs++;
#endif
#ifdef KB_COUNT
    #ifdef KB_AOT
        if (b->aot)
            kb_count.entries++; /* the region counts its own blocks */
        else
    #endif
        {
            b->runs++;
            kb_count.rd += (uint64_t) b->rd;
            kb_count.wr += (uint64_t) b->wr;
        }
#endif
#ifdef KB_AOT
        if (b->aot) KB_SYNC(cpu); /* lifted code keeps the flag bits itself */
        uint64_t next = b->aot ? b->aot(cpu, b->pc) : step(cpu, b);
#else
        uint64_t next = step(cpu, b);
#endif
        cpu->steps++;
        cpu->plan_flags_run += b->dropped;
        cpu->plan_flags_ran += b->flag_writes;
        cpu->plan_ops_run += b->pruned;
        cpu->plan_ops_ran += (uint64_t) (b->n + b->pruned);
        if (cpu->exited) break;
        /* a wasm trap ends the call; there is no guest signal to deliver */
        if (cpu->fault && cpu->arch == KB_WASM) break;
        if (cpu->fault) {
            static const int codes[12] = {0, 0, 0, 0, 1, 0, 0, 2, 1, 0, 0, 1};
            int s = cpu->fault_sig ? cpu->fault_sig : 11;
            /* the context resumes at the faulting instruction */
            cpu->pc = cpu->ipc;
            const char* why = cpu->fault;
            cpu->fault_sig = 0;
            cpu->fault = NULL;
            cpu->last_fault = why;
            if (!kb_fault(
                    cpu, s, codes[s],
                    s == 11 || s == 7 ? cpu->fault_addr : cpu->ipc
                )) {
                cpu->fault = why;
                break;
            }
            continue;
        }
        cpu->pc = next;
#if KB_TRACE > 1
        if (next == b->target)
            b->taken++;
        else if (next == b->next)
            b->fall++;
        if (!b->traced && b->taken + b->fall >= KB_TRACE_AT) retrace(cpu, b);
#endif
#if KB_EPOCH
        /* signals are looked for in the next block's guard */
#elif KB_POLL == 1
        if (next <= b->pc) {
            (void) KB_CK(polls);
            kb_signals(cpu);
        }
#elif KB_POLL == 2
        if (KB_CK(ck_poll) || next <= b->pc || kb_syscalled) {
            kb_syscalled = 0;
            (void) KB_CK(polls);
            kb_signals(cpu);
        }
#elif KB_POLL == 3
        if (++fuel == KB_POLL_FUEL) {
            fuel = 0;
            kb_signals(cpu);
        }
#else
        kb_signals(cpu);
#endif
        if (KB_CK(ck_thread) ||
            (kb_nthreads > 1 && next <= b->pc && ++slice >= KB_SLICE)) {
            slice = 0;
            kb_yield(cpu);
        }
    }
    return cpu->status;
}
