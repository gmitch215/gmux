;; a user program that asks the host for a capability outside the syscall surface (SECURITY.md)
(module
	(import "env" "memory" (memory 2 64 shared))
	(import "env" "fetch" (func $fetch (param i32) (result i32)))
	(func (export "_start") (drop (call $fetch (i32.const 0)))))
