(module
	(type (func (param i32) (result i32)))
	(memory (export "memory") 1)
	(global $__stack_pointer (mut i32) (i32.const 65536))
	(table 2 funcref)
	(elem (i32.const 0) $leafH $leafC)

	;; locals by index (ladder.ts counts a function's parameters from unnamed ones): 0 n, 1 acc, 2 fp, 3 r
	(func $hotA (export "hotA") (param i32 i32) (result i32)
		(local i32 i32)
		(global.set $__stack_pointer (local.tee 2 (i32.sub (global.get $__stack_pointer) (i32.const 16))))
		(i32.store (local.get 2) (local.get 0))
		(i32.store offset=4 (local.get 2) (local.get 1))
		(i32.store offset=8 (local.get 2) (i32.const 0xA11CE))
		(local.set 3
			(if (result i32) (i32.eqz (local.get 0))
				(then (local.get 1))
				(else (call $coldB (i32.sub (local.get 0) (i32.const 1)) (i32.add (i32.mul (local.get 1) (i32.const 3)) (i32.const 1))))))
		(local.set 3 (i32.add (local.get 3) (i32.mul (i32.load (local.get 2)) (i32.const 7))))
		(local.set 3 (i32.xor (local.get 3) (i32.load offset=4 (local.get 2))))
		(local.set 3 (i32.add (local.get 3) (i32.load offset=8 (local.get 2))))
		(global.set $__stack_pointer (i32.add (local.get 2) (i32.const 16)))
		(local.get 3))

	(func $coldB (export "coldB") (param i32 i32) (result i32)
		(local i32 i32)
		(global.set $__stack_pointer (local.tee 2 (i32.sub (global.get $__stack_pointer) (i32.const 16))))
		(i32.store (local.get 2) (local.get 0))
		(i32.store offset=4 (local.get 2) (local.get 1))
		(i32.store offset=8 (local.get 2) (i32.const 0xB0B))
		(local.set 3
			(if (result i32) (i32.eqz (local.get 0))
				(then (i32.add (local.get 1) (i32.const 11)))
				(else (call $hotA (i32.sub (local.get 0) (i32.const 1)) (i32.add (i32.mul (local.get 1) (i32.const 5)) (i32.const 2))))))
		(local.set 3 (i32.add (local.get 3) (i32.mul (i32.load (local.get 2)) (i32.const 13))))
		(local.set 3 (i32.xor (local.get 3) (i32.load offset=4 (local.get 2))))
		(local.set 3 (i32.add (local.get 3) (i32.load offset=8 (local.get 2))))
		(global.set $__stack_pointer (i32.add (local.get 2) (i32.const 16)))
		(local.get 3))

	(func $leafH (export "leafH") (param i32) (result i32)
		(i32.add (i32.mul (local.get 0) (local.get 0)) (i32.const 1)))

	(func $leafC (export "leafC") (param i32) (result i32)
		(local i32)
		(local.set 1 (i32.add (i32.load (i32.const 256)) (i32.const 1)))
		(i32.store (i32.const 256) (local.get 1))
		(i32.add (i32.mul (local.get 0) (i32.const 5)) (local.get 1)))

	(func $viaTab (export "viaTab") (param i32 i32) (result i32)
		(call_indirect (type 0) (local.get 1) (local.get 0)))

	(func $viaTabC (export "viaTabC") (param i32 i32) (result i32)
		(call_indirect (type 0) (local.get 1) (local.get 0)))

	(func $trapC (export "trapC") (param i32) (result i32)
		(i32.div_u (i32.const 100) (local.get 0)))

	(func $callTrap (export "callTrap") (param i32) (result i32)
		(i32.add (call $trapC (local.get 0)) (i32.const 1)))

	;; 0 n, 1 i, 2 s
	(func $run (export "run") (param i32) (result i32)
		(local i32 i32)
		(loop $l
			(local.set 2 (i32.xor (i32.mul (local.get 2) (i32.const 31)) (call $hotA (i32.const 20) (i32.add (local.get 1) (i32.const 1)))))
			(local.set 2 (i32.add (local.get 2) (call $viaTab (i32.and (local.get 1) (i32.const 1)) (local.get 1))))
			(local.set 2 (i32.add (local.get 2) (call $viaTabC (i32.and (local.get 2) (i32.const 1)) (local.get 1))))
			(local.set 1 (i32.add (local.get 1) (i32.const 1)))
			(br_if $l (i32.lt_u (local.get 1) (local.get 0))))
		(local.get 2))
)
