;; a vfork caller for toy-kernel.wat, speaking the host side of src/gmux/vfork.c: the parent's stack
;; runs the child until its execve, then returns to the parent with the child's pid
(module
	(import "env" "memory" (memory 2 64 shared))
	(import "env" "__wasm_syscall_0" (func $syscall (param i32 i32 i32) (result i32)))
	(import "env" "__gmux_vfork" (func $vfork (param i32) (result i32)))
	(import "env" "__gmux_vfork_exec" (func $exec (param i32 i32 i32) (result i32)))

	(func $sys (param $nr i32) (drop (call $syscall (i32.const 0) (i32.const 0) (local.get $nr))))

	(func (export "_start")
		(if (call $vfork (i32.const 0x7000)) (then (call $sys (i32.const 7)) (unreachable)))
		(call $sys (i32.const 5))
		(if (i32.eq (call $exec (i32.const 0) (i32.const 0) (i32.const 0)) (i32.const 4))
			(then (call $sys (i32.const 6)))
			(else (call $sys (i32.const 7))))
		(call $sys (i32.const 8))))
