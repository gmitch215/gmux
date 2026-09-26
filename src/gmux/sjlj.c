// runtime for LLVM 18's wasm setjmp/longjmp lowering (-mllvm
// -wasm-enable-sjlj); scripts/cc-strict compiles every program with it and
// links this in, with the tag from sjlj-tag.S
#include <setjmp.h>
#include <signal.h>
#include <stdint.h>
#include <stdlib.h>

typedef struct {
    uintptr_t id;
    uint32_t label;
} entry;

static uint32_t temp_ret;
static uintptr_t next_id;
// one host thread, and nothing suspends between the throw and its catch
static struct {
    void* env;
    int val;
} args;

uint32_t getTempRet0(void) {
    return temp_ret;
}

void setTempRet0(uint32_t value) {
    temp_ret = value;
}

entry* saveSetjmp(uintptr_t* env, uint32_t label, entry* table, uint32_t size) {
    uint32_t i = 0;
    while (i < size && table[i].id) i++;
    if (i == size) {
        size *= 2;
        table = realloc(table, sizeof(entry) * (size + 1));
        if (!table) abort();
    }
    *env = ++next_id;
    table[i].id = *env;
    table[i].label = label;
    table[i + 1].id = 0;
    temp_ret = size;
    return table;
}

uint32_t testSetjmp(uintptr_t id, entry* table, uint32_t size) {
    for (uint32_t i = 0; i < size && table[i].id; i++)
        if (table[i].id == id) return table[i].label;
    return 0;
}

_Noreturn void __wasm_longjmp(void* env, int val) {
    args.env = env;
    args.val = val ? val : 1;
    __builtin_wasm_throw(1, &args);
}

// for callers compiled without the lowering, and for function pointers
_Noreturn void longjmp(jmp_buf env, int val) {
    __wasm_longjmp(env, val);
}

_Noreturn void _longjmp(jmp_buf env, int val) {
    __wasm_longjmp(env, val);
}

void __gmux_sigsetjmp_save(sigjmp_buf buf, int save) {
    buf->__fl = save;
    if (save) pthread_sigmask(SIG_SETMASK, 0, (sigset_t*) buf->__ss);
}

// musl restores the saved mask when sigsetjmp returns the second time
int __gmux_sigsetjmp_tail(sigjmp_buf buf, int ret) {
    if (ret && buf->__fl)
        pthread_sigmask(SIG_SETMASK, (sigset_t*) buf->__ss, 0);
    return ret;
}
