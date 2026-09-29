#define MOV32(r, v) movz r, #((v) & 0xffff); movk r, #((v) >> 16), lsl #16

#ifndef OUTER
#define OUTER 1
#endif

#define SWEEP(name, from, count, outer, ...) \
name: \
	MOV32(x9, outer); \
1:	add x1, x0, from; \
	MOV32(x2, count); \
2:	ldr x3, [x1]; \
	add x4, x4, x3; \
	__VA_ARGS__; \
	subs x2, x2, #1; \
	b.ne 2b; \
	subs x9, x9, #1; \
	b.ne 1b; \
	ret

	.globl _start
	.text
_start:
	adrp x0, buf
	add x0, x0, :lo12:buf
	bl WHICH
	mov x0, #0
	mov x8, #93
	svc #0
SWEEP(narrow, #0, 256, 131072 * OUTER, add x1, x1, #8)
SWEEP(stream, #0, 524288, 64 * OUTER, add x1, x1, #8)
SWEEP(stride, #0, 1024, 32768 * OUTER, add x1, x1, #1, lsl #12)
SWEEP(straddle, #4092, 1024, 32768 * OUTER, add x1, x1, #1, lsl #12)

	.bss
	.balign 65536
buf:
	.skip 4194304 + 65536
