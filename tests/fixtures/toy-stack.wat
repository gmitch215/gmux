;; a user program for toy-kernel.wat ("b" on its console) with a frame that leaves its stack segment, so
;; the host maps the next one; prints and parks
(module
	(import "env" "memory" (memory 2 64 shared))
	(import "env" "__stack_pointer" (global $sp (mut i32)))
	(import "env" "__gmux_stack_move" (func $move (param i32) (result i32)))
	(import "env" "__wasm_syscall_0" (func $syscall (param i32 i32 i32) (result i32)))

	(func (export "__gmux_set_stack_limits") (param $high i32) (param $low i32))
	(func (export "_start")
		(global.set $sp (call $move (i32.const 0x2f00)))
		(drop (call $syscall (i32.const 0) (i32.const 0) (i32.const 4)))))
