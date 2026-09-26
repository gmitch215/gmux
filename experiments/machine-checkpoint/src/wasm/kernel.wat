(module
	(import "env" "memory" (memory 2))
	(import "host" "block" (func $block (param i32 i32) (result i32)))
	(func (export "syscall") (param $task i32) (param $arg i32) (result i32)
		(local $pre i32)
		(local.set $pre (i32.add (i32.mul (local.get $arg) (i32.const 3)) (local.get $task)))
		(i32.store (i32.const 0) (i32.add (i32.load (i32.const 0)) (i32.const 1)))
		(i32.add (local.get $pre) (call $block (local.get $task) (local.get $arg)))))
