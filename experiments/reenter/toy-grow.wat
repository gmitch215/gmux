(module
	(memory (export "memory") 1)
	(global $__stack_pointer (mut i32) (i32.const 65536))

	(func $growC (export "growC") (param i32) (result i32)
		(memory.grow (local.get 0)))

	(func $callGrow (export "callGrow") (param i32) (result i32)
		(call $growC (local.get 0)))

	(func $run (export "run") (param i32) (result i32)
		(call $callGrow (i32.const 0)))
)
