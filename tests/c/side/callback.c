// a side module for tests/c/control-flow.c: it calls back into the program
// through a function pointer and through a symbol the program exports, so a
// checkpoint finds frames of both modules. Each call counts, so a frame
// re-entered from its start instead of resumed changes the result
extern unsigned control_flow_hook(unsigned);

static unsigned calls;

unsigned through_pointer(unsigned (*f)(unsigned), unsigned x) {
    unsigned mine = x * 3 + calls++;
    return f(x + 1) + mine;
}

unsigned through_import(unsigned x) {
    unsigned mine = (x ^ 0x55) + calls++ * 100;
    return control_flow_hook(x * 2) + mine;
}
