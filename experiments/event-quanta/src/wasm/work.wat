(module
	(import "host" "yield" (func $yield (param i32) (result i32)))
	(func $burn (export "burn") (param $n i32) (param $x i32) (result i32)
		(local $i i32)
		(block $done
			(loop $next
				(br_if $done (i32.ge_u (local.get $i) (local.get $n)))
				(local.set $x (i32.xor (local.get $x) (i32.shl (local.get $x) (i32.const 13))))
				(local.set $x (i32.xor (local.get $x) (i32.shr_u (local.get $x) (i32.const 17))))
				(local.set $x (i32.xor (local.get $x) (i32.shl (local.get $x) (i32.const 5))))
				(local.set $i (i32.add (local.get $i) (i32.const 1)))
				(br $next)))
		(local.get $x))
	(func (export "work") (param $chunks i32) (param $chunk i32) (param $quantum i32) (result i32)
		(local $c i32) (local $q i32) (local $x i32)
		(local.set $x (i32.const 1))
		(block $done
			(loop $next
				(br_if $done (i32.ge_u (local.get $c) (local.get $chunks)))
				(local.set $x (call $burn (local.get $chunk) (local.get $x)))
				(local.set $c (i32.add (local.get $c) (i32.const 1)))
				(local.set $q (i32.add (local.get $q) (i32.const 1)))
				(if (i32.ge_u (local.get $q) (local.get $quantum))
					(then
						(local.set $q (i32.const 0))
						(local.set $x (i32.xor (local.get $x) (call $yield (local.get $c))))))
				(br $next)))
		(local.get $x)))
