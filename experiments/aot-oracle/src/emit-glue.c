#include <stddef.h>

#include "aot.h"

/* what a region emitted by emit.ts calls that is a static inline elsewhere */

const int kb_aot_layout[] = {
    (int) sizeof(struct kb_ins),
    (int) sizeof(struct kb_ic),
    (int) offsetof(struct kb_ic, lo),
    (int) offsetof(struct kb_ic, span),
    (int) offsetof(struct kb_ic, host),
    (int) offsetof(struct kb_ic, gen),
    (int) offsetof(struct kb_cpu, r),
    (int) offsetof(struct kb_cpu, pc),
    (int) offsetof(struct kb_cpu, fs),
    (int) offsetof(struct kb_cpu, n),
    (int) offsetof(struct kb_cpu, z),
    (int) offsetof(struct kb_cpu, c),
    (int) offsetof(struct kb_cpu, v),
    (int) offsetof(struct kb_cpu, p),
    (int) offsetof(struct kb_cpu, df),
    (int) offsetof(struct kb_cpu, exited),
    (int) offsetof(struct kb_cpu, mapgen),
    (int) offsetof(struct kb_cpu, fault),
    (int) offsetof(struct kb_cpu, ipc),
    (int) offsetof(struct kb_cpu, fault_sig),
    (int) offsetof(struct kb_cpu, sigreturned),
    (int) offsetof(struct kb_block, ins),
    (int) offsetof(struct kb_block, ic),
};

uint64_t kb_aot_umulh(uint64_t a, uint64_t b) {
    return kb_umulh(a, b);
}

uint64_t kb_aot_smulh(uint64_t a, uint64_t b) {
    return kb_smulh(a, b);
}

/* x86 mul, imul, div, idiv over the cpu's rax and rdx: bit 0 is a divide error
   (the registers untouched, the fault set), bit 1 the carry and overflow of a
   multiply */
int kb_aot_md(struct kb_cpu* cpu, int kind, int w, uint64_t v) {
    if (kind == 4 || kind == 5)
        return kb_mul(kind == 5, w, &cpu->r[0], &cpu->r[2], v) << 1;
    if (!kb_divide(kind == 7, w, &cpu->r[0], &cpu->r[2], v)) return 0;
    cpu->fault = "divide error";
    cpu->fault_sig = 8;
    return 1;
}

/* an SSE or x87 helper that refused its instruction */
void kb_aot_unknown(struct kb_cpu* cpu, int x87) {
    cpu->fault = x87 ? "unknown x87 instruction" : "unknown sse instruction";
    cpu->fault_sig = 4;
}
