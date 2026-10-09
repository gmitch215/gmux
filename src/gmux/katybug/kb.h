#ifndef KB_H
#define KB_H

#include <stddef.h>
#include <stdint.h>
#include <stdio.h>
#include <sys/uio.h>

#include "f80.h"

/* a mapping's host memory comes in blocks of at most 1 << KB_PIECE_BITS bytes,
 * so no allocation is larger (mem.c); an inline cache covers one piece */
#ifndef KB_PIECE_BITS
    #define KB_PIECE_BITS 16
#endif
/* the most bytes kb_buf copies for a range across pieces */
#define KB_BUF_MAX (64u << 10)

/* 0 (default): every load and store checks its cache's mapping generation,
 * every block link its code generation, every back edge and syscall for a
 * signal. -DKB_EPOCH=1: a block checks kb_epoch once when it starts, and what
 * an epoch covers (mapping generation, code generation, signal state) is looked
 * at only after one changed; a load or store checks its range alone (off until
 * timed under V8) */
#ifndef KB_EPOCH
    #define KB_EPOCH 0
#endif

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

/* AArch64 handlers without SA_RESTORER return here (the kernel's vDSO
 * sigreturn: mov x8, #139; svc #0), a page elf.c maps above the stack */
#define KB_A64_SIGTRAMP 0x7ffffff00000ull

/* registers: guest 0..31 (x86 rax..r15 at 0..15, AArch64 x0..x30 and sp at 31),
 * temps from 32 */
enum
{
    KB_T0 = 32,
    KB_SINK = 62, /* writes to KB_ZERO land here instead */
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
    KB_POPCNT,  /* a = the set bits of b's low w bytes */
    KB_WTRAP,   /* a wasm trap: imm indexes kb_wasm_traps */
    KB_WEXIT,   /* the wasm entry function returned */
    KB_RESOLVE, /* the memory plan: group a resolves [b + imm, + 16w) once, and
                   lifted loads and stores with c = a + 1 skip their own check;
                   the interpreter skips these (run.c, step) */
    KB_NZCV,    /* a = the flags as AArch64 NZCV, bits 31..28 (mrs nzcv) */
    KB_CRC32, /* a = the crc b updated by the low w bytes of c; imm 1 is crc32c
               */
    KB_CLOCK, /* a = the host's monotonic clock in ns (x86 rdtsc) */
    KB_CPUID, /* x86 cpuid of leaf eax into eax ebx ecx edx */
    KB_EXCL,  /* AArch64 exclusives: imm 0 arms the monitor (ldxr); 1 stores c
                 at b, w bytes, if it holds, a = 0 then else 1 (stxr); 2 also
                 stores register imm >> 8 at b + w (stxp); 3 clears (clrex) */
    KB_EXIT,  /* a trace's side exit: leave, to the block's pc plus the int32 at
                 imm >> 16, if cond imm & 0xff holds (bit 8 clear), or if a is
                 zero (bit 8 set, bit 0 clear) or nonzero (both set) */
    KB_A64V,  /* AArch64 floating point, Advanced SIMD, FPCR/FPSR: imm is the
                 instruction word, b a load or store's address; a64v.c */
    KB_PRIM   /* first op of a block at the entry of a library function (imm 1
                 strlen, 2 memcmp, 3 strcmp, 4 memchr, 5 memcpy, 6 memmove, 7
                 memset, 8 exp, 9 log, 10 pow, 11 crc32, 12 adler32, 13
                 compress2, 14 uncompress): runs it as a host
                 kernel and returns to the caller, or falls through to the
                 function's own ops; also the head of cksum's loop, whose
                 kernel advances the loop's registers and runs on into the
                 block's own ops; prim.c */
};

/* semantic classes (run.c, kb_class): the plans read these, not opcodes */
enum kb_class_bits
{
    KB_K_PURE = 1,       /* no flags, memory, fault, control or host state */
    KB_K_DEF = 2,        /* writes register a and no other register */
    KB_K_FLAGS_R = 4,    /* reads flags */
    KB_K_FLAGS_W = 8,    /* writes flags */
    KB_K_READ = 16,      /* reads guest memory */
    KB_K_WRITE = 32,     /* writes guest memory */
    KB_K_CONTROL = 64,   /* may leave the block */
    KB_K_FAULT = 128,    /* may fault */
    KB_K_HOST = 256,     /* touches state beyond registers, flags and memory */
    KB_K_VECTOR = 512,   /* SSE or x87 */
    KB_K_ADDRESS = 1024, /* resolves addresses (KB_RESOLVE) */
    KB_K_CLOBBER = 2048  /* writes registers other than a */
};
extern const uint16_t kb_class[];

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

struct kb_cpu;

/** one decoded straight-line block: runs its ops, then continues at `next`
 * unless an op left */
struct kb_block {
    uint64_t pc, next, target;
    int n;
    struct kb_ins* ins;
    struct kb_ic* ic; /* one per load or store, in op order */
    int nic;          /* how many */
    uint32_t epoch,   /* kb_epoch when the block last checked its assumptions */
        mapgen;       /* kb_cpu's when its caches were last known current */
    uint32_t* pcs;    /* each op's guest instruction, as an offset from pc, in
                         place of KB_PC ops (NULL in a trace, which keeps them) */
    int flag_writes,
        dropped;      /* flag writes decoded, and those the plan took out */
    int pruned;       /* pure ops the demand plan took out */
    uint32_t codegen; /* kb_cpu's when decoded; an older one decodes again */
    struct kb_block *to_target, *to_next; /* the successors last seen */
    uint32_t taken, fall; /* runs that left to target, and to next */
    int traced;           /* decoded as a trace (or found not to be one) */
    int nseg;             /* the guest code decoded: seg[2i] to seg[2i + 1] */
    uint64_t* seg;
    int resolves; /* the memory plan's KB_RESOLVE ops, which lead the block */
    struct kb_block* chain; /* the next block in its hash bucket */
#if defined(KB_HOT) || defined(KB_COUNT)
    uint64_t runs; /* times the interpreter ran it, for kb_hot_dump */
#endif
#ifdef KB_HOT
    uint64_t* exits; /* runs that left at each KB_EXIT op, once one has */
#endif
#ifdef KB_COUNT
    /* guest instructions, and the cpu struct words step() reads and writes */
    int insns, rd, wr;
#endif
#ifdef KB_AOT
    /* a region of lifted blocks this block's IR matched exactly; it runs from
       the given pc and returns the next one */
    uint64_t (*aot)(struct kb_cpu* cpu, uint64_t pc);
#endif
};

/* a loaded ELF's file, kept open so a piece of its mapping is read on first
 * touch (mem.c). The descriptor is katybug's own, below 1024 and close-on-exec,
 * so a fork's exec carries it at the same number */
#define KB_IMAGES 2
#define KB_IMAGE_SEGS 8
struct kb_image {
    int fd, hdr_ok;
    uint64_t dev, ino;
    uint64_t start; /* where the first segment's page, and the header, sit */
    uint8_t hdr[64];
    int nseg;
    struct {
        uint64_t va, off, len; /* the file's [off, off + len) is at va */
    } seg[KB_IMAGE_SEGS];
};

struct kb_mapping {
    uint64_t start, end;
    uint8_t** pieces; /* mappings never overlap; each owns its pieces (mem.c),
                         which are NULL until touched */
    int prot;
    uint8_t image; /* 1 + the kb_cpu.images entry that fills a piece when it is
                      made, 0 for none; a split keeps it, a mapping that
                      replaces part of one starts at 0 */
};

struct kb_sigaction {
    uint64_t handler, flags, restorer, mask;
};

/**
 * a foreign Linux process (x86-64 or AArch64 ELF) run by decoding its
 * instructions to the gmux IR and interpreting that; its syscalls become the
 * host's own POSIX calls. Guest addresses are 64-bit and live in mappings, each
 * backed by host blocks of one piece each
 */
struct kb_cpu {
    uint64_t r[KB_NREGS];
    uint64_t pc;
    uint64_t fs, tpidr;
    /* flags, kept as bits: N (sign), Z, C (the producing architecture's carry),
     * V, P (x86 parity) */
    int n, z, c, v, p;
    /* K17: 1 + the kind of a flag write not yet made into the bits above,
     * with its operands (run.c kb_flags_sync makes it) */
    int lz, lz_w;
    uint64_t lz_b, lz_c, lz_r;
    int df; /* x86 direction flag: string ops go down when set */
    int arch;
    int exited, status;
    struct kb_mapping
        maps[1024]; /* later ones cover earlier ones where they overlap */
    int nmaps;
    struct kb_image images[KB_IMAGES];
    int nimages;
    uint64_t image_total, /* pieces the image mappings had when loaded */
        image_filled;     /* pieces made from an image's file */
    uint32_t mapgen;  /* bumped by every change to maps, which makes older kb_ic
                         entries stale */
    uint32_t codegen; /* bumped when executable code is unmapped or changes
                         protection, which makes older blocks stale */
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
    uint64_t plan_mem,
        plan_mem_grouped; /* accesses decoded, and those a KB_RESOLVE covers */
    uint64_t plan_ops, plan_ops_removed; /* pure ops decoded, and dropped */
    int tracing;                         /* the decoders build a trace */
    int segments; /* a trace's most segments (KB_TRACE, KATYBUG_SEGMENTS) */
    uint64_t decoded, loaded;     /* blocks decoded, and taken from the cache */
    uint64_t lookups;             /* blocks found through the block cache */
    void* persist;                /* persist.c's records, when loaded */
    uint64_t traces, trace_exits; /* traces built, side exits taken */
    uint64_t plan_ops_run, plan_ops_ran; /* as executed: dropped, and all run */
    uint64_t ipc;                        /* the current guest instruction */
    uint64_t x[32][2];                   /* x86 xmm0-15; AArch64 v0-31 */
    uint32_t fpcr, fpsr;                 /* AArch64 */
    uint32_t mxcsr; /* x86, kept for stmxcsr and fxsave; SSE rounds to
                       nearest whatever it holds */
    uint64_t excl;  /* AArch64's exclusive monitor: kb_switches at the
                       last ldxr, ~0 when clear */
    f80 st[8];      /* the x87 stack, st(i) = st[(top + i) & 7] */
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
uint8_t* kb_span(struct kb_cpu* cpu, uint64_t va, uint64_t* len);
uint8_t* kb_buf(struct kb_cpu* cpu, uint64_t va, uint64_t len);
void kb_flush(struct kb_cpu* cpu);
int kb_read(struct kb_cpu* cpu, uint64_t va, void* dst, uint64_t len);
int kb_write(struct kb_cpu* cpu, uint64_t va, const void* src, uint64_t len);
int kb_iov(
    struct kb_cpu* cpu, uint64_t va, uint64_t len, struct iovec* iov, int max
);
uint64_t kb_pieces(uint64_t start, uint64_t end);
uint8_t* kb_piece(
    struct kb_cpu* cpu, struct kb_mapping* m, uint64_t va, uint64_t* lo,
    uint64_t* hi
);
int kb_bus(uint64_t va);
uint8_t* kb_piece_blank(
    struct kb_mapping* m, uint64_t va, uint64_t* lo, uint64_t* hi
);
int kb_image_header(
    const struct kb_cpu* cpu, const struct kb_mapping* m, uint8_t out[64]
);
void kb_image_report(const struct kb_cpu* cpu);
int kb_grow(struct kb_cpu* cpu, struct kb_mapping* m, uint64_t end);

/* prim.c: string functions as host kernels (KATYBUG_PRIM=0 turns them off,
 * KATYBUG_PRIM=memcmp,strlen keeps only those); the mask has bit i for
 * function i */
uint64_t kb_prim_enabled(void);
/* hash.c: n blocks of 64 bytes (128 for sha512) into a hash's state words */
void kb_sha256_blocks(uint32_t st[8], const uint8_t* p, size_t n);
void kb_sha1_blocks(uint32_t st[5], const uint8_t* p, size_t n);
void kb_md5_blocks(uint32_t st[4], const uint8_t* p, size_t n);
void kb_sha512_blocks(uint64_t st[8], const uint8_t* p, size_t n);
uint32_t kb_cksum_blocks(
    uint32_t crc, const uint8_t* tab, const uint8_t* p, size_t n
);
/* thunk.c: library calls found by the name a loaded object imports them under;
 * the ids are prim.c's */
enum
{
    KB_THUNK_STRLEN = 1,
    KB_THUNK_MEMCMP,
    KB_THUNK_STRCMP,
    KB_THUNK_MEMCHR,
    KB_THUNK_MEMCPY,
    KB_THUNK_MEMMOVE,
    KB_THUNK_MEMSET,
    KB_THUNK_EXP,
    KB_THUNK_LOG,
    KB_THUNK_POW,
    KB_THUNK_CRC32,
    KB_THUNK_ADLER32,
    KB_THUNK_COMPRESS2,
    KB_THUNK_UNCOMPRESS,
    KB_THUNK_ZS, /* KB_ZS_N stream entries from here (zstream.c's order) */
    KB_THUNK_ZPOISON = 0x7f /* an import of one that cannot be served */
};
#define KB_ZS_N 31
extern const char* const kb_zs_name[KB_ZS_N];
int kb_thunk_at(struct kb_cpu* cpu, uint64_t pc);
/* a stream init called from caller may be taken: that object imports the
 * life cycle (deflate and deflateEnd, or inflate and inflateEnd) and no object
 * imports an entry the stream mirror cannot serve */
int kb_thunk_zok(struct kb_cpu* cpu, uint64_t caller, int inflate);
/* zstream.c: entry e (0..KB_ZS_N-1) of a guest z_stream whose libz is version
 * ver of prim.c's list of stock zlib versions: 0 gives up with nothing changed,
 * 1 ran (*v is the return value), 2 raised a guest fault. KB_ZV_RESET_CLEARS
 * is the index of the first version whose inflateReset clears data_type */
#define KB_ZV_RESET_CLEARS 4
int kb_zs(struct kb_cpu* cpu, int e, int ver, uint64_t* v);
void kb_zs_report(FILE* f);
/* the loaded ELF object that holds pc, as the span it maps, or 0 */
int kb_thunk_object(
    struct kb_cpu* cpu, uint64_t pc, uint64_t* lo, uint64_t* hi
);
int kb_prim_at(struct kb_cpu* cpu, uint64_t pc);
int kb_prim(struct kb_cpu* cpu, int id, uint64_t* next);
void kb_prim_report(void);
uint8_t* kb_host_ic(
    struct kb_cpu* cpu, struct kb_ic* ic, uint64_t va, uint64_t len
);
struct kb_mapping* kb_map(
    struct kb_cpu* cpu, uint64_t start, uint64_t len, int prot
);
int kb_unmap(struct kb_cpu* cpu, uint64_t start, uint64_t len);
int kb_protect(struct kb_cpu* cpu, uint64_t start, uint64_t len, int prot);
uint64_t kb_free_at(struct kb_cpu* cpu, uint64_t at, uint64_t len);
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

/* run.c: moves on whenever a mapping, executable code or the signal state
 * changes, from a signal handler too, so the bump is one atomic add */
extern volatile uint32_t kb_epoch;
#define KB_BUMP() ((void) __atomic_fetch_add(&kb_epoch, 1, __ATOMIC_RELAXED))

/* run.c */
int kb_cond(struct kb_cpu* cpu, int cond);
/* the flag bits made current before anything reads or writes them directly */
void kb_flags_sync(struct kb_cpu* cpu);
#define KB_SYNC(cpu)                                                           \
    do {                                                                       \
        if ((cpu)->lz) kb_flags_sync(cpu);                                     \
    } while (0)
/* -DKB_LAZY: 0 eager flags, 1 recorded and made when read, 2 conditions from
 * the record */
#ifndef KB_LAZY
    #define KB_LAZY 2
#endif
int kb_run(struct kb_cpu* cpu);
/* -DKB_POLL picks where pending signals are looked for: 2 (default) back-edges
 * and after a syscall; 0 every block, 1 back-edges only, 3 every KB_POLL_FUEL
 * blocks (lifted: block transitions); 1 and 3 miss signals, arms only. The
 * interpreter ignores it under KB_EPOCH, where the epoch guard polls */
#ifndef KB_POLL
    #define KB_POLL 2
#endif
#ifndef KB_POLL_FUEL
    #define KB_POLL_FUEL 64
#endif
#if KB_POLL == 2
extern int kb_syscalled;
#endif
#ifdef KB_HOT
/* KATYBUG_HOT=<dir>: every block the interpreter ran, with its IR and run
 * count, to <dir>/<pid>.hot */
void kb_hot_dump(struct kb_cpu* cpu);
#endif
#ifdef KB_COUNT
/* -DKB_COUNT with KATYBUG_COUNT=<file>: guest-state traffic and mapping checks,
 * appended to the file at exit (lifted regions add theirs through aot.h) */
struct kb_count {
    uint64_t rd, wr, refills, entries;
    uint64_t lat_n, lat_sum,
        lat_max;         /* host signal to the poll that sees it, ns */
    uint64_t sys[512];   /* syscalls by the guest's own number */
    uint64_t cat[10][2]; /* lifted code's cpu words read and written, by aot.h's
                            AOT_C_ category */
    /* the interpreter's checks, as run: a load or store's generation and range
     * compares, a block link's code generation, the signal poll's tests, the
     * thread and fault tests, the link and exit tests, the epoch compare and
     * what it found changed (deopts), signal polls made */
    uint64_t ck_gen, ck_range, ck_code, ck_poll, ck_thread, ck_fault, ck_link,
        ck_exit, ck_epoch, deopt_map, deopt_code, polls;
    /* state the guest reads that a later epoch would cover: fs base reads,
       cpuid, indirect jumps and trace side exits taken or not */
    uint64_t rd_fs, rd_cpuid, ijmp, exits;
    uint64_t bump_map, bump_sig;
};
extern struct kb_count kb_count;
void kb_count_report(struct kb_cpu* cpu);
    #define KB_BUMP_AS(kind) (kb_count.bump_##kind++, KB_BUMP())
#else
    #define KB_BUMP_AS(kind) KB_BUMP()
#endif
#ifdef KB_AOT
/* the lifted blocks (generated, see experiments/aot-oracle): attaches a region
 * to a block whose IR matches one exactly */
void kb_aot_attach(struct kb_cpu* cpu, struct kb_block* b);
void kb_aot_detach(struct kb_block* b);
void kb_aot_stale(struct kb_cpu* cpu);
void kb_aot_string(struct kb_cpu* cpu, int stos, int w, int rep);
extern volatile int* kb_pending_flag;
#endif

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

/* sys.c: guest descriptors are the host's, so katybug's own live at the top of
 * the table where the guest does not look; kb_log is where its diagnostics go
 * (a private copy of stderr, so a guest that closes fd 2 does not silence it),
 * and kb_own_fd copies a descriptor up there. A descriptor the host just made
 * for the guest goes through kb_newfd (EMFILE at the guest's soft limit), and
 * one at or past the base is kb_past_limit (EBADF) */
extern FILE* kb_log;
void kb_log_init(int resumed);
int kb_own_fd(int fd);
int kb_keep_fd(int fd);
FILE* kb_own_fopen(const char* path, const char* mode);
int kb_past_limit(int fd);
int64_t kb_newfd(int fd);
int64_t kb_newfd2(int* fds);
void kb_nofile_get(uint64_t out[2]);
void kb_nofile_set(const uint64_t in[2]);

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
/* a64v.c: one AArch64 FP/SIMD instruction, as KB_A64V; nonzero when unknown */
int kb_a64v(struct kb_cpu* cpu, const struct kb_ins* x);

/* sig.c */
int64_t kb_sigaction(struct kb_cpu* cpu, int s, uint64_t act, uint64_t old);
int64_t kb_sigprocmask(struct kb_cpu* cpu, int how, uint64_t set, uint64_t old);
void kb_raise(struct kb_cpu* cpu, int s, int code);
void kb_sigreturn(struct kb_cpu* cpu);
int kb_restart(struct kb_cpu* cpu, int restartable);
void kb_fxsave(struct kb_cpu* cpu, uint64_t at);
void kb_fxrstor(struct kb_cpu* cpu, uint64_t at);
void kb_signals(struct kb_cpu* cpu);
int kb_fault(struct kb_cpu* cpu, int s, int code, uint64_t addr);
int kb_host_sig(int s);
int64_t kb_sigsuspend(struct kb_cpu* cpu, uint64_t mask);
void kb_sig_reinstall(struct kb_cpu* cpu);
void kb_sig_inherit(struct kb_cpu* cpu);
int64_t kb_sigpending(struct kb_cpu* cpu, uint64_t set);
int64_t kb_timer(struct kb_cpu* cpu, int64_t nr, const uint64_t* a);

/* thread.c: guest threads, green, inside this one process; kb_cpu holds the
 * running one's state */
extern int kb_nthreads;
extern uint64_t kb_switches;
extern volatile int* kb_pending_flag; /* sig.c: a signal waits */
/* a call's result when another thread now runs */
#define KB_SWITCHED INT64_MIN
#define KB_SLICE 16384 /* back edges one thread runs before the next's turn */
int64_t kb_thread_clone(struct kb_cpu* cpu, const uint64_t* a);
int kb_thread_exit(struct kb_cpu* cpu);
int64_t kb_gettid(void);
int64_t kb_futex(struct kb_cpu* cpu, const uint64_t* a);
void kb_yield(struct kb_cpu* cpu);
int kb_thread_gate(
    struct kb_cpu* cpu, int64_t nr, const uint64_t* a, int64_t* v
);
void kb_thread_forked(void);
void kb_thread_called(void);

/* a growing op list for decoders */
struct kb_emit {
    struct kb_ins* ins;
    int n, cap;
};
void kb_put(struct kb_emit* e, int op, int w, int a, int b, int c, int64_t imm);

/* block fusion (run.c): a block runs on through up to KB_FUSE_MAX direct
 * jumps; -DKB_FUSE=0 ends every block at its first */
#ifndef KB_FUSE
    #define KB_FUSE 1
#endif
#define KB_FUSE_MAX 4
/* -DKB_CHAIN=0: every block looked up in the cache instead of through its
 * predecessor's link (run.c next_block) */
#ifndef KB_CHAIN
    #define KB_CHAIN 1
#endif
/* traces: a block run KB_TRACE_AT times is decoded again on through the hot
 * side of its biased branches, up to KB_TRACE segments by default
 * (KATYBUG_SEGMENTS=n sets 1 to KB_SEGS - 1); -DKB_TRACE=1 compiles them out */
#ifndef KB_TRACE
    #define KB_TRACE 32
#endif
#define KB_TRACE_AT 64
#define KB_SEGS 65
struct kb_fuse {
    struct kb_cpu* cpu;
    int trace;     /* decoding a trace */
    int n, jumps;  /* segments after the first; jumps fused */
    uint64_t head; /* where the block ending here alone starts */
    uint64_t lo[KB_SEGS], hi[KB_SEGS]; /* code the block holds */
};
int kb_fuse(
    struct kb_emit* e, const struct kb_block* b, struct kb_fuse* f,
    uint64_t end, uint64_t* at
);
/* the block keeps the code ranges f saw, the last ending at end */
void kb_fuse_done(struct kb_block* b, struct kb_fuse* f, uint64_t end);

/* persist.c: decoded blocks kept across processes under KATYBUG_CACHE */
void kb_persist_load(struct kb_cpu* cpu, const char* elf);
int kb_persist_take(struct kb_cpu* cpu, struct kb_block* b);
void kb_persist_save(struct kb_cpu* cpu);
uint64_t kb_code_hash(struct kb_cpu* cpu, const struct kb_block* b, int* ok);
int kb_block_ready(struct kb_cpu* cpu, struct kb_block* b);

#endif
