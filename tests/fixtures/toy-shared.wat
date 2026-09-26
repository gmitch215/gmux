;; a program made shareable as scripts/wasm/share.ts does, for toy-kernel.wat's "w": a mutable memory base,
;; an exported GOT-style global, data relocated per process. Each process yields once and then checks that the
;; base, the global and its data are still its own
(module
	(import "env" "memory" (memory 2 64 shared))
	(import "env" "__memory_base" (global $mb (mut i32)))
	(import "env" "__table_base" (global $tb i32))
	(import "env" "__stack_pointer" (global $sp (mut i32)))
	(import "env" "__wasm_syscall_0" (func $syscall (param i32 i32 i32) (result i32)))
	(global $got (mut i32) (i32.const 0))
	(export "gmux_g4" (global $got))
	(start $init)
	(func $init (call $relocs))
	(func $relocs (export "__wasm_apply_global_relocs") (global.set $got (i32.add (global.get $mb) (i32.const 8))))
	(func (export "__wasm_apply_data_relocs") (i32.store (i32.add (global.get $mb) (i32.const 4)) (global.get $mb)))
	(func $sys (param $nr i32) (drop (call $syscall (i32.const 0) (i32.const 0) (local.get $nr))))
	(func (export "_start")
		(local $mine i32)
		(local.set $mine (global.get $mb))
		(i32.store (global.get $got) (local.get $mine))
		(call $sys (i32.const 10))
		(if (i32.and
				(i32.and
					(i32.eq (global.get $mb) (local.get $mine))
					(i32.eq (global.get $got) (i32.add (local.get $mine) (i32.const 8))))
				(i32.and
					(i32.eq (i32.load (i32.add (local.get $mine) (i32.const 4))) (local.get $mine))
					(i32.eq (i32.load (i32.add (local.get $mine) (i32.const 8))) (local.get $mine))))
			(then (call $sys (i32.const 11)))
			(else (call $sys (i32.const 12))))
		(call $sys (i32.const 13))))
