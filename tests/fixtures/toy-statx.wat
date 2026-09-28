;; a user program for toy-kernel.wat ("t" on its console): statxes /toy/file twice and toy/file once,
;; prints, parks until "r", statxes /toy/file twice more, prints and parks
(module
	(import "env" "memory" (memory 2 64 shared))
	(import "env" "__wasm_syscall_0" (func $s0 (param i32 i32 i32) (result i32)))
	(import "env" "__wasm_syscall_5" (func $s5 (param i32 i32 i32 i32 i32 i32 i32 i32) (result i32)))

	;; statx(AT_FDCWD, path, 0, STATX_BASIC_STATS, 0x3000) on a stack at 0x9800
	(func $statx (param $path i32) (result i32)
		(call $s5 (i32.const 0x9800) (i32.const 0) (i32.const 291) (i32.const -100) (local.get $path)
			(i32.const 0) (i32.const 0x7ff) (i32.const 0x3000)))

	(func $call (param $nr i32)
		(drop (call $s0 (i32.const 0x9800) (i32.const 0) (local.get $nr))))

	(func (export "_start")
		(drop (call $statx (i32.const 0x750)))
		(drop (call $statx (i32.const 0x750)))
		(drop (call $statx (i32.const 0x751)))
		(call $call (i32.const 2))
		(call $call (i32.const 9))
		(drop (call $statx (i32.const 0x750)))
		(drop (call $statx (i32.const 0x750)))
		(call $call (i32.const 4))))
