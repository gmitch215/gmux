/*
 * The wasm frontend: a wasm module's functions decoded to the gmux IR and run
 * by the same interpreter as x86-64 and AArch64. Wasm's operand stack has a
 * static height at every instruction, so each local and stack slot is a fixed
 * 8-byte cell in the function's frame and every instruction becomes loads, IR
 * ops and stores at constant offsets from FP. i32 values are held
 * zero-extended. A call's arguments already sit where the callee's locals
 * start; a return stack holds the return pc and the caller's FP. Integer ops,
 * memory, globals, control flow, direct and indirect calls are decoded; floats,
 * memory.grow, bulk memory and calls to imports trap as unsupported.
 */
#include <inttypes.h>
#include <stdlib.h>
#include <string.h>

#include "kb.h"

enum
{
    FP = 0,  /* the frame: local i at FP + 8i, stack slot k after the locals */
    RSP = 1, /* the return stack: return pc, caller FP */
    MEM = 2, /* linear memory's base */
    GLOB = 3,
    TAB = 4, /* table 0: (canonical type << 32) | (function + 1), 0 for null */
    T = KB_T0
};

/* 64 GiB up, so an address plus offset (under 8 GiB) past memory's end meets
 * nothing mapped */
#define MEM_BASE 0x1000000000ull
#define FRAME_BASE 0x200000000ull
#define FRAME_SIZE (16u << 20)
#define RET_BASE 0x300000000ull
#define RET_SIZE (1u << 20)
#define GLOB_BASE 0x380000000ull
#define TAB_BASE 0x390000000ull
#define EXIT_PC 0xffffffff00000000ull
#define SYNTH 0x80000000u

/* trap kinds (KB_WTRAP's imm), named as the tests name V8's RuntimeErrors */
const char* kb_wasm_traps[] = {"unreachable", "div0", "overflow", "oob",
                               "tableoob",    "sig",  "null",     "unsupported",
                               "import",      "stack"};
enum
{
    TR_UNREACHABLE,
    TR_DIV0,
    TR_OVERFLOW,
    TR_OOB,
    TR_TABLE,
    TR_SIG,
    TR_NULL,
    TR_UNSUPPORTED,
    TR_IMPORT,
    TR_STACK
};

struct wtype {
    int np, nr;
    uint8_t p[32], r[32];
    int canon; /* the first type index with the same signature */
};

struct wblk {
    uint64_t pc, next, target;
    struct kb_emit e;
};

struct wfunc {
    uint32_t type;
    const uint8_t *body, *code,
        *end; /* the entry, its instructions, their end */
    int nlocals;
    struct wblk* blocks;
    int nblocks, decoded;
};

struct wglobal {
    uint8_t type;
    uint64_t init;
};

struct wexport {
    char name[64];
    uint32_t func;
};

static struct {
    uint8_t* bytes;
    struct wtype* types;
    int ntypes;
    uint32_t* ftype; /* every function's type, imports first */
    int nimports, nfuncs;
    struct wfunc* funcs; /* the defined ones */
    struct wglobal* globals;
    int nglobals;
    uint32_t mem_pages;
    uint64_t* table;
    uint32_t ntable;
    struct wexport* exports;
    int nexports;
} m;

/* #region reading */

static uint64_t leb(const uint8_t** p, int sign, int bits) {
    uint64_t v = 0;
    int shift = 0;
    uint8_t byte;
    do {
        byte = *(*p)++;
        v |= (uint64_t) (byte & 0x7f) << shift;
        shift += 7;
    } while (byte & 0x80);
    if (sign && shift < 64 && (byte & 0x40)) v |= ~0ull << shift;
    if (bits == 32) v = sign ? (uint64_t) (int64_t) (int32_t) v : (uint32_t) v;
    return v;
}
#define U32(p) ((uint32_t) leb(&(p), 0, 32))

/* the value of a constant expression: i32/i64.const, then end */
static uint64_t const_expr(const uint8_t** p) {
    uint64_t v = 0;
    uint8_t op = *(*p)++;
    if (op == 0x41)
        v = (uint32_t) leb(p, 1, 32);
    else if (op == 0x42)
        v = leb(p, 1, 64);
    else if (op == 0x23)
        v = m.globals[U32(*p)].init;
    while (*(*p)++ != 0x0b) {
    }
    return v;
}

/* #endregion */

/* #region decoding */

struct ctl {
    int kind; /* 0 function, 1 block, 2 loop, 3 if */
    int height, np, nr;
    uint64_t start; /* a loop's pc */
    int dead;       /* the rest of this frame cannot run */
    int *fix, nfix,
        capfix; /* blocks whose next (even) or target (odd) is the end pc */
    int if_block,
        has_else; /* an if's condition block, whose target is else or end */
};

struct dec {
    struct wfunc* f;
    uint32_t index;
    int cur; /* the block being emitted, -1 after a branch */
    int h;
    struct ctl ctl[256];
    int depth;
    uint32_t synth;
    uint64_t trap_pc[10];
};

static uint64_t pc_of(struct dec* d, const uint8_t* p) {
    return (uint64_t) d->index << 32 | (uint64_t) (p - d->f->code);
}

static struct wblk* blk(struct dec* d) {
    return &d->f->blocks[d->cur];
}

static int new_block(struct dec* d, uint64_t pc) {
    struct wfunc* f = d->f;
    if (d->cur >= 0) blk(d)->next = pc;
    f->blocks =
        realloc(f->blocks, (size_t) (f->nblocks + 1) * sizeof *f->blocks);
    memset(&f->blocks[f->nblocks], 0, sizeof *f->blocks);
    f->blocks[f->nblocks].pc = pc;
    d->cur = f->nblocks++;
    return d->cur;
}

static void put(
    struct dec* d, int op, int w, int a, int b, int c, int64_t imm
) {
    kb_put(&blk(d)->e, op, w, a, b, c, imm);
}

static int slot(struct dec* d, int k) {
    return 8 * (d->f->nlocals + k);
}
static void get(struct dec* d, int t, int k) {
    put(d, KB_LD, 8, t, FP, 0, slot(d, k));
}
static void set(struct dec* d, int t, int k) {
    put(d, KB_ST, 8, t, FP, 0, slot(d, k));
}

static void fix(struct ctl* c, int block, int target) {
    if (c->nfix == c->capfix) {
        c->capfix = c->capfix ? 2 * c->capfix : 8;
        c->fix = realloc(c->fix, (size_t) c->capfix * sizeof *c->fix);
    }
    c->fix[c->nfix++] = 2 * block + target;
}

static uint64_t trap_block(struct dec* d, int kind) {
    if (d->trap_pc[kind]) return d->trap_pc[kind];
    int keep = d->cur;
    uint64_t pc = (uint64_t) d->index << 32 | SYNTH | d->synth++;
    d->cur = -1;
    new_block(d, pc);
    put(d, KB_WTRAP, 0, 0, 0, 0, kind);
    d->cur = keep;
    return d->trap_pc[kind] = pc;
}

/* ends the current block in a trap; the trap block first, since adding it can
 * move the block array under a pointer taken before */
static void end_in_trap(struct dec* d, int kind) {
    uint64_t pc = trap_block(d, kind);
    blk(d)->next = pc;
    d->cur = -1;
}

/* leaves to `target` when register a is zero (nz 0) or nonzero (nz 1), else
   continues in a new block */
static void branch_if(struct dec* d, int a, int nz, uint64_t target) {
    put(d, KB_BRZ, 8, a, 0, 0, nz);
    blk(d)->target = target;
    new_block(d, (uint64_t) d->index << 32 | SYNTH | d->synth++);
}

static void trap_if(struct dec* d, int a, int nz, int kind) {
    branch_if(d, a, nz, trap_block(d, kind));
}

/* the values a branch to frame c carries: to its start for a loop, else its
 * results */
static int arity(struct ctl* c) {
    return c->kind == 2 ? c->np : c->nr;
}

static void move_values(struct dec* d, int from, int to, int n) {
    for (int i = 0; from != to && i < n; i++) {
        get(d, T, from + i);
        set(d, T, to + i);
    }
}

/* the return sequence: results to the frame's start, then back to the caller */
static void emit_return(struct dec* d) {
    int nr = m.types[m.ftype[d->index]].nr;
    for (int i = 0; i < nr; i++) {
        get(d, T, d->h - nr + i);
        put(d, KB_ST, 8, T, FP, 0, 8 * i);
    }
    put(d, KB_MOVI, 8, T, 0, 0, 16);
    put(d, KB_SUB, 8, RSP, RSP, T, 0);
    put(d, KB_LD, 8, T + 1, RSP, 0, 0);
    put(d, KB_LD, 8, FP, RSP, 0, 8);
    put(d, KB_JMP, 8, 0, T + 1, 0, 0);
    d->cur = -1;
}

/* an unconditional branch to frame c (depth from the top), from the current
 * block */
static void emit_br(struct dec* d, int depth) {
    struct ctl* c = &d->ctl[d->depth - 1 - depth];
    if (c->kind == 0) return emit_return(d);
    int n = arity(c);
    move_values(d, d->h - n, c->height, n);
    if (c->kind == 2)
        blk(d)->next = c->start;
    else
        fix(c, d->cur, 0);
    d->cur = -1;
}

/* a conditional branch on register t (nonzero) to frame c */
static void emit_br_if(struct dec* d, int t, int depth, uint64_t fallthrough) {
    struct ctl* c = &d->ctl[d->depth - 1 - depth];
    int n = arity(c);
    if (c->kind != 0 && (n == 0 || d->h - n == c->height)) {
        put(d, KB_BRZ, 8, t, 0, 0, 1);
        if (c->kind == 2)
            blk(d)->target = c->start;
        else
            fix(c, d->cur, 1);
        new_block(d, fallthrough);
        return;
    }
    /* the taken way moves values or returns: a block of its own */
    uint64_t taken = (uint64_t) d->index << 32 | SYNTH | d->synth++;
    put(d, KB_BRZ, 8, t, 0, 0, 1);
    blk(d)->target = taken;
    int from = d->cur;
    d->cur = -1;
    new_block(d, taken);
    emit_br(d, depth);
    d->cur = from;
    new_block(d, fallthrough);
}

static void block_type(const uint8_t** p, int* np, int* nr) {
    if (**p == 0x40) {
        (*p)++;
        *np = *nr = 0;
    }
    else if (**p == 0x7f || **p == 0x7e || **p == 0x7d || **p == 0x7c) {
        (*p)++;
        *np = 0;
        *nr = 1;
    }
    else {
        struct wtype* t = &m.types[leb(p, 1, 64)];
        *np = t->np;
        *nr = t->nr;
    }
}

/* skips one instruction's immediates, for code that cannot run */
static void skip(const uint8_t** p, uint8_t op) {
    switch (op) {
        case 0x02:
        case 0x03:
        case 0x04: {
            int np, nr;
            block_type(p, &np, &nr);
            break;
        }
        case 0x0c:
        case 0x0d:
        case 0x10:
        case 0x20:
        case 0x21:
        case 0x22:
        case 0x23:
        case 0x24:
        case 0x3f:
        case 0x40: leb(p, 0, 64); break;
        case 0x0e: {
            uint32_t n = U32(*p);
            for (uint32_t i = 0; i <= n; i++) leb(p, 0, 64);
            break;
        }
        case 0x11:
            leb(p, 0, 64);
            leb(p, 0, 64);
            break;
        case 0x1c: {
            uint32_t n = U32(*p);
            *p += n;
            break;
        }
        case 0x41: leb(p, 1, 32); break;
        case 0x42: leb(p, 1, 64); break;
        case 0x43: *p += 4; break;
        case 0x44: *p += 8; break;
        case 0xfc: {
            uint32_t sub = U32(*p);
            if (sub >= 8 && sub <= 17) {
                if (sub == 8 || sub == 10 || sub == 12 || sub == 14)
                    leb(p, 0, 64);
                if (sub != 9 && sub != 13) leb(p, 0, 64);
            }
            break;
        }
        default:
            if (op >= 0x28 && op <= 0x3e) {
                leb(p, 0, 64);
                leb(p, 0, 64);
            }
    }
}

/* a call's frame push and jump: to `callee`, or to the pc in register tpc when
 * callee is -1 */
static void emit_call(
    struct dec* d, int64_t callee, int tpc, uint32_t type, uint64_t ret
) {
    struct wtype* t = &m.types[type];
    int base = d->h - t->np;
    put(d, KB_MOVI, 8, T, 0, 0, (int64_t) ret);
    put(d, KB_ST, 8, T, RSP, 0, 0);
    put(d, KB_ST, 8, FP, RSP, 0, 8);
    put(d, KB_MOVI, 8, T, 0, 0, 16);
    put(d, KB_ADD, 8, RSP, RSP, T, 0);
    put(d, KB_MOVI, 8, T, 0, 0, slot(d, base));
    put(d, KB_ADD, 8, FP, FP, T, 0);
    if (callee >= 0)
        blk(d)->next = (uint64_t) callee << 32;
    else
        put(d, KB_JMP, 8, 0, tpc, 0, 0);
    d->h = base + t->nr;
    d->cur = -1;
    new_block(d, ret);
}

/* two operands to T, T+1; the result from T+2 */
static void binary(struct dec* d, int op, int w32) {
    get(d, T, d->h - 2);
    get(d, T + 1, d->h - 1);
    put(d, op, 8, T + 2, T, T + 1, 0);
    if (w32) put(d, KB_ZEXT, 4, T + 2, T + 2, 0, 0);
    d->h--;
    set(d, T + 2, d->h - 1);
}

static void compare(struct dec* d, int w, int cond, int unary) {
    get(d, T, d->h - 1 - !unary);
    if (unary)
        put(d, KB_MOV, 8, T + 1, KB_ZERO, 0, 0);
    else
        get(d, T + 1, d->h - 1);
    put(d, KB_SUB, 8, T + 2, T, T + 1, 0);
    put(d, KB_FLAGS, w, T + 2, T, T + 1, KB_F_SUB);
    put(d, KB_SETCC, 8, T + 2, 0, 0, cond);
    d->h -= !unary;
    set(d, T + 2, d->h - 1);
}

static void division(struct dec* d, int w, int op, int is_signed_div) {
    get(d, T, d->h - 2);
    get(d, T + 1, d->h - 1);
    trap_if(d, T + 1, 0, TR_DIV0);
    if (is_signed_div) {
        put(d, KB_MOVI, 8, T + 2, 0, 0, w == 4 ? 0x80000000ll : INT64_MIN);
        put(d, KB_XOR, 8, T + 2, T, T + 2, 0);
        put(d, KB_MOVI, 8, T + 3, 0, 0, w == 4 ? 0xffffffffll : -1);
        put(d, KB_XOR, 8, T + 3, T + 1, T + 3, 0);
        put(d, KB_OR, 8, T + 2, T + 2, T + 3, 0);
        trap_if(d, T + 2, 0, TR_OVERFLOW);
    }
    if (w == 4 && (op == KB_SDIV || op == KB_SREM)) {
        put(d, KB_SEXT, 4, T, T, 0, 0);
        put(d, KB_SEXT, 4, T + 1, T + 1, 0, 0);
    }
    put(d, op, 8, T + 2, T, T + 1, 0);
    if (w == 4) put(d, KB_ZEXT, 4, T + 2, T + 2, 0, 0);
    d->h--;
    set(d, T + 2, d->h - 1);
}

static void shift(struct dec* d, int w, int op) {
    get(d, T, d->h - 2);
    get(d, T + 1, d->h - 1);
    put(d, KB_MOVI, 8, T + 2, 0, 0, 8 * w - 1);
    put(d, KB_AND, 8, T + 1, T + 1, T + 2, 0);
    if (op == KB_SAR && w == 4) put(d, KB_SEXT, 4, T, T, 0, 0);
    put(d, op, 8, T + 2, T, T + 1, 0);
    if (w == 4) put(d, KB_ZEXT, 4, T + 2, T + 2, 0, 0);
    d->h--;
    set(d, T + 2, d->h - 1);
}

static void rotate(struct dec* d, int w, int left) {
    get(d, T, d->h - 2);
    get(d, T + 1, d->h - 1);
    if (left) put(d, KB_SUB, 8, T + 1, KB_ZERO, T + 1, 0);
    put(d, KB_ROR, w, T + 2, T, T + 1, 0);
    d->h--;
    set(d, T + 2, d->h - 1);
}

static void unary(struct dec* d, int op, int w, int w32) {
    get(d, T, d->h - 1);
    put(d, op, w, T + 2, T, 0, 0);
    if (w32) put(d, KB_ZEXT, 4, T + 2, T + 2, 0, 0);
    set(d, T + 2, d->h - 1);
}

static void memory_op(
    struct dec* d, const uint8_t** p, int op, int w, int w32
) {
    leb(p, 0, 32); /* alignment */
    uint32_t off = U32(*p);
    if (op == KB_ST) {
        get(d, T, d->h - 2);
        get(d, T + 1, d->h - 1);
        put(d, KB_ADD, 8, T, T, MEM, 0);
        put(d, KB_ST, w, T + 1, T, 0, off);
        d->h -= 2;
        return;
    }
    get(d, T, d->h - 1);
    put(d, KB_ADD, 8, T, T, MEM, 0);
    put(d, op, w, T + 2, T, 0, off);
    if (w32) put(d, KB_ZEXT, 4, T + 2, T + 2, 0, 0);
    set(d, T + 2, d->h - 1);
}

static void end_frame(struct dec* d, struct ctl* c, uint64_t end_pc) {
    for (int i = 0; i < c->nfix; i++) {
        struct wblk* b = &d->f->blocks[c->fix[i] / 2];
        if (c->fix[i] & 1)
            b->target = end_pc;
        else
            b->next = end_pc;
    }
    free(c->fix);
    c->fix = NULL;
    c->nfix = c->capfix = 0;
}

static int decode(uint32_t index) {
    struct wfunc* f = &m.funcs[index - (uint32_t) m.nimports];
    struct dec d = {.f = f, .index = index, .cur = -1};
    struct wtype* ft = &m.types[f->type];
    const uint8_t* p = f->code;
    new_block(&d, pc_of(&d, p));
    for (int i = ft->np; i < f->nlocals; i++)
        put(&d, KB_ST, 8, KB_ZERO, FP, 0, 8 * i);
    d.ctl[d.depth++] = (struct ctl){.kind = 0, .height = 0, .nr = ft->nr};
    while (p < f->end && d.depth) {
        uint8_t op = *p++;
        struct ctl* top = &d.ctl[d.depth - 1];
        if (top->dead) {
            /* nested frames in dead code only need matching; the frame's own
             * else or end revives */
            if (op == 0x02 || op == 0x03 || op == 0x04) {
                skip(&p, op);
                d.ctl[d.depth++] = (struct ctl){.kind = 1, .dead = 2};
                continue;
            }
            if (op == 0x0b && top->dead == 2) {
                d.depth--;
                continue;
            }
            if (op != 0x0b && !(op == 0x05 && top->kind == 3)) {
                skip(&p, op);
                continue;
            }
        }
        switch (op) {
            case 0x00: /* unreachable */
                end_in_trap(&d, TR_UNREACHABLE);
                top->dead = 1;
                break;
            case 0x01: break;
            case 0x02:
            case 0x03: {
                int np, nr;
                block_type(&p, &np, &nr);
                struct ctl c = {
                    .kind = op == 0x02 ? 1 : 2,
                    .height = d.h - np,
                    .np = np,
                    .nr = nr
                };
                if (op == 0x03) {
                    c.start = pc_of(&d, p);
                    new_block(&d, c.start);
                }
                d.ctl[d.depth++] = c;
                break;
            }
            case 0x04: {
                int np, nr;
                block_type(&p, &np, &nr);
                get(&d, T, --d.h);
                put(&d, KB_BRZ, 8, T, 0, 0, 0);
                struct ctl c = {
                    .kind = 3,
                    .height = d.h - np,
                    .np = np,
                    .nr = nr,
                    .if_block = d.cur
                };
                d.ctl[d.depth++] = c;
                new_block(&d, pc_of(&d, p));
                break;
            }
            case 0x05: { /* else: the then way goes to the end, the condition's
                            target here */
                if (d.cur >= 0) {
                    fix(top, d.cur, 0);
                    d.cur = -1;
                }
                new_block(&d, pc_of(&d, p));
                d.f->blocks[top->if_block].target = pc_of(&d, p);
                top->has_else = 1;
                top->dead = 0;
                d.h = top->height + top->np;
                break;
            }
            case 0x0b: { /* end */
                if (top->kind == 0) {
                    if (d.cur >= 0) emit_return(&d);
                    d.depth--;
                    break;
                }
                uint64_t end_pc = pc_of(&d, p);
                if (top->kind == 3 && !top->has_else)
                    d.f->blocks[top->if_block].target = end_pc;
                new_block(&d, end_pc);
                end_frame(&d, top, end_pc);
                d.h = top->height + top->nr;
                d.depth--;
                break;
            }
            case 0x0c: /* br */
                emit_br(&d, (int) U32(p));
                top->dead = 1;
                break;
            case 0x0d: { /* br_if */
                int depth = (int) U32(p);
                get(&d, T, --d.h);
                emit_br_if(&d, T, depth, pc_of(&d, p));
                break;
            }
            case 0x0e: { /* br_table: one compare and branch per entry */
                uint32_t n = U32(p);
                int* labels = malloc((n + 1) * sizeof *labels);
                for (uint32_t i = 0; i <= n; i++) labels[i] = (int) U32(p);
                get(&d, T + 4, --d.h);
                for (uint32_t i = 0; i < n; i++) {
                    put(&d, KB_MOVI, 8, T + 5, 0, 0, i);
                    put(&d, KB_XOR, 8, T + 5, T + 4, T + 5, 0);
                    /* T+5 is zero on a match: the next test when it is not */
                    uint64_t next =
                        (uint64_t) d.index << 32 | SYNTH | d.synth++;
                    put(&d, KB_BRZ, 8, T + 5, 0, 0, 1);
                    blk(&d)->target = next;
                    emit_br(&d, labels[i]);
                    new_block(&d, next);
                }
                emit_br(&d, labels[n]);
                free(labels);
                top->dead = 1;
                break;
            }
            case 0x0f: /* return */
                emit_return(&d);
                top->dead = 1;
                break;
            case 0x10: { /* call */
                uint32_t callee = U32(p);
                if ((int) callee < m.nimports) {
                    end_in_trap(&d, TR_IMPORT);
                    top->dead = 1;
                    break;
                }
                emit_call(&d, callee, 0, m.ftype[callee], pc_of(&d, p));
                break;
            }
            case 0x11: { /* call_indirect */
                uint32_t type = U32(p);
                (void) U32(p); /* table 0 */
                get(&d, T + 4, --d.h);
                put(&d, KB_MOVI, 8, T + 5, 0, 0, m.ntable);
                put(&d, KB_SUB, 8, T + 6, T + 4, T + 5, 0);
                put(&d, KB_FLAGS, 8, T + 6, T + 4, T + 5, KB_F_SUB);
                put(&d, KB_SETCC, 8, T + 6, 0, 0, 2); /* below: in range */
                trap_if(&d, T + 6, 0, TR_TABLE);
                put(&d, KB_MOVI, 8, T + 5, 0, 0, 3);
                put(&d, KB_SHL, 8, T + 4, T + 4, T + 5, 0);
                put(&d, KB_ADD, 8, T + 4, T + 4, TAB, 0);
                put(&d, KB_LD, 8, T + 4, T + 4, 0, 0);
                put(&d, KB_ZEXT, 4, T + 5, T + 4, 0, 0);
                trap_if(&d, T + 5, 0, TR_NULL);
                put(&d, KB_MOVI, 8, T + 6, 0, 0, 32);
                put(&d, KB_SHR, 8, T + 6, T + 4, T + 6, 0);
                put(&d, KB_MOVI, 8, T + 7, 0, 0, m.types[type].canon);
                put(&d, KB_XOR, 8, T + 6, T + 6, T + 7, 0);
                trap_if(&d, T + 6, 1, TR_SIG);
                put(&d, KB_MOVI, 8, T + 6, 0, 0, 1);
                put(&d, KB_SUB, 8, T + 5, T + 5, T + 6, 0);
                put(&d, KB_MOVI, 8, T + 6, 0, 0, 32);
                put(&d, KB_SHL, 8, T + 8, T + 5, T + 6, 0);
                emit_call(&d, -1, T + 8, type, pc_of(&d, p));
                break;
            }
            case 0x1a: d.h--; break; /* drop */
            case 0x1b:
            case 0x1c: { /* select */
                if (op == 0x1c) p += U32(p);
                get(&d, T, d.h - 3);
                get(&d, T + 1, d.h - 2);
                get(&d, T + 3, d.h - 1);
                put(&d, KB_FLAGS, 8, T + 3, T + 3, KB_ZERO, KB_F_SUB);
                put(&d, KB_SEL, 8, T + 2, T, T + 1, 5); /* ne */
                d.h -= 2;
                set(&d, T + 2, d.h - 1);
                break;
            }
            case 0x20: /* local.get */
                put(&d, KB_LD, 8, T, FP, 0, 8 * U32(p));
                set(&d, T, d.h++);
                break;
            case 0x21:
            case 0x22: { /* local.set, local.tee */
                uint32_t i = U32(p);
                get(&d, T, d.h - 1);
                put(&d, KB_ST, 8, T, FP, 0, 8 * i);
                if (op == 0x21) d.h--;
                break;
            }
            case 0x23: /* global.get */
                put(&d, KB_LD, 8, T, GLOB, 0, 8 * U32(p));
                set(&d, T, d.h++);
                break;
            case 0x24:
                get(&d, T, --d.h);
                put(&d, KB_ST, 8, T, GLOB, 0, 8 * U32(p));
                break;
            case 0x28: memory_op(&d, &p, KB_LD, 4, 0); break;
            case 0x29: memory_op(&d, &p, KB_LD, 8, 0); break;
            case 0x2c: memory_op(&d, &p, KB_LDS, 1, 1); break;
            case 0x2d: memory_op(&d, &p, KB_LD, 1, 0); break;
            case 0x2e: memory_op(&d, &p, KB_LDS, 2, 1); break;
            case 0x2f: memory_op(&d, &p, KB_LD, 2, 0); break;
            case 0x30: memory_op(&d, &p, KB_LDS, 1, 0); break;
            case 0x31: memory_op(&d, &p, KB_LD, 1, 0); break;
            case 0x32: memory_op(&d, &p, KB_LDS, 2, 0); break;
            case 0x33: memory_op(&d, &p, KB_LD, 2, 0); break;
            case 0x34: memory_op(&d, &p, KB_LDS, 4, 0); break;
            case 0x35: memory_op(&d, &p, KB_LD, 4, 0); break;
            case 0x36: memory_op(&d, &p, KB_ST, 4, 0); break;
            case 0x37: memory_op(&d, &p, KB_ST, 8, 0); break;
            case 0x3a:
            case 0x3c: memory_op(&d, &p, KB_ST, 1, 0); break;
            case 0x3b:
            case 0x3d: memory_op(&d, &p, KB_ST, 2, 0); break;
            case 0x3e: memory_op(&d, &p, KB_ST, 4, 0); break;
            case 0x3f: /* memory.size */
                (void) U32(p);
                put(&d, KB_MOVI, 8, T, 0, 0, m.mem_pages);
                set(&d, T, d.h++);
                break;
            case 0x41:
                put(&d, KB_MOVI, 8, T, 0, 0, (uint32_t) leb(&p, 1, 32));
                set(&d, T, d.h++);
                break;
            case 0x42:
                put(&d, KB_MOVI, 8, T, 0, 0, (int64_t) leb(&p, 1, 64));
                set(&d, T, d.h++);
                break;
            case 0x45: compare(&d, 4, 4, 1); break; /* i32.eqz */
            case 0x46: compare(&d, 4, 4, 0); break;
            case 0x47: compare(&d, 4, 5, 0); break;
            case 0x48: compare(&d, 4, 12, 0); break; /* lt_s: l */
            case 0x49: compare(&d, 4, 2, 0); break;  /* lt_u: b */
            case 0x4a: compare(&d, 4, 15, 0); break; /* gt_s: g */
            case 0x4b: compare(&d, 4, 7, 0); break;  /* gt_u: a */
            case 0x4c: compare(&d, 4, 14, 0); break; /* le_s */
            case 0x4d: compare(&d, 4, 6, 0); break;  /* le_u: be */
            case 0x4e: compare(&d, 4, 13, 0); break; /* ge_s */
            case 0x4f: compare(&d, 4, 3, 0); break;  /* ge_u: ae */
            case 0x50: compare(&d, 8, 4, 1); break;
            case 0x51: compare(&d, 8, 4, 0); break;
            case 0x52: compare(&d, 8, 5, 0); break;
            case 0x53: compare(&d, 8, 12, 0); break;
            case 0x54: compare(&d, 8, 2, 0); break;
            case 0x55: compare(&d, 8, 15, 0); break;
            case 0x56: compare(&d, 8, 7, 0); break;
            case 0x57: compare(&d, 8, 14, 0); break;
            case 0x58: compare(&d, 8, 6, 0); break;
            case 0x59: compare(&d, 8, 13, 0); break;
            case 0x5a: compare(&d, 8, 3, 0); break;
            case 0x67: unary(&d, KB_CLZ, 4, 0); break;
            case 0x68: unary(&d, KB_CTZ, 4, 0); break;
            case 0x69: unary(&d, KB_POPCNT, 4, 0); break;
            case 0x6a: binary(&d, KB_ADD, 1); break;
            case 0x6b: binary(&d, KB_SUB, 1); break;
            case 0x6c: binary(&d, KB_MUL, 1); break;
            case 0x6d: division(&d, 4, KB_SDIV, 1); break;
            case 0x6e: division(&d, 4, KB_UDIV, 0); break;
            case 0x6f: division(&d, 4, KB_SREM, 0); break;
            case 0x70: division(&d, 4, KB_UREM, 0); break;
            case 0x71: binary(&d, KB_AND, 0); break;
            case 0x72: binary(&d, KB_OR, 0); break;
            case 0x73: binary(&d, KB_XOR, 0); break;
            case 0x74: shift(&d, 4, KB_SHL); break;
            case 0x75: shift(&d, 4, KB_SAR); break;
            case 0x76: shift(&d, 4, KB_SHR); break;
            case 0x77: rotate(&d, 4, 1); break;
            case 0x78: rotate(&d, 4, 0); break;
            case 0x79: unary(&d, KB_CLZ, 8, 0); break;
            case 0x7a: unary(&d, KB_CTZ, 8, 0); break;
            case 0x7b: unary(&d, KB_POPCNT, 8, 0); break;
            case 0x7c: binary(&d, KB_ADD, 0); break;
            case 0x7d: binary(&d, KB_SUB, 0); break;
            case 0x7e: binary(&d, KB_MUL, 0); break;
            case 0x7f: division(&d, 8, KB_SDIV, 1); break;
            case 0x80: division(&d, 8, KB_UDIV, 0); break;
            case 0x81: division(&d, 8, KB_SREM, 0); break;
            case 0x82: division(&d, 8, KB_UREM, 0); break;
            case 0x83: binary(&d, KB_AND, 0); break;
            case 0x84: binary(&d, KB_OR, 0); break;
            case 0x85: binary(&d, KB_XOR, 0); break;
            case 0x86: shift(&d, 8, KB_SHL); break;
            case 0x87: shift(&d, 8, KB_SAR); break;
            case 0x88: shift(&d, 8, KB_SHR); break;
            case 0x89: rotate(&d, 8, 1); break;
            case 0x8a: rotate(&d, 8, 0); break;
            case 0xa7: unary(&d, KB_ZEXT, 4, 0); break; /* i32.wrap_i64 */
            case 0xac: unary(&d, KB_SEXT, 4, 0); break; /* i64.extend_i32_s */
            case 0xad: break;                           /* i64.extend_i32_u */
            case 0xc0: unary(&d, KB_SEXT, 1, 1); break;
            case 0xc1: unary(&d, KB_SEXT, 2, 1); break;
            case 0xc2: unary(&d, KB_SEXT, 1, 0); break;
            case 0xc3: unary(&d, KB_SEXT, 2, 0); break;
            case 0xc4: unary(&d, KB_SEXT, 4, 0); break;
            default:
                /* floats, memory.grow, bulk memory, SIMD: trap where they run
                 */
                skip(&p, op);
                end_in_trap(&d, TR_UNSUPPORTED);
                top->dead = 1;
                break;
        }
    }
    f->decoded = 1;
    return 0;
}

/* #endregion */

int kb_wasm_block(struct kb_cpu* cpu, struct kb_block* b) {
    (void) cpu;
    if (b->pc == EXIT_PC) {
        b->ins = calloc(1, sizeof *b->ins);
        b->ins[0].op = KB_WEXIT;
        b->n = 1;
        return 0;
    }
    uint32_t index = (uint32_t) (b->pc >> 32);
    if (index < (uint32_t) m.nimports ||
        index >= (uint32_t) (m.nimports + m.nfuncs)) {
        b->ins = calloc(1, sizeof *b->ins);
        b->ins[0].op = KB_WTRAP;
        b->ins[0].imm =
            index < (uint32_t) m.nimports ? TR_IMPORT : TR_UNSUPPORTED;
        b->n = 1;
        return 0;
    }
    struct wfunc* f = &m.funcs[index - (uint32_t) m.nimports];
    if (!f->decoded) decode(index);
    for (int i = 0; i < f->nblocks; i++) {
        struct wblk* w = &f->blocks[i];
        if (w->pc != b->pc) continue;
        b->n = w->e.n;
        b->ins = malloc((size_t) (w->e.n ? w->e.n : 1) * sizeof *b->ins);
        memcpy(b->ins, w->e.ins, (size_t) w->e.n * sizeof *b->ins);
        b->next = w->next;
        b->target = w->target;
        return 0;
    }
    return 1;
}

/* #region loading */

static uint8_t* read_file(const char* path, size_t* len) {
    FILE* f = fopen(path, "rb");
    if (!f) return NULL;
    fseek(f, 0, SEEK_END);
    *len = (size_t) ftell(f);
    fseek(f, 0, SEEK_SET);
    uint8_t* buf = malloc(*len);
    if (fread(buf, 1, *len, f) != *len) {
        free(buf);
        buf = NULL;
    }
    fclose(f);
    return buf;
}

int kb_wasm_load(struct kb_cpu* cpu, const char* path) {
    size_t len;
    uint8_t* bytes = read_file(path, &len);
    if (!bytes || len < 8 || memcmp(bytes, "\0asm\1\0\0\0", 8)) return 1;
    m.bytes = bytes;
    const uint8_t *p = bytes + 8, *end = bytes + len;
    uint32_t* defined = NULL;
    int ndefined = 0;
    while (p < end) {
        uint8_t id = *p++;
        uint32_t size = U32(p);
        const uint8_t *s = p, *next = p + size;
        switch (id) {
            case 1: {
                m.ntypes = (int) U32(s);
                m.types = calloc((size_t) m.ntypes, sizeof *m.types);
                for (int i = 0; i < m.ntypes; i++) {
                    struct wtype* t = &m.types[i];
                    s++; /* 0x60 */
                    t->np = (int) U32(s);
                    for (int k = 0; k < t->np; k++) t->p[k] = *s++;
                    t->nr = (int) U32(s);
                    for (int k = 0; k < t->nr; k++) t->r[k] = *s++;
                    t->canon = i;
                    for (int j = 0; j < i; j++)
                        if (m.types[j].np == t->np && m.types[j].nr == t->nr &&
                            !memcmp(m.types[j].p, t->p, (size_t) t->np) &&
                            !memcmp(m.types[j].r, t->r, (size_t) t->nr)) {
                            t->canon = j;
                            break;
                        }
                }
                break;
            }
            case 2: {
                uint32_t n = U32(s);
                for (uint32_t i = 0; i < n; i++) {
                    s += U32(s); /* module */
                    s += U32(s); /* name */
                    uint8_t kind = *s++;
                    if (kind != 0) return 2; /* only function imports */
                    m.ftype = realloc(
                        m.ftype, (size_t) (m.nimports + 1) * sizeof *m.ftype
                    );
                    m.ftype[m.nimports++] = U32(s);
                }
                break;
            }
            case 3: {
                ndefined = (int) U32(s);
                defined = calloc((size_t) ndefined, sizeof *defined);
                for (int i = 0; i < ndefined; i++) defined[i] = U32(s);
                break;
            }
            case 4:
                (void) U32(s);
                s++; /* funcref */
                if (*s++ & 1) {
                    m.ntable = U32(s);
                    (void) U32(s);
                }
                else
                    m.ntable = U32(s);
                break;
            case 5:
                (void) U32(s);
                if (*s++ & 1) {
                    m.mem_pages = U32(s);
                    (void) U32(s);
                }
                else
                    m.mem_pages = U32(s);
                break;
            case 6: {
                m.nglobals = (int) U32(s);
                m.globals = calloc((size_t) m.nglobals, sizeof *m.globals);
                for (int i = 0; i < m.nglobals; i++) {
                    m.globals[i].type = *s++;
                    s++; /* mutability */
                    m.globals[i].init = const_expr(&s);
                }
                break;
            }
            case 7: {
                m.nexports = (int) U32(s);
                m.exports = calloc((size_t) m.nexports, sizeof *m.exports);
                for (int i = 0; i < m.nexports; i++) {
                    uint32_t n = U32(s);
                    memcpy(m.exports[i].name, s, n < 63 ? n : 63);
                    s += n;
                    uint8_t kind = *s++;
                    uint32_t idx = U32(s);
                    m.exports[i].func = kind == 0 ? idx : UINT32_MAX;
                }
                break;
            }
            case 10: {
                m.nfuncs = (int) U32(s);
                m.funcs = calloc((size_t) m.nfuncs, sizeof *m.funcs);
                m.ftype = realloc(
                    m.ftype, (size_t) (m.nimports + m.nfuncs) * sizeof *m.ftype
                );
                for (int i = 0; i < m.nfuncs; i++) {
                    struct wfunc* f = &m.funcs[i];
                    uint32_t fsize = U32(s);
                    f->body = s;
                    f->end = s + fsize;
                    f->type = i < ndefined ? defined[i] : 0;
                    m.ftype[m.nimports + i] = f->type;
                    f->nlocals = m.types[f->type].np;
                    uint32_t groups = U32(s);
                    for (uint32_t g = 0; g < groups; g++) {
                        f->nlocals += (int) U32(s);
                        s++;
                    }
                    f->code = s;
                    s = f->end;
                }
                break;
            }
            default: break;
        }
        p = next;
    }
    free(defined);
    /* the address space: memory, frames, return stack, globals, table */
    if (m.mem_pages && !kb_map(cpu, MEM_BASE, (uint64_t) m.mem_pages << 16, 3))
        return 3;
    if (!kb_map(cpu, FRAME_BASE, FRAME_SIZE, 3) ||
        !kb_map(cpu, RET_BASE, RET_SIZE, 3))
        return 3;
    if (!kb_map(cpu, GLOB_BASE, (uint64_t) (m.nglobals + 1) * 8, 3)) return 3;
    if (!kb_map(cpu, TAB_BASE, (uint64_t) (m.ntable + 1) * 8, 3)) return 3;
    for (int i = 0; i < m.nglobals; i++)
        kb_store(cpu, GLOB_BASE + 8u * i, m.globals[i].init, 8);
    /* elements and data: active segments, applied now */
    for (p = bytes + 8; p < end;) {
        uint8_t id = *p++;
        uint32_t size = U32(p);
        const uint8_t *s = p, *next = p + size;
        if (id == 9) {
            uint32_t n = U32(s);
            for (uint32_t i = 0; i < n; i++) {
                if (U32(s) != 0) return 4; /* only active segments of table 0 */
                uint64_t off = const_expr(&s);
                uint32_t k = U32(s);
                for (uint32_t j = 0; j < k; j++) {
                    uint32_t fi = U32(s);
                    if (off + j < m.ntable)
                        kb_store(
                            cpu, TAB_BASE + 8 * (off + j),
                            (uint64_t) m.types[m.ftype[fi]].canon << 32 |
                                (fi + 1),
                            8
                        );
                }
            }
        }
        if (id == 11) {
            uint32_t n = U32(s);
            for (uint32_t i = 0; i < n; i++) {
                uint32_t flags = U32(s);
                uint64_t off = flags == 0 ? const_expr(&s) : 0;
                uint32_t k = U32(s);
                if (flags == 0) kb_write(cpu, MEM_BASE + off, s, k);
                s += k;
            }
        }
        p = next;
    }
    cpu->arch = KB_WASM;
    cpu->r[MEM] = MEM_BASE;
    cpu->r[GLOB] = GLOB_BASE;
    cpu->r[TAB] = TAB_BASE;
    return 0;
}

/* #endregion */

/* #region calls */

static const char* trap_name(struct kb_cpu* cpu) {
    if (!cpu->fault) return NULL;
    if (cpu->fault_sig == 11) return kb_wasm_traps[TR_OOB];
    return cpu->fault;
}

/* runs an export on arguments (as 64-bit values) and prints its results or its
 * trap */
static void call(
    struct kb_cpu* cpu, const char* name, uint64_t* args, int nargs
) {
    struct wexport* e = NULL;
    for (int i = 0; i < m.nexports; i++)
        if (!strcmp(m.exports[i].name, name) && m.exports[i].func != UINT32_MAX)
            e = &m.exports[i];
    printf("%s(", name);
    for (int i = 0; i < nargs; i++) printf("%s%" PRIx64, i ? " " : "", args[i]);
    printf(")");
    if (!e) {
        printf(" no such export\n");
        return;
    }
    struct wtype* t = &m.types[m.ftype[e->func]];
    for (int i = 0; i < t->np; i++) {
        uint64_t v = i < nargs ? args[i] : 0;
        kb_store(
            cpu, FRAME_BASE + 8u * i, t->p[i] == 0x7f ? (uint32_t) v : v, 8
        );
    }
    kb_store(cpu, RET_BASE, EXIT_PC, 8);
    kb_store(cpu, RET_BASE + 8, FRAME_BASE, 8);
    cpu->r[FP] = FRAME_BASE;
    cpu->r[RSP] = RET_BASE + 16;
    cpu->pc = (uint64_t) e->func << 32;
    cpu->fault = NULL;
    cpu->fault_sig = 0;
    cpu->exited = 0;
    kb_run(cpu);
    const char* why = trap_name(cpu);
    if (why) {
        printf(" trap %s\n", why);
        return;
    }
    printf(" =");
    for (int i = 0; i < t->nr; i++) {
        uint64_t v = kb_load(cpu, FRAME_BASE + 8u * i, 8);
        printf(" %" PRIx64, t->r[i] == 0x7f ? (uint32_t) v : v);
    }
    printf("\n");
}

/* katybug --wasm <module.wasm> <export> [args...], or --wasm <module.wasm>
   --calls <file> with one "export arg..." line per call (arguments in hex);
   results print in hex */
int kb_wasm_main(struct kb_cpu* cpu, int argc, char** argv) {
    int rc = kb_wasm_load(cpu, argv[2]);
    if (rc) {
        fprintf(
            kb_log, "katybug: cannot load wasm module %s (%d)\n", argv[2], rc
        );
        return 126;
    }
    uint64_t args[32];
    if (argc >= 5 && !strcmp(argv[3], "--calls")) {
        FILE* f = fopen(argv[4], "r");
        if (!f) return 126;
        char line[1024];
        while (fgets(line, sizeof line, f)) {
            char* tok = strtok(line, " \n");
            if (!tok) continue;
            char name[64];
            snprintf(name, sizeof name, "%s", tok);
            int n = 0;
            while (n < 32 && (tok = strtok(NULL, " \n")))
                args[n++] = strtoull(tok, NULL, 16);
            call(cpu, name, args, n);
        }
        fclose(f);
        return 0;
    }
    int n = 0;
    for (int i = 4; i < argc && n < 32; i++)
        args[n++] = strtoull(argv[i], NULL, 16);
    if (argc < 4) return 2;
    call(cpu, argv[3], args, n);
    return 0;
}

/* #endregion */
