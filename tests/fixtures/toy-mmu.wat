;; a user program for toy-kernel.wat ("m" on its console) built as scripts/wasm/mmu-pass.py builds them: its
;; start function reads page 9 through the page table, then _start reads page 10, stores the word at 0x830
;; for the test, and parks
(module
	(import "env" "memory" (memory 2 64 shared))
	(import "gmux" "tlb" (memory $tlb 1))
	(import "env" "__gmux_mmu_miss" (func $miss (param i32) (result i32)))
	(import "env" "__gmux_mmu_fault" (func $fault (param i32) (result i32)))
	(import "env" "__wasm_syscall_0" (func $syscall (param i32 i32 i32) (result i32)))

	(func $tr (param $a i32) (result i32)
		(local $e i32)
		(local.set $e (i32.load $tlb (i32.shl (i32.shr_u (local.get $a) (i32.const 12)) (i32.const 2))))
		(if (result i32) (i32.and (local.get $e) (i32.const 1))
			(then (i32.add (local.get $a) (i32.and (local.get $e) (i32.const -2))))
			(else
				(local.set $e (call $miss (local.get $a)))
				(if (result i32) (i32.eq (local.get $e) (i32.const -1))
					(then (call $fault (local.get $a)))
					(else (local.get $e))))))

	(func $init (drop (i32.load (call $tr (i32.const 0x9000)))))
	(start $init)

	(func (export "_start")
		(i32.store (i32.const 0x830) (i32.load (call $tr (i32.const 0xa000))))
		(drop (call $syscall (i32.const 0) (i32.const 0) (i32.const 4)))))
