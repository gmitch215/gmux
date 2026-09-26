.globl _start
_start:
	mov $1, %edi
	lea msg(%rip), %rsi
	mov $6, %edx
	mov $1, %eax
	syscall
	mov $60, %eax
	xor %edi, %edi
	syscall
msg:	.ascii "hello\n"
