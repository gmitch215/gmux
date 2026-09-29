#define LOOP(name, ...) \
name: \
	movz x9, #0x0000; \
	movk x9, #0x0100, lsl #16; \
1:	__VA_ARGS__; \
	subs x9, x9, #1; \
	b.ne 1b; \
	ret

	.globl _start
	.text
_start:
	adr x0, vals
	ldr q0, [x0]
	ldr q1, [x0, #16]
	ldr q2, [x0, #32]
	ldp d3, d4, [x0, #48]
	ldp s5, s6, [x0, #32]
	ldr q6, [x0, #48]
	ldr q7, [x0, #64]
	ldr q8, [x0, #80]
	bl WHICH
	mov x0, #0
	mov x8, #93
	svc #0
LOOP(vfmla, fmla v2.4s, v0.4s, v1.4s; fmla v2.4s, v1.4s, v0.4s; fmls v2.4s, v0.4s, v1.4s)
LOOP(sfmadd, fmadd d3, d4, d4, d3; fmadd s5, s6, s6, s5)
LOOP(sarith, fmul d3, d3, d4; fadd d3, d3, d4; fsub d3, d3, d4)
LOOP(mixed, fmul s5, s5, s6; fadd s5, s5, s6; fmadd d3, d4, d3, d4; fdiv d3, d3, d4; fmla v8.2d, v6.2d, v7.2d; fadd v2.4s, v2.4s, v1.4s)
	.balign 16
vals:
	.float 1.0001, 1.0002, 0.9999, 1.0003
	.float 1.0, 1.0001, 0.5, 1.0
	.float 0.25, 0.75, 1.0, 1.0
	.double 1.0001, 1.0002, 0.9999, 1.0003
	.double 0.25, 0.75
