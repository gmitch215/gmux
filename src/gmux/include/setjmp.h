// the wasm lowering only rewrites calls named setjmp, so sigsetjmp becomes one
#include_next <setjmp.h>

#ifndef __GMUX_SETJMP_H
    #define __GMUX_SETJMP_H
void __gmux_sigsetjmp_save(struct __jmp_buf_tag*, int);
int __gmux_sigsetjmp_tail(struct __jmp_buf_tag*, int);
    #define sigsetjmp(buf, save)                                               \
        (__gmux_sigsetjmp_save((buf), (save)),                                 \
         __gmux_sigsetjmp_tail((buf), setjmp(buf)))
#endif
