;; a user program for toy-kernel.wat: takes a signal whose handler blocks, then parks; it links no clone code, so it
;; exports no __set_tls_base
(module
	(import "env" "memory" (memory 2 64 shared))
	(import "env" "__wasm_syscall_0" (func $syscall (param i32 i32 i32) (result i32)))

	(func (export "_start")
		(drop (call $syscall (i32.const 0) (i32.const 0) (i32.const 1)))
		(drop (call $syscall (i32.const 0) (i32.const 0) (i32.const 4))))

	;; the handler blocks (9 parks the task) before its sigreturn
	(func (export "__libc_handle_signal")
		(drop (call $syscall (i32.const 0) (i32.const 0) (i32.const 2)))
		(drop (call $syscall (i32.const 0) (i32.const 0) (i32.const 9)))
		(drop (call $syscall (i32.const 0) (i32.const 0) (i32.const 3)))))
