(module
	(import "env" "memory" (memory 2))
	(import "kernel" "syscall" (func $sys (param i32 i32) (result i32)))
	(func $deep (param $task i32) (param $d i32) (param $i i32) (result i32)
		(local $acc i32)
		(if (result i32) (i32.eqz (local.get $d))
			(then (call $sys (local.get $task) (local.get $i)))
			(else
				(local.set $acc (i32.add (i32.mul (local.get $d) (i32.const 1000)) (local.get $i)))
				(i32.add
					(call $deep (local.get $task) (i32.sub (local.get $d) (i32.const 1)) (local.get $i))
					(local.get $acc)))))
	(func (export "run") (param $task i32) (param $iters i32) (param $depth i32) (result i32)
		(local $i i32) (local $sum i32)
		(block $done
			(loop $next
				(br_if $done (i32.ge_u (local.get $i) (local.get $iters)))
				(local.set $sum
					(i32.add (local.get $sum) (call $deep (local.get $task) (local.get $depth) (local.get $i))))
				(local.set $i (i32.add (local.get $i) (i32.const 1)))
				(br $next)))
		(local.get $sum)))
