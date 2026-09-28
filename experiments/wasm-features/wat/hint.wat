;; one hot loop three times: no hints, hinted as it runs (the rare `if` unlikely, the back edge
;; likely), and hinted backwards; scripts/build.ts adds the metadata.code.branch_hint section, so a
;; runtime that reads hints shows the backwards copy slower
(module
	(func $cold (param $i i32) (result i32)
		(i32.mul (i32.xor (local.get $i) (i32.const 0x5bd1e995)) (i32.const 31)))

	(func $plain (export "plain") (param $n i32) (result i32) (local $i i32) (local $acc i32)
		(loop $l
			(local.set $acc (i32.add (local.get $acc) (i32.mul (local.get $i) (i32.const 3))))
			(if (i32.eqz (i32.and (local.get $i) (i32.const 1023)))
				(then (local.set $acc (i32.xor (local.get $acc) (call $cold (local.get $i))))))
			(local.set $i (i32.add (local.get $i) (i32.const 1)))
			(br_if $l (i32.lt_u (local.get $i) (local.get $n))))
		(local.get $acc))

	(func $right (export "right") (param $n i32) (result i32) (local $i i32) (local $acc i32)
		(loop $l
			(local.set $acc (i32.add (local.get $acc) (i32.mul (local.get $i) (i32.const 3))))
			(if (i32.eqz (i32.and (local.get $i) (i32.const 1023)))
				(then (local.set $acc (i32.xor (local.get $acc) (call $cold (local.get $i))))))
			(local.set $i (i32.add (local.get $i) (i32.const 1)))
			(br_if $l (i32.lt_u (local.get $i) (local.get $n))))
		(local.get $acc))

	(func $wrong (export "wrong") (param $n i32) (result i32) (local $i i32) (local $acc i32)
		(loop $l
			(local.set $acc (i32.add (local.get $acc) (i32.mul (local.get $i) (i32.const 3))))
			(if (i32.eqz (i32.and (local.get $i) (i32.const 1023)))
				(then (local.set $acc (i32.xor (local.get $acc) (call $cold (local.get $i))))))
			(local.set $i (i32.add (local.get $i) (i32.const 1)))
			(br_if $l (i32.lt_u (local.get $i) (local.get $n))))
		(local.get $acc)))
