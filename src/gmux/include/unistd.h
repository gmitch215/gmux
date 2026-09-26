// wasm cannot return twice from one call, so vfork is a setjmp in the caller:
// the child runs on, and the parent comes back to the setjmp with the child's
// pid (src/gmux/vfork.c)
#include_next <unistd.h>

#ifndef __GMUX_UNISTD_H
    #define __GMUX_UNISTD_H
    #include <setjmp.h>
struct __jmp_buf_tag* __gmux_vfork_slot(void);
pid_t __gmux_vfork_result(int);
    #define vfork() __gmux_vfork_result(setjmp(__gmux_vfork_slot()))
#endif
