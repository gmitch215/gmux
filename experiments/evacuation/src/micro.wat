;; the non-throwing cost of a cold checkpoint handler around every call: fib and a call-heavy loop, plain
;; and with each call in a try whose catch spills the frame's locals to memory and rethrows
(module
	(memory 1)
	(tag $ckpt)
	(global $fp (mut i32) (i32.const 1024))

	(func $leaf (param $x i32) (result i32) (i32.add (i32.mul (local.get $x) (i32.const 3)) (i32.const 1)))

	(func $fib (export "fib") (param $n i32) (result i32)
		(if (result i32) (i32.lt_u (local.get $n) (i32.const 2))
			(then (local.get $n))
			(else (i32.add (call $fib (i32.sub (local.get $n) (i32.const 1))) (call $fib (i32.sub (local.get $n) (i32.const 2)))))))

	(func $loop (export "loop") (param $n i32) (result i32)
		(local $i i32) (local $s i32)
		(loop $next
			(local.set $s (i32.add (local.get $s) (call $leaf (local.get $i))))
			(br_if $next (i32.lt_u (local.tee $i (i32.add (local.get $i) (i32.const 1))) (local.get $n))))
		(local.get $s))

	;; fib with fib_eh's shape (the first result in a local) and no handlers, to separate the two costs
	(func $fib_flat (export "fib_flat") (param $n i32) (result i32)
		(local $a i32)
		(if (result i32) (i32.lt_u (local.get $n) (i32.const 2))
			(then (local.get $n))
			(else
				(local.set $a (call $fib_flat (i32.sub (local.get $n) (i32.const 1))))
				(i32.add (local.get $a) (call $fib_flat (i32.sub (local.get $n) (i32.const 2)))))))

	(func $fib_eh (export "fib_eh") (param $n i32) (result i32)
		(local $a i32)
		(if (result i32) (i32.lt_u (local.get $n) (i32.const 2))
			(then (local.get $n))
			(else
				(try
					(do (local.set $a (call $fib_eh (i32.sub (local.get $n) (i32.const 1)))))
					(catch $ckpt
						(i32.store (global.get $fp) (local.get $n))
						(i32.store offset=4 (global.get $fp) (i32.const 1))
						(global.set $fp (i32.add (global.get $fp) (i32.const 8)))
						(rethrow 0)))
				(try (result i32)
					(do (i32.add (local.get $a) (call $fib_eh (i32.sub (local.get $n) (i32.const 2)))))
					(catch $ckpt
						(i32.store (global.get $fp) (local.get $n))
						(i32.store offset=4 (global.get $fp) (local.get $a))
						(i32.store offset=8 (global.get $fp) (i32.const 2))
						(global.set $fp (i32.add (global.get $fp) (i32.const 12)))
						(rethrow 0))))))

	(func $loop_eh (export "loop_eh") (param $n i32) (result i32)
		(local $i i32) (local $s i32) (local $r i32)
		(loop $next
			(try
				(do (local.set $r (call $leaf (local.get $i))))
				(catch $ckpt
					(i32.store (global.get $fp) (local.get $i))
					(i32.store offset=4 (global.get $fp) (local.get $s))
					(i32.store offset=8 (global.get $fp) (i32.const 3))
					(global.set $fp (i32.add (global.get $fp) (i32.const 12)))
					(rethrow 0)))
			(local.set $s (i32.add (local.get $s) (local.get $r)))
			(br_if $next (i32.lt_u (local.tee $i (i32.add (local.get $i) (i32.const 1))) (local.get $n))))
		(local.get $s)))
