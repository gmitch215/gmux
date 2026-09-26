#ifndef KB_H
#define KB_H

#include <stddef.h>
#include <stdint.h>
#include <stdio.h>

#include "f80.h"

/* -DKB_PROFILE keeps the interpreter's hot helpers out of line, so a profile
 * can attribute their time */
#ifdef KB_PROFILE
    #define KB_NOINLINE __attribute__((noinline))
#else
    #define KB_NOINLINE
#endif

enum kb_arch
{
    KB_X86 = 0,
    KB_A64 = 1,
    KB_WASM = 2
};

/* registers: guest 0..31 (x86 rax..r15 at 0..15, AArch64 x0..x30 and sp at 31),
 * temps from 32 */
enum
{
    KB_T0 = 32,
    KB_ZERO = 63, /* always 0: AArch64's xzr reads here */
    KB_NREGS = 64
};

enum kb_op
{
    KB_MOVI, /* a = imm */
    KB_MOV,  /* a = b */
    KB_ADD,  /* a = b op c, all 64 bits; decoders truncate with ZEXT/SEXT */
    KB_SUB,
    KB_AND,
    KB_OR,
    KB_XOR,
    KB_SHL, /* shift counts are masked by the decoder */
    KB_SHR,
    KB_SAR,
    KB_ROR,
    KB_MUL,
    KB_UMULH,
    KB_SMULH,
    KB_UDIV, /* the decoder guards a zero divisor */
    KB_SDIV,
    KB_UREM,
    KB_SREM,
    KB_ZEXT, /* a = low w bytes of b */
    KB_SEXT,
    KB_INS,   /* a's bits [imm, imm + 8w) = low bits of b */
    KB_LD,    /* a = mem[b + imm], w bytes, zero-extended */
    KB_LDS,   /* sign-extended */
    KB_ST,    /* mem[b + imm] = low w bytes of a */
    KB_FLAGS, /* flags from (kind imm, operands b and c, result a, width w) */
    KB_SETCC, /* a = cond imm */
    KB_SEL,   /* a = cond imm ? b : c */
    KB_BR,  /* if cond imm, leave to target; the block's end gives the other way
             */
    KB_JMP, /* leave to b (a register) */
    KB_SYSCALL,
    KB_TRAP,  /* an instruction the decoder does not know: imm is its first byte
                 or word */
    KB_CARRY, /* a = the carry flag (for adc and sbb) */
    KB_BSWAP, /* a = byte-reversed b, w bytes */
    KB_CLZ,   /* a = leading zeros of b in w bytes */
    KB_CTZ,
    KB_TPIDR,  /* a = the thread pointer (AArch64 mrs tpidr_el0) */
    KB_X86MD,  /* x86 mul/imul/div/idiv on rdx:rax by b; imm is the ModRM reg
                  field (4..7) */
    KB_X86STR, /* x86 movs (imm 0) or stos (imm 1) of w bytes, repeated rcx
                  times when c is 1 */
    KB_FSBASE, /* a = the x86 fs base (arch_prctl ARCH_SET_FS) */
    KB_BRZ,    /* leave to target if a is zero (imm 0) or nonzero (imm 1); flags
                  untouched */
    KB_CCMP, /* AArch64 ccmp/ccmn of a and b; imm = cond | nzcv << 4 | ccmn << 8
              */
    KB_SETTP, /* the thread pointer = b (AArch64 msr tpidr_el0) */
    KB_PC, /* a guest instruction starts at imm: where a fault inside it reports
            */
    KB_SSE,      /* x86 SSE/SSE2: imm is (prefix << 8 | opcode) | ext << 16; see
                    sse.c */
    KB_X86SHD,   /* x86 shld (imm 0) or shrd (imm 1) of a by b, count c; sets
                    flags */
    KB_X86FLAGS, /* imm 0: a = rflags; 1: rflags = a; 2 cmc, 3 clc, 4 stc, 5
                    cld, 6 std */
    KB_X87, /* x87: imm = opcode << 8 | modrm, b = memory address, c = 0x80 for
              memory; x87.c */
    KB_POPCNT, /* a = the set bits of b's low w bytes */
    KB_WTRAP,  /* a wasm trap: imm indexes kb_wasm_traps */
    KB_WEXIT   /* the wasm entry function returned */
};

/* flag kinds for KB_FLAGS */
enum kb_fk
{
    KB_F_ADD,
    KB_F_SUB,
    KB_F_LOGIC,
    KB_F_INC,
    KB_F_DEC,
    KB_F_ADC,
    KB_F_SBB,
    KB_F_SHL,
    KB_F_SHR,
    KB_F_SAR,
    KB_F_MULOV, /* x86 mul/imul: c holds whether the high half was significant
                 */
    KB_F_NEG,
    KB_F_A_ADD, /* AArch64: C is the carry out, not a borrow */
    KB_F_A_SUB,
    KB_F_A_LOGIC,
    KB_F_NZCV, /* b holds NZCV in bits 31..28 (ccmp, msr nzcv) */
    KB_F_SETC, /* x86 bt: C = b, the rest unchanged */
    KB_F_ZERO, /* x86 bsf, bsr: Z = (b == 0), the source */
    KB_F_CNT,  /* x86 tzcnt, lzcnt: C = (b == 0), the source; Z = (a == 0), the
                  count */
    KB_F_ROL,  /* x86 rol: a is the result, b the (nonzero) count */
    KB_F_ROR
};

/* conditions: x86's 16 (o, no, b, ae, e, ne, be, a, s, ns, p, np, l, ge, le,
 * g), then AArch64's */
enum
{
    KB_C_O = 0,
    KB_C_A64 = 16, /* eq ne cs cc mi pl vs vc hi ls ge lt gt le al nv */
    KB_C_ALWAYS = 30
};

struct kb_ins {
    uint8_t op;
    uint8_t w; /* width in bytes */
    uint8_t a, b, c;
    int64_t imm;
};

/** a load or store's last translation: host bytes for [lo, lo + span) while gen
 * is cpu->mapgen */
struct kb_ic {
    uint64_t lo, span;
    uint8_t* host;
    uint32_t gen;
};

/** one decoded straight-line block: runs its ops, then continues at `next`
 * unless an op left */
struct kb_block {
    uint64_t pc, next, target;
    int n;
    struct kb_ins* ins;
    struct kb_ic* ic; /* one per load or store, in op order */
    int flag_writes,
        dropped; /* flag writes decoded, and those the plan took out */
    struct kb_block* chain; /* the next block in its hash bucket */
};

struct kb_mapping {
    uint64_t start, end;
    uint8_t* host; /* NULL for a hole left by a partial munmap */
    int prot;
    int brk; /* the heap brk grows */
};

struct kb_sigaction {
    uint64_t handler, flags, restorer, mask;
};

/**
 * a foreign Linux process (x86-64 or AArch64 ELF) run by decoding its
 * instructions to the gmux IR and interpreting that; its syscalls become the
 * host's own POSIX calls. Guest addresses are 64-bit and live in mappings, each
 * backed by one contiguous host block
 */
struct kb_cpu {
    uint64_t r[KB_NREGS];
    uint64_t pc;
    uint64_t fs, tpidr;
    /* flags, kept as bits: N (sign), Z, C (the producing architecture's carry),
     * V, P (x86 parity) */
    int n, z, c, v, p;
    int df; /* x86 direction flag: string ops go down when set */
    int arch;
    int exited, status;
    struct kb_mapping
        maps[1024]; /* later ones cover earlier ones where they overlap */
    int nmaps;
    uint32_t mapgen; /* bumped by every change to maps, which makes older kb_ic
                        entries stale */
    uint64_t brk_start, brk_end, mmap_next;
    struct kb_block* cache[4096];
    const char* fault;
    const char* last_fault; /* why the last fault happened, for KATYBUG_DEBUG */
    uint64_t steps;
    int noplan; /* KATYBUG_PLAN=0: blocks run as decoded */
    uint64_t plan_flags,
        plan_flags_removed; /* flag writes decoded, and dropped as unread */
    uint64_t plan_flags_run,
        plan_flags_ran; /* of those, as executed: dropped, and all */
    uint64_t ipc;       /* the current guest instruction */
    uint64_t x[16][2];  /* x86 xmm registers */
    f80 st[8];          /* the x87 stack, st(i) = st[(top + i) & 7] */
    int top;
    uint8_t ftag; /* the x87 registers holding a value */
    uint16_t fcw,
        fcc; /* the control word, and the status word's condition codes */
    FILE*
        trace; /* KATYBUG_TRACE: each guest instruction's address, as it runs */
    struct kb_sigaction sig[65];
    uint64_t sigmask;
    uint64_t saved_mask; /* rt_sigsuspend's caller mask, restored by the next
                            delivery's frame */
    int restore_mask;
    int fault_sig, fault_code, sigreturned;
    uint64_t fault_addr;
};

/* mem.c */
uint8_t* kb_host(struct kb_cpu* cpu, uint64_t va, uint64_t len);
struct kb_mapping* kb_map(
    struct kb_cpu* cpu, uint64_t start, uint64_t len, int prot
);
int kb_unmap(struct kb_cpu* cpu, uint64_t start, uint64_t len);
void kb_protect(struct kb_cpu* cpu, uint64_t start, uint64_t len, int prot);
uint64_t kb_load(struct kb_cpu* cpu, uint64_t va, int w);
void kb_store(struct kb_cpu* cpu, uint64_t va, uint64_t v, int w);
uint64_t kb_load_ic(struct kb_cpu* cpu, struct kb_ic* ic, uint64_t va, int w);
void kb_store_ic(
    struct kb_cpu* cpu, struct kb_ic* ic, uint64_t va, uint64_t v, int w
);

/* x86.c, a64.c: decode the block at pc; 0 on success */
int kb_x86_block(struct kb_cpu* cpu, struct kb_block* b);
int kb_a64_block(struct kb_cpu* cpu, struct kb_block* b);

/* wasm.c: a wasm module's functions, decoded to the IR; kb_wasm_main runs
 * --wasm */
int kb_wasm_block(struct kb_cpu* cpu, struct kb_block* b);
int kb_wasm_load(struct kb_cpu* cpu, const char* path);
int kb_wasm_main(struct kb_cpu* cpu, int argc, char** argv);
extern const char* kb_wasm_traps[];

/* run.c */
int kb_cond(struct kb_cpu* cpu, int cond);
int kb_run(struct kb_cpu* cpu);

/* elf.c */
int kb_load_elf(
    struct kb_cpu* cpu, const char* path, int argc, char** argv, char** envp
);

/* main.c: the path this katybug was started from, for a guest's execve of a
 * foreign ELF */
extern const char* kb_self;

/* sys.c: the guest's syscall, with its number and arguments in guest registers
 */
void kb_syscall(struct kb_cpu* cpu);
int64_t kb_err(int e);
char* kb_str(struct kb_cpu* cpu, uint64_t va);

/* fork.c: fork by exec of katybug and a state transfer, where the host cannot
 * fork (wasm) */
int kb_fork_by_exec(void);
int64_t kb_fork(struct kb_cpu* cpu);
int kb_resume(struct kb_cpu* cpu, int fd);

/* net.c: the socket, poll and select syscalls (generic numbers); -38 for others
 */
int64_t kb_net(struct kb_cpu* cpu, int64_t nr, const uint64_t* a);

/* sse.c: one SSE instruction; a = the ModRM reg field, c = the r/m register
   (0x80 when memory at TA), b = the GPR/temp holding a memory operand's
   address, w = REX.W, imm as in KB_SSE */
int kb_sse(struct kb_cpu* cpu, const struct kb_ins* x);
int kb_x87(struct kb_cpu* cpu, const struct kb_ins* x);

/* sig.c */
int64_t kb_sigaction(struct kb_cpu* cpu, int s, uint64_t act, uint64_t old);
int64_t kb_sigprocmask(struct kb_cpu* cpu, int how, uint64_t set, uint64_t old);
void kb_raise(struct kb_cpu* cpu, int s, int code);
void kb_sigreturn(struct kb_cpu* cpu);
void kb_signals(struct kb_cpu* cpu);
int kb_fault(struct kb_cpu* cpu, int s, int code, uint64_t addr);
int kb_host_sig(int s);
int64_t kb_sigsuspend(struct kb_cpu* cpu, uint64_t mask);
void kb_sig_reinstall(struct kb_cpu* cpu);
int64_t kb_sigpending(struct kb_cpu* cpu, uint64_t set);
int64_t kb_timer(struct kb_cpu* cpu, int64_t nr, const uint64_t* a);

/* a growing op list for decoders */
struct kb_emit {
    struct kb_ins* ins;
    int n, cap;
};
void kb_put(struct kb_emit* e, int op, int w, int a, int b, int c, int64_t imm);

#endif
