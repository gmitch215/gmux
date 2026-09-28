;; a user program for toy-kernel.wat ("n" on its console): opens a file O_SYNC (fd 5), writes to it and
;; to fd 6, msyncs the toy mapping with MS_SYNC and then MS_ASYNC, syncs, prints, and parks
(module
	(import "env" "memory" (memory 2 64 shared))
	(import "env" "__wasm_syscall_0" (func $syscall (param i32 i32 i32) (result i32)))
	(import "env" "__wasm_syscall_3" (func $syscall3 (param i32 i32 i32 i32 i32 i32) (result i32)))
	(import "env" "__wasm_syscall_4" (func $syscall4 (param i32 i32 i32 i32 i32 i32 i32) (result i32)))

	(func (export "_start")
		(drop (call $syscall4 (i32.const 0) (i32.const 0) (i32.const 56) (i32.const -100) (i32.const 0x750) (i32.const 0x101001) (i32.const 0)))
		(drop (call $syscall3 (i32.const 0) (i32.const 0) (i32.const 64) (i32.const 5) (i32.const 0x760) (i32.const 3)))
		(drop (call $syscall3 (i32.const 0) (i32.const 0) (i32.const 64) (i32.const 6) (i32.const 0x760) (i32.const 3)))
		(drop (call $syscall3 (i32.const 0) (i32.const 0) (i32.const 227) (i32.const 0xa0000) (i32.const 4096) (i32.const 4)))
		(drop (call $syscall3 (i32.const 0) (i32.const 0) (i32.const 227) (i32.const 0xa0000) (i32.const 4096) (i32.const 1)))
		(drop (call $syscall (i32.const 0) (i32.const 0) (i32.const 81)))
		(drop (call $syscall (i32.const 0) (i32.const 0) (i32.const 2)))
		(drop (call $syscall (i32.const 0) (i32.const 0) (i32.const 4)))))
