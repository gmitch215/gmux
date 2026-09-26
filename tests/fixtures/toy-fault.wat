;; a user program for toy-kernel.wat ("f" on its console) that traps at once
(module
	(import "env" "memory" (memory 2 64 shared))
	(func (export "_start") unreachable))
