// the exception tag the setjmp lowering catches; clang 18 crashes on it as C asm
.tagtype __c_longjmp i32
.globl __c_longjmp
__c_longjmp:
