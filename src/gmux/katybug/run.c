#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "kb.h"

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

int kb_cond(struct kb_cpu* cpu, int cond) {
    int n = cpu->n, z = cpu->z, c = cpu->c, v = cpu->v;
    if (cond < KB_C_A64) {
        int r;
        switch (cond >> 1) {
            case 0: r = v; break;
            case 1: r = c; break;
            case 2: r = z; break;
            case 3: r = c || z; break;
            case 4: r = n; break;
            case 5: r = cpu->p; break;
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

/* x86 mul, imul, div and idiv of rdx:rax (ax for bytes) by v; 1 on a divide
 * error */
static int muldiv(struct kb_cpu* cpu, int kind, int w, uint64_t v) {
    uint64_t* r = cpu->r;
    int bits = 8 * w;
    uint64_t m = mask(w);
    if (kind == 4 || kind == 5) {
        unsigned __int128 p;
        int ov;
        if (kind == 4) {
            p = (unsigned __int128) (r[0] & m) * (v & m);
            ov = (p >> bits) != 0;
        }
        else {
            __int128 q = (__int128) sext(r[0], w) * sext(v, w);
            p = (unsigned __int128) q;
            ov = q != (__int128) sext((uint64_t) q, w);
        }
        uint64_t lo = (uint64_t) p & m, hi = (uint64_t) (p >> bits) & m;
        if (w == 1)
            r[0] = (r[0] & ~0xffffull) | ((hi << 8) | lo);
        else if (w == 2) {
            r[0] = (r[0] & ~0xffffull) | lo;
            r[2] = (r[2] & ~0xffffull) | hi;
        }
        else {
            r[0] = lo;
            r[2] = hi;
        }
        cpu->c = cpu->v = ov;
        return 0;
    }
    if ((v & m) == 0) {
        cpu->fault = "divide error";
        cpu->fault_sig = 8;
        return 1;
    }
    unsigned __int128 n;
    if (w == 1)
        n = r[0] & 0xffff;
    else
        n = ((unsigned __int128) (r[2] & m) << bits) | (r[0] & m);
    uint64_t q, rem;
    if (kind == 6) {
        unsigned __int128 qq = n / (v & m);
        if (qq > m) {
            cpu->fault = "divide error";
            cpu->fault_sig = 8;
            return 1;
        }
        q = (uint64_t) qq;
        rem = (uint64_t) (n % (v & m));
    }
    else {
        __int128 sn =
            w == 1 ? (__int128) (int16_t) n
                   : (__int128) (n << (128 - 2 * bits)) >> (128 - 2 * bits);
        __int128 d = sext(v, w), qq = sn / d;
        if (qq != (__int128) sext((uint64_t) qq, w)) {
            cpu->fault = "divide error";
            cpu->fault_sig = 8;
            return 1;
        }
        q = (uint64_t) qq & m;
        rem = (uint64_t) (sn % d) & m;
    }
    if (w == 1)
        r[0] = (r[0] & ~0xffffull) | (rem << 8) | q;
    else if (w == 2) {
        r[0] = (r[0] & ~0xffffull) | q;
        r[2] = (r[2] & ~0xffffull) | rem;
    }
    else {
        r[0] = q;
        r[2] = rem;
    }
    return 0;
}

/* x86 movs and stos, down when the direction flag is set (memmove copies
 * backward that way) */
static void string(struct kb_cpu* cpu, int stos, int w, int rep) {
    uint64_t* r = cpu->r;
    uint64_t n = rep ? r[1] : 1;
    for (; n; n--) {
        uint64_t v = stos ? r[0] : kb_load(cpu, r[6], w);
        kb_store(cpu, r[7], v, w);
        if (cpu->fault) return;
        uint64_t step = cpu->df ? (uint64_t) -(int64_t) w : (uint64_t) w;
        r[7] += step;
        if (!stos) r[6] += step;
        if (rep) r[1]--;
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

/* ops that neither read flags nor can fault */
static int transparent(int op) {
    return op <= KB_INS || op == KB_BSWAP || op == KB_CLZ || op == KB_CTZ ||
           op == KB_TPIDR || op == KB_FSBASE || op == KB_PC;
}

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
        else if (!transparent(x->op))
            live = FALL;
    }
    for (int i = 0; i < b->n; i++)
        if (b->ins[i].op != DROPPED) b->ins[n++] = b->ins[i];
    b->n = n;
}

#ifdef KB_LEAN_ZERO
/* ops that write their a field; a write to KB_ZERO goes to KB_SINK when
 * -DKB_LEAN_ZERO keeps the zero register untouched instead of resetting it */
static int writes_a(const struct kb_ins* x) {
    return x->op <= KB_INS || x->op == KB_LD || x->op == KB_LDS ||
           x->op == KB_SETCC || x->op == KB_SEL || x->op == KB_CARRY ||
           x->op == KB_BSWAP || x->op == KB_CLZ || x->op == KB_CTZ ||
           x->op == KB_POPCNT || x->op == KB_TPIDR || x->op == KB_FSBASE ||
           x->op == KB_X86SHD || (x->op == KB_X86FLAGS && x->imm == 0);
}
#endif

#ifdef KB_LEAN_PC
/* -DKB_LEAN_PC: KB_PC ops out of the stream, each op's instruction kept
 * beside it for a fault to report */
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
#endif

KB_NOINLINE static struct kb_block* block(struct kb_cpu* cpu, uint64_t pc) {
    unsigned h = (unsigned) ((pc >> 2) ^ (pc >> 14)) & 4095u;
    for (struct kb_block* b = cpu->cache[h]; b; b = b->chain)
        if (b->pc == pc) return b;
    struct kb_block* b = calloc(1, sizeof *b);
    b->pc = pc;
    int bad = cpu->arch == KB_X86   ? kb_x86_block(cpu, b)
              : cpu->arch == KB_A64 ? kb_a64_block(cpu, b)
                                    : kb_wasm_block(cpu, b);
    if (!bad && !cpu->noplan) plan_flags(cpu, b);
#ifdef KB_LEAN_ZERO
    for (int i = 0; !bad && i < b->n; i++)
        if (b->ins[i].a == KB_ZERO && writes_a(&b->ins[i]))
            b->ins[i].a = KB_SINK;
#endif
#ifdef KB_LEAN_PC
    if (!bad) bad = lean_pcs(cpu, b);
#endif
    int mem = 0;
    for (int i = 0; !bad && i < b->n; i++)
        mem += b->ins[i].op == KB_LD || b->ins[i].op == KB_LDS ||
               b->ins[i].op == KB_ST;
    if (mem && !bad && !(b->ic = calloc((size_t) mem, sizeof *b->ic))) bad = 1;
    if (bad) {
        free(b->ins);
        free(b->pcs);
        free(b);
        return NULL;
    }
    b->chain = cpu->cache[h];
    cpu->cache[h] = b;
#ifdef KB_AOT
    if (!cpu->trace) kb_aot_attach(cpu, b);
#endif
    return b;
}

#ifdef KB_HOT
void kb_hot_dump(struct kb_cpu* cpu) {
    const char* dir = getenv("KATYBUG_HOT");
    if (!dir) return;
    char path[4096];
    snprintf(path, sizeof path, "%s/%ld.hot", dir, (long) getpid());
    FILE* f = fopen(path, "w");
    if (!f) return;
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
        }
    fclose(f);
}
#endif

/* a load or store translated once per mapping, not per access; kb_load_ic
 * refills a stale cache */
KB_NOINLINE static inline uint64_t load(
    struct kb_cpu* cpu, struct kb_ic* ic, uint64_t va, int w
) {
    if (ic->gen != cpu->mapgen || va - ic->lo > ic->span - (uint64_t) w)
        return kb_load_ic(cpu, ic, va, w);
    uint64_t v = 0;
    memcpy(&v, ic->host + (va - ic->lo), (size_t) w);
    return v;
}

KB_NOINLINE static inline void store(
    struct kb_cpu* cpu, struct kb_ic* ic, uint64_t va, uint64_t v, int w
) {
    if (ic->gen != cpu->mapgen || va - ic->lo > ic->span - (uint64_t) w)
        kb_store_ic(cpu, ic, va, v, w);
    else
        memcpy(ic->host + (va - ic->lo), &v, (size_t) w);
}

/* -DKB_LEAN_OPERANDS reads an op's b and c registers only in the cases that use
 * them; otherwise both are read ahead of the switch for every op */
#ifdef KB_LEAN_OPERANDS
    #define B (r[x->b])
    #define C (r[x->c])
#else
    #define B b
    #define C c
#endif
/* a fault in op i leaves the block at its start; -DKB_LEAN_PC names the
 * instruction from the side table */
#ifdef KB_LEAN_PC
    #define FAULTED()                                                          \
        ((blk->pcs ? (void) (cpu->ipc = blk->pc + blk->pcs[i]) : (void) 0),    \
         blk->pc)
#else
    #define FAULTED() blk->pc
#endif
/* -DKB_LEAN_FAULT checks for a fault only after the ops that can raise one */
#ifdef KB_LEAN_FAULT
    #define CHECK()                                                            \
        if (cpu->fault) return FAULTED()
#else
    #define CHECK() (void) 0
#endif

/* runs one block; returns the next pc */
static uint64_t step(struct kb_cpu* cpu, struct kb_block* blk) {
    uint64_t* r = cpu->r;
    struct kb_ic* ic =
        blk->ic; /* the next load or store's; ops never jump inside a block */
    for (int i = 0; i < blk->n; i++) {
        struct kb_ins* x = &blk->ins[i];
#ifndef KB_LEAN_OPERANDS
        uint64_t b = r[x->b], c = r[x->c];
#endif
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
            case KB_UMULH:
                r[x->a] = (uint64_t) (((unsigned __int128) B * C) >> 64);
                break;
            case KB_SMULH:
                r[x->a] =
                    (uint64_t) (((__int128) (int64_t) B * (int64_t) C) >> 64);
                break;
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
            case KB_FLAGS: flags(cpu, (int) x->imm, B, C, r[x->a], x->w); break;
            case KB_SETCC:
                r[x->a] = (uint64_t) kb_cond(cpu, (int) x->imm);
                break;
            case KB_SEL: r[x->a] = kb_cond(cpu, (int) x->imm) ? B : C; break;
            case KB_BR:
                if (kb_cond(cpu, (int) x->imm)) return blk->target;
                break;
            case KB_JMP: return B;
            case KB_SYSCALL:
                cpu->pc = blk->next;
                kb_syscall(cpu);
                if (cpu->exited) return 0;
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
                if (kb_x87(cpu, x) && !cpu->fault) {
                    cpu->fault = "unknown x87 instruction";
                    cpu->fault_sig = 4;
                }
                CHECK();
                break;
            case KB_SSE:
                if (kb_sse(cpu, x) && !cpu->fault) {
                    cpu->fault = "unknown sse instruction";
                    cpu->fault_sig = 4;
                }
                CHECK();
                break;
            case KB_CARRY: r[x->a] = (uint64_t) cpu->c; break;
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
            case KB_FSBASE: r[x->a] = cpu->fs; break;
            case KB_SETTP: cpu->tpidr = B; break;
            case KB_BRZ:
                if ((r[x->a] != 0) == (x->imm != 0)) return blk->target;
                break;
            case KB_CCMP: {
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
                if (muldiv(cpu, (int) x->imm, x->w, B)) return FAULTED();
                break;
            case KB_X86STR:
                string(cpu, (int) x->imm, x->w, x->c);
                CHECK();
                break;
        }
#ifndef KB_LEAN_ZERO
        r[KB_ZERO] = 0;
#endif
#ifndef KB_LEAN_FAULT
        if (cpu->fault) return FAULTED();
#endif
    }
    return blk->next;
}

/** runs the guest until it exits; the exit status (128 + a signal when one
 * ended it) */
int kb_run(struct kb_cpu* cpu) {
    while (!cpu->exited) {
        struct kb_block* b = block(cpu, cpu->pc);
        if (!b) {
            /* no instruction here at all: the jump itself faulted */
            cpu->fault = "jump outside the address space";
            if (kb_fault(cpu, 11, 1, cpu->pc)) continue;
            break;
        }
        cpu->ipc = b->pc;
#ifdef KB_HOT
        b->runs++;
#endif
#ifdef KB_AOT
        uint64_t next = b->aot ? b->aot(cpu, b->pc) : step(cpu, b);
#else
        uint64_t next = step(cpu, b);
#endif
        cpu->steps++;
        cpu->plan_flags_run += b->dropped;
        cpu->plan_flags_ran += b->flag_writes;
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
                    cpu, s, codes[s], s == 11 ? cpu->fault_addr : cpu->ipc
                )) {
                cpu->fault = why;
                break;
            }
            continue;
        }
        cpu->pc = next;
        kb_signals(cpu);
    }
    return cpu->status;
}
