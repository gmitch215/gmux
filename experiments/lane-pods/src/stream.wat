;; sequential reads over the first `bytes` of a 128 MiB memory, `passes` times; the sums keep the loads live
(module
	(memory (export "memory") 257 257)

	(func (export "fill") (param $bytes i32)
		(local $p i32)
		(loop $next
			(v128.store (local.get $p) (i32x4.splat (local.get $p)))
			(local.set $p (i32.add (local.get $p) (i32.const 16)))
			(br_if $next (i32.lt_u (local.get $p) (local.get $bytes)))))

	(func (export "simd") (param $bytes i32) (param $passes i32) (result i32)
		(local $p i32) (local $a v128) (local $b v128) (local $c v128) (local $d v128)
		(block $done
			(loop $pass
				(br_if $done (i32.eqz (local.get $passes)))
				(local.set $p (i32.const 0))
				(loop $next
					(local.set $a (i32x4.add (local.get $a) (v128.load (local.get $p))))
					(local.set $b (i32x4.add (local.get $b) (v128.load offset=16 (local.get $p))))
					(local.set $c (i32x4.add (local.get $c) (v128.load offset=32 (local.get $p))))
					(local.set $d (i32x4.add (local.get $d) (v128.load offset=48 (local.get $p))))
					(local.set $p (i32.add (local.get $p) (i32.const 64)))
					(br_if $next (i32.lt_u (local.get $p) (local.get $bytes))))
				(local.set $passes (i32.sub (local.get $passes) (i32.const 1)))
				(br $pass)))
		(local.set $a (i32x4.add (i32x4.add (local.get $a) (local.get $b)) (i32x4.add (local.get $c) (local.get $d))))
		(i32.add
			(i32.add (i32x4.extract_lane 0 (local.get $a)) (i32x4.extract_lane 1 (local.get $a)))
			(i32.add (i32x4.extract_lane 2 (local.get $a)) (i32x4.extract_lane 3 (local.get $a)))))

	(func (export "scalar") (param $bytes i32) (param $passes i32) (result i64)
		(local $p i32) (local $s i64)
		(block $done
			(loop $pass
				(br_if $done (i32.eqz (local.get $passes)))
				(local.set $p (i32.const 0))
				(loop $next
					(local.set $s (i64.add (local.get $s) (i64.load (local.get $p))))
					(local.set $p (i32.add (local.get $p) (i32.const 8)))
					(br_if $next (i32.lt_u (local.get $p) (local.get $bytes))))
				(local.set $passes (i32.sub (local.get $passes) (i32.const 1)))
				(br $pass)))
		(local.get $s)))
