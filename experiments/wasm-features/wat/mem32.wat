;; cache-resident scattered loads (256 KiB) through a 32-bit memory; mem64.wat is the same loop
;; through a 64-bit one, with the same index arithmetic in i64
(module
	(memory (export "memory") 256)
	(func (export "init") (local $i i32)
		(loop $l
			(i64.store (local.get $i) (i64.extend_i32_u (local.get $i)))
			(local.set $i (i32.add (local.get $i) (i32.const 8)))
			(br_if $l (i32.lt_u (local.get $i) (i32.const 262144)))))
	(func (export "gather") (param $n i32) (result i64) (local $k i64) (local $acc i64)
		(loop $l
			(local.set $acc (i64.add (local.get $acc)
				(i64.load (i32.wrap_i64 (i64.and (i64.mul (local.get $k) (i64.const 2654435761)) (i64.const 0x3fff8))))))
			(local.set $k (i64.add (local.get $k) (i64.const 1)))
			(br_if $l (i64.lt_u (local.get $k) (i64.extend_i32_u (local.get $n)))))
		(local.get $acc)))
