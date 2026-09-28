;; writes two lines to /data/osync, opened with FLAGS (the rig puts O_SYNC in, or leaves it out), and
;; exits 0; exits 1 when the open fails and 2 when a write is short
(module
	(@dylink.0 (mem-info (memory 64 4)))
	(import "env" "memory" (memory 1 65536 shared))
	(import "env" "__stack_pointer" (global $sp (mut i32)))
	(import "env" "__memory_base" (global $base i32))
	(import "env" "__wasm_syscall_1" (func $s1 (param i32 i32 i32 i32) (result i32)))
	(import "env" "__wasm_syscall_3" (func $s3 (param i32 i32 i32 i32 i32 i32) (result i32)))
	(import "env" "__wasm_syscall_4" (func $s4 (param i32 i32 i32 i32 i32 i32 i32) (result i32)))
	(data (global.get $base) "/data/osync\00osync line one\n\00\00\00osync line two\n")

	(func $exit (param $code i32)
		(drop (call $s1 (global.get $sp) (i32.const 0) (i32.const 94) (local.get $code)))
		(unreachable))

	(func $write (param $fd i32) (param $at i32)
		(if (i32.ne
				(call $s3 (global.get $sp) (i32.const 0) (i32.const 64) (local.get $fd)
					(i32.add (global.get $base) (local.get $at)) (i32.const 15))
				(i32.const 15))
			(then (call $exit (i32.const 2)))))

	(func (export "_start")
		(local $fd i32)
		(local.set $fd
			(call $s4 (global.get $sp) (i32.const 0) (i32.const 56) (i32.const -100) (global.get $base)
				(i32.const FLAGS) (i32.const 420)))
		(if (i32.lt_s (local.get $fd) (i32.const 0)) (then (call $exit (i32.const 1))))
		(call $write (local.get $fd) (i32.const 12))
		(call $write (local.get $fd) (i32.const 30))
		(call $exit (i32.const 0))))
