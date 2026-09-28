;; writes a zeroed page to /data/mapped, maps it MAP_SHARED, stores a line into the mapping, msyncs it
;; with FLAGS (the rig puts MS_SYNC or MS_ASYNC in) and exits 0; exits 1, 2 or 3 when the open, the
;; write or the mmap fails
(module
	(@dylink.0 (mem-info (memory 32 4)))
	(import "env" "memory" (memory 1 65536 shared))
	(import "env" "__stack_pointer" (global $sp (mut i32)))
	(import "env" "__memory_base" (global $base i32))
	(import "env" "__wasm_syscall_1" (func $s1 (param i32 i32 i32 i32) (result i32)))
	(import "env" "__wasm_syscall_3" (func $s3 (param i32 i32 i32 i32 i32 i32) (result i32)))
	(import "env" "__wasm_syscall_4" (func $s4 (param i32 i32 i32 i32 i32 i32 i32) (result i32)))
	(import "env" "__wasm_syscall_6" (func $s6 (param i32 i32 i32 i32 i32 i32 i32 i32 i32) (result i32)))
	(data (global.get $base) "/data/mapped\00mapped line\n")

	(func $exit (param $code i32)
		(drop (call $s1 (global.get $sp) (i32.const 0) (i32.const 94) (local.get $code)))
		(unreachable))

	(func (export "_start")
		(local $fd i32)
		(local $page i32)
		(local $at i32)
		;; O_RDWR | O_CREAT | O_TRUNC
		(local.set $fd
			(call $s4 (global.get $sp) (i32.const 0) (i32.const 56) (i32.const -100) (global.get $base)
				(i32.const 578) (i32.const 420)))
		(if (i32.lt_s (local.get $fd) (i32.const 0)) (then (call $exit (i32.const 1))))
		;; a zeroed page below the stack, written as the file's contents
		(local.set $page (i32.and (i32.sub (global.get $sp) (i32.const 8192)) (i32.const -4096)))
		(memory.fill (local.get $page) (i32.const 0) (i32.const 4096))
		(if (i32.ne
				(call $s3 (global.get $sp) (i32.const 0) (i32.const 64) (local.get $fd) (local.get $page)
					(i32.const 4096))
				(i32.const 4096))
			(then (call $exit (i32.const 2))))
		;; PROT_READ | PROT_WRITE, MAP_SHARED
		(local.set $at
			(call $s6 (global.get $sp) (i32.const 0) (i32.const 222) (i32.const 0) (i32.const 4096)
				(i32.const 3) (i32.const 1) (local.get $fd) (i32.const 0)))
		(if (i32.and (i32.lt_s (local.get $at) (i32.const 0)) (i32.gt_s (local.get $at) (i32.const -4096)))
			(then (call $exit (i32.const 3))))
		(memory.copy (local.get $at) (i32.add (global.get $base) (i32.const 13)) (i32.const 12))
		(drop
			(call $s3 (global.get $sp) (i32.const 0) (i32.const 227) (local.get $at) (i32.const 4096)
				(i32.const FLAGS)))
		(call $exit (i32.const 0))))
