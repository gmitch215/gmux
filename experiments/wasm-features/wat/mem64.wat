;; mem32.wat's loop through a 64-bit memory
(module
	(memory (export "memory") i64 256)
	(func (export "init") (local $i i64)
		(loop $l
			(i64.store (local.get $i) (local.get $i))
			(local.set $i (i64.add (local.get $i) (i64.const 8)))
			(br_if $l (i64.lt_u (local.get $i) (i64.const 262144)))))
	(func (export "gather") (param $n i32) (result i64) (local $k i64) (local $acc i64)
		(loop $l
			(local.set $acc (i64.add (local.get $acc)
				(i64.load (i64.and (i64.mul (local.get $k) (i64.const 2654435761)) (i64.const 0x3fff8)))))
			(local.set $k (i64.add (local.get $k) (i64.const 1)))
			(br_if $l (i64.lt_u (local.get $k) (i64.extend_i32_u (local.get $n)))))
		(local.get $acc)))
