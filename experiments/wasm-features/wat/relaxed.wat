;; a dot-product loop over 4 KiB vectors: relaxed fused multiply-add against mul then add
(module
	(memory (export "memory") 1)
	(func (export "init") (local $i i32)
		(loop $l
			(f32.store (local.get $i) (f32.convert_i32_u (i32.and (local.get $i) (i32.const 255))))
			(local.set $i (i32.add (local.get $i) (i32.const 4)))
			(br_if $l (i32.lt_u (local.get $i) (i32.const 8192)))))
	(func $lanes (param $v v128) (result f64)
		(f64.promote_f32 (f32.add (f32.add (f32x4.extract_lane 0 (local.get $v)) (f32x4.extract_lane 1 (local.get $v)))
			(f32.add (f32x4.extract_lane 2 (local.get $v)) (f32x4.extract_lane 3 (local.get $v))))))
	(func (export "madd") (param $reps i32) (result f64) (local $j i32) (local $acc v128)
		(loop $r
			(local.set $j (i32.const 0))
			(loop $l
				(local.set $acc (f32x4.relaxed_madd (v128.load (local.get $j)) (v128.load offset=4096 (local.get $j))
					(f32x4.mul (local.get $acc) (f32x4.splat (f32.const 0.5)))))
				(local.set $j (i32.add (local.get $j) (i32.const 16)))
				(br_if $l (i32.lt_u (local.get $j) (i32.const 4096))))
			(local.set $reps (i32.sub (local.get $reps) (i32.const 1)))
			(br_if $r (local.get $reps)))
		(call $lanes (local.get $acc)))
	(func (export "muladd") (param $reps i32) (result f64) (local $j i32) (local $acc v128)
		(loop $r
			(local.set $j (i32.const 0))
			(loop $l
				(local.set $acc (f32x4.add (f32x4.mul (v128.load (local.get $j)) (v128.load offset=4096 (local.get $j)))
					(f32x4.mul (local.get $acc) (f32x4.splat (f32.const 0.5)))))
				(local.set $j (i32.add (local.get $j) (i32.const 16)))
				(br_if $l (i32.lt_u (local.get $j) (i32.const 4096))))
			(local.set $reps (i32.sub (local.get $reps) (i32.const 1)))
			(br_if $r (local.get $reps)))
		(call $lanes (local.get $acc))))
