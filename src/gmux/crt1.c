// linux-wasm crt1 without its strong 3-argument main; scripts/cc-strict
// generates __gmux_main for the main the program defines
int __gmux_main(int, char**, char**);
__attribute__((weak)) void _init();
__attribute__((weak)) void _fini();
int __libc_start_main(
    int (*)(), int, char**, void (*)(), void (*)(), void (*)()
);

void _start_c(long* p) {
    int argc = p[0];
    char** argv = (void*) (p + 1);
    __libc_start_main((int (*)()) __gmux_main, argc, argv, _init, _fini, 0);
}

void _start(void) {
    int dummy;
    // the word at the page-aligned top of the stack holds the tables' address
    long* top = (long*) (((unsigned long) (void*) &dummy + 4095UL) & ~4095UL);
    _start_c((long*) top[-1]);
}
