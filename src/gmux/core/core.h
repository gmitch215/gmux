#ifndef CORE_H
#define CORE_H

#include <stddef.h>
#include <stdint.h>

/* the module's ABI version; a file that adds exports bumps it in core.c */
#define CORE_ABI 1

/* what the host calls; the module has no imports but its memory */
#define CORE_EXPORT __attribute__((visibility("default"), used))

/* the machine's memory, which the module shares with the kernel: a pointer
 * the host hands over is an address in it */
#define CORE_WORD(addr) (*(volatile uint64_t*) (uintptr_t) (addr))

#endif
