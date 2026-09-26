#include <stdlib.h>
#include <string.h>

#include "kb.h"

/* temps */
enum
{
    TA = KB_T0, /* effective address */
    T1,
    T2,
    T3,
    T4,
    T5,
    T0_SAVE /* rax before cmpxchg */
};

struct dec {
    struct kb_cpu* cpu;
    struct kb_emit* e;
    uint64_t pc; /* the instruction's start */
    uint64_t at; /* the next byte to read */
    int rex, w, osize, rep, fs, gs;
    /* ModRM */
    int mod, reg, rm, mem;
    int64_t disp;
    int riprel, base, index, scale;
    int bad;
};

static uint8_t byte(struct dec* d) {
    uint8_t* p = kb_host(d->cpu, d->at, 1);
    if (!p) {
        d->bad = 1;
        return 0;
    }
    d->at++;
    return *p;
}

static int64_t imm(struct dec* d, int w) {
    uint64_t v = 0;
    for (int i = 0; i < w; i++) v |= (uint64_t) byte(d) << (8 * i);
    int s = 64 - 8 * w;
    return (int64_t) (v << s) >> s;
}

static void put(struct dec* d, int op, int w, int a, int b, int c, int64_t x) {
    kb_put(d->e, op, w, a, b, c, x);
}

static void modrm(struct dec* d) {
    uint8_t m = byte(d);
    d->mod = m >> 6;
    d->reg = ((m >> 3) & 7) | ((d->rex & 4) << 1);
    d->rm = m & 7;
    d->mem = d->mod != 3;
    d->riprel = 0;
    d->base = -1;
    d->index = -1;
    d->scale = 0;
    d->disp = 0;
    if (!d->mem) {
        d->rm |= (d->rex & 1) << 3;
        return;
    }
    if (d->rm == 4) {
        uint8_t sib = byte(d);
        int idx = ((sib >> 3) & 7) | ((d->rex & 2) << 2);
        int base = (sib & 7) | ((d->rex & 1) << 3);
        d->scale = sib >> 6;
        if (idx != 4) d->index = idx;
        if ((sib & 7) == 5 && d->mod == 0)
            d->disp = imm(d, 4);
        else
            d->base = base;
    }
    else if (d->rm == 5 && d->mod == 0) {
        d->riprel = 1;
        d->disp = imm(d, 4);
    }
    else
        d->base = d->rm | ((d->rex & 1) << 3);
    if (d->mod == 1) d->disp = imm(d, 1);
    if (d->mod == 2) d->disp = imm(d, 4);
}

/* the effective address into TA; call once the whole instruction (immediates
 * too) is read */
static void address(struct dec* d) {
    if (d->riprel)
        put(d, KB_MOVI, 8, TA, 0, 0, (int64_t) (d->at + (uint64_t) d->disp));
    else {
        put(d, KB_MOVI, 8, TA, 0, 0, d->disp);
        if (d->base >= 0) put(d, KB_ADD, 8, TA, TA, d->base, 0);
        if (d->index >= 0) {
            put(d, KB_MOVI, 8, T5, 0, 0, d->scale);
            put(d, KB_SHL, 8, T5, d->index, T5, 0);
            put(d, KB_ADD, 8, TA, TA, T5, 0);
        }
    }
    if (d->fs) {
        put(d, KB_FSBASE, 8, T5, 0, 0, 0);
        put(d, KB_ADD, 8, TA, TA, T5, 0);
    }
}

/* byte registers 4..7 without REX are ah, ch, dh, bh */
static int high8(struct dec* d, int r, int w) {
    return w == 1 && !d->rex && r >= 4 && r < 8;
}

/* a register operand's value, zero-extended, in a register (the register itself
 * for 64 bits) */
static int rreg(struct dec* d, int r, int w, int t) {
    if (high8(d, r, w)) {
        put(d, KB_MOVI, 8, t, 0, 0, 8);
        put(d, KB_SHR, 8, t, r - 4, t, 0);
        put(d, KB_ZEXT, 1, t, t, 0, 0);
        return t;
    }
    if (w == 8) return r;
    put(d, KB_ZEXT, w, t, r, 0, 0);
    return t;
}

static void wreg(struct dec* d, int r, int w, int v) {
    if (high8(d, r, w))
        put(d, KB_INS, 1, r - 4, v, 0, 8);
    else if (w == 8)
        put(d, KB_MOV, 8, r, v, 0, 0);
    else if (w == 4)
        put(d, KB_ZEXT, 4, r, v, 0, 0);
    else
        put(d, KB_INS, w, r, v, 0, 0);
}

/* the r/m operand: address computed once per instruction */
static int rrm(struct dec* d, int w, int t) {
    if (!d->mem) return rreg(d, d->rm, w, t);
    put(d, KB_LD, w, t, TA, 0, 0);
    return t;
}

static void wrm(struct dec* d, int w, int v) {
    if (!d->mem)
        wreg(d, d->rm, w, v);
    else
        put(d, KB_ST, w, v, TA, 0, 0);
}

static void push(struct dec* d, int v) {
    if (v == 4) {
        put(d, KB_MOV, 8, T4, 4, 0,
            0); /* push rsp stores the value from before the push */
        v = T4;
    }
    put(d, KB_MOVI, 8, T5, 0, 0, 8);
    put(d, KB_SUB, 8, 4, 4, T5, 0);
    put(d, KB_ST, 8, v, 4, 0, 0);
}

static void pop(struct dec* d, int t) {
    put(d, KB_LD, 8, t, 4, 0, 0);
    put(d, KB_MOVI, 8, T5, 0, 0, 8);
    put(d, KB_ADD, 8, 4, 4, T5, 0);
}

/* add or adc sbb and sub xor cmp (0..7) of a (dst value) and b; writes through
 * wr unless cmp */
static void alu(
    struct dec* d, int k, int w, int a, int b, void (*wr)(struct dec*, int, int)
) {
    static const int ops[8] = {KB_ADD, KB_OR,  KB_ADD, KB_SUB,
                               KB_AND, KB_SUB, KB_XOR, KB_SUB};
    static const int fk[8] = {KB_F_ADD,   KB_F_LOGIC, KB_F_ADC,   KB_F_SBB,
                              KB_F_LOGIC, KB_F_SUB,   KB_F_LOGIC, KB_F_SUB};
    put(d, ops[k], 8, T3, a, b, 0);
    if (k == 2 || k == 3) {
        put(d, KB_CARRY, 8, T4, 0, 0, 0);
        put(d, ops[k], 8, T3, T3, T4, 0);
    }
    put(d, KB_FLAGS, w, T3, a, b, fk[k]);
    if (k != 7) wr(d, w, T3);
}

static int reg_w; /* the register operand for wreg_op */
static void wreg_op(struct dec* d, int w, int v) {
    wreg(d, reg_w, w, v);
}

static void jump(struct dec* d, struct kb_block* b, uint64_t target) {
    b->target = target;
    put(d, KB_MOVI, 8, T5, 0, 0, (int64_t) target);
    put(d, KB_JMP, 8, 0, T5, 0, 0);
}

/* the two-byte opcodes that are SSE or SSE2 (sse.c decides the rest by prefix)
 */
static int sse_op(uint8_t op) {
    if (op >= 0x10 && op <= 0x17) return 1;
    if (op >= 0x28 && op <= 0x2f && op != 0x2b) return 1;
    if (op >= 0x50 && op <= 0x76) return 1;
    if (op == 0x7e || op == 0x7f || op == 0xc2 || op == 0xc4 || op == 0xc5 ||
        op == 0xc6)
        return 1;
    if (op >= 0xd1 && op <= 0xfe && op != 0xd0 && op != 0xe0 && op != 0xf0 &&
        op != 0xf7)
        return 1;
    return 0;
}

/* one instruction; 1 when it ends the block */
static int one(struct dec* d, struct kb_block* blk) {
    d->pc = d->at;
    put(d, KB_PC, 8, 0, 0, 0, (int64_t) d->pc);
    d->rex = d->osize = d->rep = d->fs = d->gs = 0;
    uint8_t op;
    for (;;) {
        op = byte(d);
        if (op == 0x66)
            d->osize = 1;
        else if (op == 0xf2 || op == 0xf3)
            d->rep = op;
        else if (op == 0x64)
            d->fs = 1;
        else if (op == 0x65)
            d->gs = 1;
        else if (
            op == 0xf0 || op == 0x2e || op == 0x3e || op == 0x26 ||
            op == 0x36 || op == 0x67
        )
            continue;
        else
            break;
    }
    if ((op & 0xf0) == 0x40) {
        d->rex = op;
        op = byte(d);
    }
    int w = (d->rex & 8) ? 8 : d->osize ? 2 : 4;
    int wb = (op & 1) ? w : 1; /* the byte/word pairs */
    if (d->bad) return 1;

    if (op < 0x40 && (op & 7) < 6) {
        int k = op >> 3;
        switch (op & 7) {
            case 0:
            case 1: /* r/m, r */
                modrm(d);
                if (d->mem) address(d);
                alu(d, k, wb, rrm(d, wb, T1), rreg(d, d->reg, wb, T2), wrm);
                return 0;
            case 2:
            case 3: /* r, r/m */
                modrm(d);
                if (d->mem) address(d);
                reg_w = d->reg;
                alu(d, k, wb, rreg(d, d->reg, wb, T1), rrm(d, wb, T2), wreg_op);
                return 0;
            case 4:
            case 5: /* al/eax, imm */
            {
                int iw = (op & 1) ? (w == 8 ? 4 : w) : 1;
                put(d, KB_MOVI, 8, T2, 0, 0, imm(d, iw));
                d->mem = 0;
                d->rm = 0;
                alu(d, k, wb, rreg(d, 0, wb, T1), T2, wrm);
                return 0;
            }
        }
    }
    if (op >= 0x50 && op <= 0x57) {
        int r = (op & 7) | ((d->rex & 1) << 3);
        put(d, KB_MOV, 8, T1, r, 0, 0);
        push(d, T1);
        return 0;
    }
    if (op >= 0x58 && op <= 0x5f) {
        int r = (op & 7) | ((d->rex & 1) << 3);
        pop(d, T1);
        put(d, KB_MOV, 8, r, T1, 0, 0);
        return 0;
    }
    if (op >= 0x70 && op <= 0x7f) {
        int64_t rel = imm(d, 1);
        blk->target = d->at + (uint64_t) rel;
        put(d, KB_BR, 8, 0, 0, 0, op & 15);
        return 1;
    }
    if (op >= 0x91 && op <= 0x97) {
        int r = (op & 7) | ((d->rex & 1) << 3);
        put(d, KB_MOV, 8, T1, r, 0, 0);
        wreg(d, r, w, 0);
        wreg(d, 0, w, T1);
        return 0;
    }
    if (op >= 0xb0 && op <= 0xbf) {
        int r = (op & 7) | ((d->rex & 1) << 3);
        int ww = op < 0xb8 ? 1 : w;
        put(d, KB_MOVI, 8, T1, 0, 0, imm(d, ww == 8 ? 8 : ww));
        wreg(d, r, ww, T1);
        return 0;
    }
    switch (op) {
        case 0x63: /* movsxd */
            modrm(d);
            if (d->mem) address(d);
            put(d, KB_SEXT, 4, T1, rrm(d, 4, T1), 0, 0);
            wreg(d, d->reg, w, T1);
            return 0;
        case 0x68:
        case 0x6a:
            put(d, KB_MOVI, 8, T1, 0, 0, imm(d, op == 0x68 ? 4 : 1));
            push(d, T1);
            return 0;
        case 0x69:
        case 0x6b:
        case 0xaf: /* imul r, r/m(, imm) */
        imul:
            {
                modrm(d);
                int64_t k = 0;
                if (op == 0x69) k = imm(d, w == 8 ? 4 : w);
                if (op == 0x6b) k = imm(d, 1);
                if (d->mem) address(d);
                int a = rrm(d, w, T1), b;
                if (op == 0xaf)
                    b = rreg(d, d->reg, w, T2);
                else {
                    put(d, KB_MOVI, 8, T2, 0, 0, k);
                    b = T2;
                }
                if (w == 8) {
                    put(d, KB_SMULH, 8, T4, a, b, 0);
                    put(d, KB_MUL, 8, T3, a, b, 0);
                    put(d, KB_MOVI, 8, T5, 0, 0, 63);
                    put(d, KB_SAR, 8, T5, T3, T5, 0);
                    put(d, KB_XOR, 8, T4, T4, T5, 0);
                }
                else {
                    put(d, KB_SEXT, w, T1, a, 0, 0);
                    put(d, KB_SEXT, w, T2, b, 0, 0);
                    put(d, KB_MUL, 8, T3, T1, T2, 0);
                    put(d, KB_SEXT, w, T4, T3, 0, 0);
                    put(d, KB_XOR, 8, T4, T4, T3, 0);
                }
                put(d, KB_FLAGS, w, T3, T3, T4, KB_F_MULOV);
                wreg(d, d->reg, w, T3);
                return 0;
            }
        case 0x80:
        case 0x81:
        case 0x83: {
            modrm(d);
            int ww = op == 0x80 ? 1 : w;
            int64_t k = imm(d, op == 0x81 ? (w == 8 ? 4 : w) : 1);
            if (d->mem) address(d);
            put(d, KB_MOVI, 8, T2, 0, 0, k);
            alu(d, d->reg & 7, ww, rrm(d, ww, T1), T2, wrm);
            return 0;
        }
        case 0x84:
        case 0x85:
            modrm(d);
            if (d->mem) address(d);
            put(d, KB_AND, 8, T3, rrm(d, wb, T1), rreg(d, d->reg, wb, T2), 0);
            put(d, KB_FLAGS, wb, T3, T3, T3, KB_F_LOGIC);
            return 0;
        case 0x86:
        case 0x87:
            modrm(d);
            if (d->mem) address(d);
            {
                int a = rrm(d, wb, T1);
                int b = rreg(d, d->reg, wb, T2);
                if (a == d->rm && !d->mem) {
                    put(d, KB_MOV, 8, T1, a, 0, 0);
                    a = T1;
                }
                wrm(d, wb, b);
                wreg(d, d->reg, wb, a);
            }
            return 0;
        case 0x88:
        case 0x89:
            modrm(d);
            if (d->mem) address(d);
            wrm(d, wb, rreg(d, d->reg, wb, T1));
            return 0;
        case 0x8a:
        case 0x8b:
            modrm(d);
            if (d->mem) address(d);
            wreg(d, d->reg, wb, rrm(d, wb, T1));
            return 0;
        case 0x8d: /* lea */
            modrm(d);
            {
                int fs = d->fs, gs = d->gs;
                d->fs = d->gs = 0;
                address(d);
                d->fs = fs;
                d->gs = gs;
            }
            wreg(d, d->reg, w, TA);
            return 0;
        case 0x8f: /* pop r/m */
            modrm(d);
            pop(d, T1);
            if (d->mem) address(d);
            wrm(d, 8, T1);
            return 0;
        case 0x90:
            if (d->rex & 1) {
                put(d, KB_MOV, 8, T1, 8, 0, 0);
                wreg(d, 8, w, 0);
                wreg(d, 0, w, T1);
            }
            return 0;
        case 0x98: /* cbw, cwde, cdqe */
            put(d, KB_SEXT, w / 2, T1, 0, 0, 0);
            wreg(d, 0, w, T1);
            return 0;
        case 0x99: /* cwd, cdq, cqo */
            put(d, KB_SEXT, w, T1, 0, 0, 0);
            put(d, KB_MOVI, 8, T2, 0, 0, 63);
            put(d, KB_SAR, 8, T1, T1, T2, 0);
            wreg(d, 2, w, T1);
            return 0;
        case 0xd8:
        case 0xd9:
        case 0xda:
        case 0xdb:
        case 0xdc:
        case 0xdd:
        case 0xde:
        case 0xdf: {
            modrm(d);
            if (d->mem) address(d);
            int raw = (d->mod << 6) | ((d->reg & 7) << 3) | (d->rm & 7);
            put(d, KB_X87, 8, 0, TA, d->mem ? 0x80 : 0,
                (int64_t) ((op << 8) | raw));
            return 0;
        }
        case 0x9b: /* fwait */ return 0;
        case 0x9c: /* pushfq */
            put(d, KB_X86FLAGS, 8, T1, 0, 0, 0);
            push(d, T1);
            return 0;
        case 0x9d: /* popfq */
            pop(d, T1);
            put(d, KB_X86FLAGS, 8, T1, 0, 0, 1);
            return 0;
        case 0x9e: /* sahf: SF ZF AF PF CF from ah */
            put(d, KB_X86FLAGS, 8, T1, 0, 0, 0);
            put(d, KB_MOVI, 8, T2, 0, 0, 8);
            put(d, KB_SHR, 8, T3, 0, T2, 0);
            put(d, KB_INS, 1, T1, T3, 0, 0);
            put(d, KB_X86FLAGS, 8, T1, 0, 0, 1);
            return 0;
        case 0x9f: /* lahf */
            put(d, KB_X86FLAGS, 8, T1, 0, 0, 0);
            put(d, KB_INS, 1, 0, T1, 0, 8);
            return 0;
        case 0xf5:
        case 0xf8:
        case 0xf9: /* cmc, clc, stc */
            put(d, KB_X86FLAGS, 8, T1, 0, 0,
                op == 0xf5   ? 2
                : op == 0xf8 ? 3
                             : 4);
            return 0;
        case 0xfc:
        case 0xfd: /* cld, std */
            put(d, KB_X86FLAGS, 8, T1, 0, 0, op == 0xfc ? 5 : 6);
            return 0;
        case 0xa4:
        case 0xa5:
        case 0xaa:
        case 0xab:
            put(d, KB_X86STR, wb, 0, 0, d->rep ? 1 : 0, op >= 0xaa);
            return 0;
        case 0xa8:
        case 0xa9:
            put(d, KB_MOVI, 8, T2, 0, 0, imm(d, wb == 8 ? 4 : wb));
            put(d, KB_AND, 8, T3, 0, T2, 0);
            put(d, KB_FLAGS, wb, T3, T3, T3, KB_F_LOGIC);
            return 0;
        case 0xc0:
        case 0xc1:
        case 0xd0:
        case 0xd1:
        case 0xd2:
        case 0xd3: {
            modrm(d);
            int64_t k = 1;
            if (op <= 0xc1) k = imm(d, 1);
            if (d->mem) address(d);
            int a = rrm(d, wb, T1);
            if (op >= 0xd2)
                put(d, KB_MOV, 8, T2, 1, 0, 0);
            else
                put(d, KB_MOVI, 8, T2, 0, 0, k);
            put(d, KB_MOVI, 8, T5, 0, 0, wb == 8 ? 63 : 31);
            put(d, KB_AND, 8, T2, T2, T5, 0);
            switch (d->reg & 7) {
                case 0: /* rol = ror by width - count */
                    put(d, KB_MOVI, 8, T5, 0, 0, 8 * wb);
                    put(d, KB_SUB, 8, T4, T5, T2, 0);
                    put(d, KB_ROR, wb, T3, a, T4, 0);
                    put(d, KB_FLAGS, wb, T3, 0, T2, KB_F_ROL);
                    break;
                case 1:
                    put(d, KB_ROR, wb, T3, a, T2, 0);
                    put(d, KB_FLAGS, wb, T3, 0, T2, KB_F_ROR);
                    break;
                case 4:
                case 6:
                    put(d, KB_SHL, 8, T3, a, T2, 0);
                    put(d, KB_FLAGS, wb, T3, a, T2, KB_F_SHL);
                    break;
                case 5:
                    put(d, KB_SHR, 8, T3, a, T2, 0);
                    put(d, KB_FLAGS, wb, T3, a, T2, KB_F_SHR);
                    break;
                case 7:
                    put(d, KB_SEXT, wb, T4, a, 0, 0);
                    put(d, KB_SAR, 8, T3, T4, T2, 0);
                    put(d, KB_FLAGS, wb, T3, a, T2, KB_F_SAR);
                    break;
                default: put(d, KB_TRAP, 1, 0, 0, 0, op); return 1;
            }
            wrm(d, wb, T3);
            return 0;
        }
        case 0xc2:
        case 0xc3: {
            int64_t k = op == 0xc2 ? imm(d, 2) & 0xffff : 0;
            pop(d, T1);
            if (k) {
                put(d, KB_MOVI, 8, T5, 0, 0, k);
                put(d, KB_ADD, 8, 4, 4, T5, 0);
            }
            put(d, KB_JMP, 8, 0, T1, 0, 0);
            return 1;
        }
        case 0xc6:
        case 0xc7:
            modrm(d);
            {
                int64_t k = imm(d, wb == 8 ? 4 : wb);
                if (d->mem) address(d);
                put(d, KB_MOVI, 8, T1, 0, 0, k);
                wrm(d, wb, T1);
            }
            return 0;
        case 0xc9: /* leave */
            put(d, KB_MOV, 8, 4, 5, 0, 0);
            pop(d, T1);
            put(d, KB_MOV, 8, 5, T1, 0, 0);
            return 0;
        case 0xe8: {
            int64_t rel = imm(d, 4);
            put(d, KB_MOVI, 8, T1, 0, 0, (int64_t) d->at);
            push(d, T1);
            jump(d, blk, d->at + (uint64_t) rel);
            return 1;
        }
        case 0xe9:
        case 0xeb: {
            int64_t rel = imm(d, op == 0xe9 ? 4 : 1);
            jump(d, blk, d->at + (uint64_t) rel);
            return 1;
        }
        case 0xf6:
        case 0xf7:
            modrm(d);
            if ((d->reg & 7) < 2) {
                int64_t k = imm(d, wb == 8 ? 4 : wb);
                if (d->mem) address(d);
                put(d, KB_MOVI, 8, T2, 0, 0, k);
                put(d, KB_AND, 8, T3, rrm(d, wb, T1), T2, 0);
                put(d, KB_FLAGS, wb, T3, T3, T3, KB_F_LOGIC);
                return 0;
            }
            if (d->mem) address(d);
            switch (d->reg & 7) {
                case 2:
                    put(d, KB_MOVI, 8, T2, 0, 0, -1);
                    put(d, KB_XOR, 8, T3, rrm(d, wb, T1), T2, 0);
                    wrm(d, wb, T3);
                    return 0;
                case 3: {
                    int a = rrm(d, wb, T1);
                    put(d, KB_SUB, 8, T3, KB_ZERO, a, 0);
                    put(d, KB_FLAGS, wb, T3, KB_ZERO, a, KB_F_NEG);
                    wrm(d, wb, T3);
                    return 0;
                }
                default:
                    put(d, KB_X86MD, wb, 0, rrm(d, wb, T1), 0, d->reg & 7);
                    return 0;
            }
        case 0xfe:
        case 0xff:
            modrm(d);
            if (d->mem) address(d);
            switch (d->reg & 7) {
                case 0:
                case 1: {
                    int a = rrm(d, wb, T1);
                    put(d, KB_MOVI, 8, T2, 0, 0, 1);
                    put(d, (d->reg & 7) ? KB_SUB : KB_ADD, 8, T3, a, T2, 0);
                    put(d, KB_FLAGS, wb, T3, a, T2,
                        (d->reg & 7) ? KB_F_DEC : KB_F_INC);
                    wrm(d, wb, T3);
                    return 0;
                }
                case 2:
                    rrm(d, 8, T1);
                    put(d, KB_MOVI, 8, T2, 0, 0, (int64_t) d->at);
                    push(d, T2);
                    put(d, KB_JMP, 8, 0, d->mem ? T1 : d->rm, 0, 0);
                    return 1;
                case 4: put(d, KB_JMP, 8, 0, rrm(d, 8, T1), 0, 0); return 1;
                case 6: push(d, rrm(d, 8, T1)); return 0;
            }
            break;
        case 0x0f: {
            uint8_t op2 = byte(d);
            if (sse_op(op2)) {
                int pre = d->rep ? d->rep : d->osize ? 0x66 : 0;
                modrm(d);
                int ext = 0;
                if (op2 == 0x70 || op2 == 0x71 || op2 == 0x72 || op2 == 0x73 ||
                    op2 == 0xc2 || op2 == 0xc4 || op2 == 0xc5 || op2 == 0xc6)
                    ext = (int) imm(d, 1) & 0xff;
                if (d->mem) address(d);
                put(d, KB_SSE, (d->rex & 8) ? 8 : 4, d->reg, TA,
                    d->mem ? 0x80 : d->rm,
                    (int64_t) op2 | (pre << 8) | (ext << 16));
                return 0;
            }
            if (op2 >= 0x80 && op2 <= 0x8f) {
                int64_t rel = imm(d, 4);
                blk->target = d->at + (uint64_t) rel;
                put(d, KB_BR, 8, 0, 0, 0, op2 & 15);
                return 1;
            }
            if (op2 >= 0x90 && op2 <= 0x9f) {
                modrm(d);
                if (d->mem) address(d);
                put(d, KB_SETCC, 8, T1, 0, 0, op2 & 15);
                wrm(d, 1, T1);
                return 0;
            }
            if (op2 >= 0x40 && op2 <= 0x4f) {
                modrm(d);
                if (d->mem) address(d);
                int src = rrm(d, w, T1);
                int dst = rreg(d, d->reg, w, T2);
                put(d, KB_SEL, 8, T3, src, dst, op2 & 15);
                wreg(d, d->reg, w, T3);
                return 0;
            }
            if (op2 >= 0xc8 && op2 <= 0xcf) {
                int r = (op2 & 7) | ((d->rex & 1) << 3);
                put(d, KB_BSWAP, w, T1, r, 0, 0);
                wreg(d, r, w, T1);
                return 0;
            }
            switch (op2) {
                case 0x05: put(d, KB_SYSCALL, 8, 0, 0, 0, 0); return 1;
                case 0x0b: put(d, KB_TRAP, 1, 0, 0, 0, 0x0f0b); return 1;
                case 0x18:
                case 0x19:
                case 0x1a:
                case 0x1b:
                case 0x1c:
                case 0x1d:
                case 0x1e:
                case 0x1f:
                    /* hint nops, endbr64 among them */
                    modrm(d);
                    return 0;
                case 0xa2: /* cpuid: nothing beyond the baseline */
                    put(d, KB_MOVI, 8, 0, 0, 0, 0);
                    put(d, KB_MOVI, 8, 3, 0, 0, 0);
                    put(d, KB_MOVI, 8, 1, 0, 0, 0);
                    put(d, KB_MOVI, 8, 2, 0, 0, 0);
                    return 0;
                case 0xa3:
                case 0xab:
                case 0xb3:
                case 0xbb:
                case 0xba: /* bt, bts, btr, btc */
                {
                    modrm(d);
                    int64_t k = op2 == 0xba ? imm(d, 1) : 0;
                    int kind = op2 == 0xba ? (d->reg & 7) - 4 : (op2 >> 3) & 3;
                    if (kind < 0) break;
                    int log = w == 8 ? 3 : w == 4 ? 2 : 1;
                    if (d->mem) address(d);
                    if (op2 == 0xba)
                        put(d, KB_MOVI, 8, T2, 0, 0, k);
                    else {
                        int r = rreg(d, d->reg, w, T2);
                        if (d->mem) {
                            /* a register offset into memory picks from a bit
                               string: signed, so it moves the address by whole
                               operands either way */
                            put(d, KB_SEXT, w, T3, r, 0, 0);
                            put(d, KB_MOVI, 8, T5, 0, 0, log + 3);
                            put(d, KB_SAR, 8, T3, T3, T5, 0);
                            put(d, KB_MOVI, 8, T5, 0, 0, log);
                            put(d, KB_SHL, 8, T3, T3, T5, 0);
                            put(d, KB_ADD, 8, TA, TA, T3, 0);
                        }
                        if (r != T2) put(d, KB_MOV, 8, T2, r, 0, 0);
                    }
                    put(d, KB_MOVI, 8, T5, 0, 0, 8 * w - 1);
                    put(d, KB_AND, 8, T2, T2, T5, 0);
                    int a = rrm(d, w, T1);
                    put(d, KB_SHR, 8, T3, a, T2, 0);
                    put(d, KB_FLAGS, w, T3, 0, T3, KB_F_SETC);
                    if (!kind) return 0;
                    put(d, KB_MOVI, 8, T4, 0, 0, 1);
                    put(d, KB_SHL, 8, T4, T4, T2, 0);
                    if (kind == 2) {
                        put(d, KB_MOVI, 8, T5, 0, 0, -1);
                        put(d, KB_XOR, 8, T4, T4, T5, 0);
                    }
                    put(d,
                        kind == 1   ? KB_OR
                        : kind == 2 ? KB_AND
                                    : KB_XOR,
                        8, T1, a, T4, 0);
                    wrm(d, w, T1);
                    return 0;
                }
                case 0xaf: op = 0xaf; goto imul;
                case 0xa4:
                case 0xa5:
                case 0xac:
                case 0xad: /* shld, shrd */
                {
                    modrm(d);
                    int64_t k = (op2 == 0xa4 || op2 == 0xac) ? imm(d, 1) : 0;
                    if (d->mem) address(d);
                    int a = rrm(d, w, T1);
                    if (a != T1) {
                        put(d, KB_MOV, 8, T1, a, 0, 0);
                        a = T1;
                    }
                    int b = rreg(d, d->reg, w, T2);
                    if (b != T2) {
                        put(d, KB_MOV, 8, T2, b, 0, 0);
                        b = T2;
                    }
                    if (op2 == 0xa5 || op2 == 0xad)
                        put(d, KB_MOV, 8, T3, 1, 0, 0);
                    else
                        put(d, KB_MOVI, 8, T3, 0, 0, k);
                    put(d, KB_MOVI, 8, T5, 0, 0, w == 8 ? 63 : 31);
                    put(d, KB_AND, 8, T3, T3, T5,
                        0); /* count; 0 leaves everything alone */
                    put(d, KB_X86SHD, w, T1, T2, T3,
                        op2 == 0xa4 || op2 == 0xa5 ? 0 : 1);
                    wrm(d, w, T1);
                    return 0;
                }
                case 0xb0:
                case 0xb1: /* cmpxchg r/m, r: compare with al/eax/rax, one
                              thread so no lock */
                {
                    int ww = op2 == 0xb0 ? 1 : w;
                    modrm(d);
                    if (d->mem) address(d);
                    put(d, KB_MOV, 8, T0_SAVE, 0, 0, 0);
                    int dst = rrm(d, ww, T1);
                    if (dst != T1) {
                        put(d, KB_MOV, 8, T1, dst, 0, 0);
                        dst = T1;
                    }
                    int acc = rreg(d, 0, ww, T2);
                    if (acc != T2) {
                        put(d, KB_MOV, 8, T2, acc, 0, 0);
                        acc = T2;
                    }
                    put(d, KB_SUB, 8, T3, acc, dst, 0);
                    put(d, KB_FLAGS, ww, T3, acc, dst, KB_F_SUB);
                    /* equal: r/m = r and the accumulator is untouched; not
                       equal: the accumulator = r/m and a register r/m is
                       untouched (memory is written back either way) */
                    int src = rreg(d, d->reg, ww, T4);
                    if (d->mem) {
                        put(d, KB_SEL, 8, T5, src, dst, 4);
                        wrm(d, ww, T5);
                    }
                    else {
                        wreg(
                            d, 0, ww, T1
                        ); /* provisional: the accumulator = r/m */
                        put(d, KB_MOV, 8, T5, 0, 0, 0);
                        put(d, KB_SEL, 8, 0, T0_SAVE, T5, 4);
                        put(d, KB_SEL, 8, T5, src, dst, 4);
                        put(d, KB_MOV, 8, T3, d->rm, 0, 0);
                        wreg(d, d->rm, ww, T5);
                        put(d, KB_SEL, 8, d->rm, d->rm, T3, 4);
                        return 0;
                    }
                    wreg(d, 0, ww, T1);
                    put(d, KB_SEL, 8, 0, T0_SAVE, 0, 4);
                    return 0;
                }
                case 0xc0:
                case 0xc1: /* xadd r/m, r */
                {
                    int ww = op2 == 0xc0 ? 1 : w;
                    modrm(d);
                    if (d->mem) address(d);
                    int dst = rrm(d, ww, T1);
                    if (dst != T1) {
                        put(d, KB_MOV, 8, T1, dst, 0, 0);
                        dst = T1;
                    }
                    int src = rreg(d, d->reg, ww, T2);
                    if (src != T2) {
                        put(d, KB_MOV, 8, T2, src, 0, 0);
                        src = T2;
                    }
                    put(d, KB_ADD, 8, T3, dst, src, 0);
                    put(d, KB_FLAGS, ww, T3, dst, src, KB_F_ADD);
                    wreg(d, d->reg, ww, dst);
                    wrm(d, ww, T3);
                    return 0;
                }
                case 0xb6:
                case 0xb7:
                case 0xbe:
                case 0xbf:
                    modrm(d);
                    if (d->mem) address(d);
                    {
                        int sw = (op2 & 1) ? 2 : 1;
                        int a = rrm(d, sw, T1);
                        put(d, (op2 & 8) ? KB_SEXT : KB_ZEXT, sw, T1, a, 0, 0);
                        wreg(d, d->reg, w, T1);
                    }
                    return 0;
                case 0xbc:
                case 0xbd: /* bsf, bsr, tzcnt, lzcnt */
                    modrm(d);
                    if (d->mem) address(d);
                    {
                        int a = rrm(d, w, T1);
                        if (a != T1) {
                            put(d, KB_MOV, 8, T1, a, 0, 0);
                            a = T1;
                        }
                        put(d, op2 == 0xbc ? KB_CTZ : KB_CLZ, w, T3, a, 0, 0);
                        if (d->rep == 0xf3) /* tzcnt, lzcnt: the width for 0 */
                            put(d, KB_FLAGS, w, T3, 0, a, KB_F_CNT);
                        else {
                            if (op2 == 0xbd) {
                                put(d, KB_MOVI, 8, T5, 0, 0, 8 * w - 1);
                                put(d, KB_SUB, 8, T3, T5, T3, 0);
                            }
                            /* bsf, bsr of 0 do not write the destination at all
                             */
                            put(d, KB_FLAGS, w, T3, 0, a, KB_F_ZERO);
                            put(d, KB_MOV, 8, T4, d->reg, 0, 0);
                            wreg(d, d->reg, w, T3);
                            put(d, KB_SEL, 8, d->reg, T4, d->reg, 4);
                            return 0;
                        }
                        wreg(d, d->reg, w, T3);
                    }
                    return 0;
            }
            put(d, KB_TRAP, 2, 0, 0, 0, 0x0f00 | op2);
            return 1;
        }
    }
    put(d, KB_TRAP, 1, 0, 0, 0, op);
    return 1;
}

int kb_x86_block(struct kb_cpu* cpu, struct kb_block* b) {
    struct kb_emit e = {0};
    struct dec d = {.cpu = cpu, .e = &e, .at = b->pc};
    int end = 0;
    for (int i = 0; i < 64 && !end; i++) {
        end = one(&d, b);
        if (d.bad) return -1;
    }
    b->next = d.at;
    if (!end) b->target = d.at;
    b->ins = e.ins;
    b->n = e.n;
    return 0;
}
