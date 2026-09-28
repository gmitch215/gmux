;; a user program for toy-kernel.wat ("y" on its console): fsyncs fd 3, then fd 4, which has no name,
;; prints, and parks
(module
	(import "env" "memory" (memory 2 64 shared))
	(import "env" "__wasm_syscall_0" (func $syscall (param i32 i32 i32) (result i32)))
	(import "env" "__wasm_syscall_1" (func $syscall1 (param i32 i32 i32 i32) (result i32)))

	(func (export "_start")
		(drop (call $syscall1 (i32.const 0) (i32.const 0) (i32.const 82) (i32.const 3)))
		(drop (call $syscall1 (i32.const 0) (i32.const 0) (i32.const 83) (i32.const 4)))
		(drop (call $syscall (i32.const 0) (i32.const 0) (i32.const 2)))
		(drop (call $syscall (i32.const 0) (i32.const 0) (i32.const 4)))))
