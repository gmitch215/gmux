;; multi.wat's loop with the counters in the guest memory, 16 MiB up
(module
	(memory (export "memory") 257)
	(func (export "init") (local $i i32)
		(loop $l
			(i64.store (local.get $i) (i64.extend_i32_u (local.get $i)))
			(local.set $i (i32.add (local.get $i) (i32.const 8)))
			(br_if $l (i32.lt_u (local.get $i) (i32.const 262144)))))
	(func (export "gather") (param $n i32) (result i64) (local $k i32) (local $a i32) (local $m i32) (local $acc i64)
		(loop $l
			(local.set $a (i32.and (i32.mul (local.get $k) (i32.const 2654435761)) (i32.const 0x3fff8)))
			(local.set $acc (i64.add (local.get $acc) (i64.load (local.get $a))))
			(local.set $m (i32.add (i32.const 16777216) (i32.shl (i32.shr_u (local.get $a) (i32.const 12)) (i32.const 2))))
			(i32.store (local.get $m) (i32.add (i32.load (local.get $m)) (i32.const 1)))
			(local.set $k (i32.add (local.get $k) (i32.const 1)))
			(br_if $l (i32.lt_u (local.get $k) (local.get $n))))
		(i64.add (local.get $acc) (i64.extend_i32_u (i32.load (i32.const 16777216))))))
