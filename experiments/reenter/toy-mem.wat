(module
	(memory (export "memory") 1 4)
	(global $__stack_pointer (mut i32) (i32.const 65536))
	(data (i32.const 100) "\01\02\03\04\05\06\07\08")

	;; n_* are promoted by the test, i_* stay interpreted; each pair has the same body
	(func $n_size (export "n_size") (result i32) (memory.size))
	(func $i_size (export "i_size") (result i32) (memory.size))
	(func $n_grow (export "n_grow") (param i32) (result i32) (memory.grow (local.get 0)))
	(func $i_grow (export "i_grow") (param i32) (result i32) (memory.grow (local.get 0)))
	(func $n_ld8 (export "n_ld8") (param i32) (result i32) (i32.load8_u (local.get 0)))
	(func $i_ld8 (export "i_ld8") (param i32) (result i32) (i32.load8_u (local.get 0)))
	(func $n_ld32 (export "n_ld32") (param i32) (result i32) (i32.load (local.get 0)))
	(func $i_ld32 (export "i_ld32") (param i32) (result i32) (i32.load (local.get 0)))
	(func $n_ld32off (export "n_ld32off") (param i32) (result i32) (i32.load offset=4294967292 (local.get 0)))
	(func $i_ld32off (export "i_ld32off") (param i32) (result i32) (i32.load offset=4294967292 (local.get 0)))
	(func $n_st8 (export "n_st8") (param i32 i32) (result i32) (i32.store8 (local.get 0) (local.get 1)) (i32.const 0))
	(func $i_st8 (export "i_st8") (param i32 i32) (result i32) (i32.store8 (local.get 0) (local.get 1)) (i32.const 0))
	(func $n_st32 (export "n_st32") (param i32 i32) (result i32) (i32.store (local.get 0) (local.get 1)) (i32.const 0))
	(func $i_st32 (export "i_st32") (param i32 i32) (result i32) (i32.store (local.get 0) (local.get 1)) (i32.const 0))
	(func $n_copy (export "n_copy") (param i32 i32 i32) (result i32) (memory.copy (local.get 0) (local.get 1) (local.get 2)) (i32.const 0))
	(func $i_copy (export "i_copy") (param i32 i32 i32) (result i32) (memory.copy (local.get 0) (local.get 1) (local.get 2)) (i32.const 0))
	(func $n_fill (export "n_fill") (param i32 i32 i32) (result i32) (memory.fill (local.get 0) (local.get 1) (local.get 2)) (i32.const 0))
	(func $i_fill (export "i_fill") (param i32 i32 i32) (result i32) (memory.fill (local.get 0) (local.get 1) (local.get 2)) (i32.const 0))

	;; ladder.ts counts instructions through run
	(func $run (export "run") (param i32) (result i32) (i32.add (call $i_ld32 (i32.const 100)) (local.get 0)))

	;; native calls interpreted: the interpreter grows, then native writes and reads the first new page
	(func $nCallI (export "nCallI") (param i32) (result i32)
		(local i32)
		(local.set 1 (call $i_grow (local.get 0)))
		(i32.store (i32.mul (local.get 1) (i32.const 65536)) (i32.const 77))
		(i32.add (i32.mul (local.get 1) (i32.const 1000)) (i32.load (i32.mul (local.get 1) (i32.const 65536)))))

	;; interpreted calls native: native grows, then the interpreter writes and reads the first new page
	(func $iCallN (export "iCallN") (param i32) (result i32)
		(local i32)
		(local.set 1 (call $n_grow (local.get 0)))
		(i32.store (i32.mul (local.get 1) (i32.const 65536)) (i32.const 55))
		(i32.add (i32.mul (local.get 1) (i32.const 1000)) (i32.load (i32.mul (local.get 1) (i32.const 65536)))))
)
