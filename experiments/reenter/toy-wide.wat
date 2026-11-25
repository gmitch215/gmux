(module
	(memory (export "memory") 1)
	(global $__stack_pointer (mut i32) (i32.const 65536))

	;; hot12 and cold12 take twelve parameters each and call one another, so each crossing is arity thirteen
	;; with the stack pointer: promoted hot12 reaches interpreted cold12 through call_at_wide, and interpreted
	;; cold12 reaches promoted hot12 through host_wide. leaf18 is the widest the bridge carries, nineteen slots.
	(func $hot12 (export "hot12") (param i32 i32 i32 i32 i32 i32 i32 i32 i32 i32 i32 i32) (result i32)
		(if (result i32) (i32.eqz (local.get 0))
			(then (i32.add (i32.add (local.get 1) (local.get 11)) (local.get 6)))
			(else (call $cold12
				(i32.sub (local.get 0) (i32.const 1))
				(i32.mul (local.get 1) (i32.const 3))
				(local.get 2) (local.get 3) (local.get 4) (local.get 5) (local.get 6)
				(local.get 7) (local.get 8) (local.get 9) (local.get 10)
				(i32.add (local.get 11) (i32.const 1))))))

	(func $cold12 (export "cold12") (param i32 i32 i32 i32 i32 i32 i32 i32 i32 i32 i32 i32) (result i32)
		(if (result i32) (i32.eqz (local.get 0))
			(then (i32.add (local.get 1) (i32.add (local.get 10) (local.get 11))))
			(else (call $hot12
				(i32.sub (local.get 0) (i32.const 1))
				(i32.add (local.get 1) (i32.const 1))
				(local.get 2) (local.get 3) (local.get 4) (local.get 5) (local.get 6)
				(local.get 7) (local.get 8) (local.get 9) (local.get 10) (local.get 11)))))

	(func $leaf18 (export "leaf18")
		(param i32 i32 i32 i32 i32 i32 i32 i32 i32 i32 i32 i32 i32 i32 i32 i32 i32 i32) (result i32)
		(i32.add (i32.add (local.get 0) (local.get 17)) (i32.mul (local.get 9) (i32.const 7))))

	(func $hotV (export "hotV") (param i32 i32 i32 i32 i32 i32 i32 i32 i32 i32)
		(i32.store (i32.const 512) (i32.add (local.get 0) (local.get 9))))

	(func $run (export "run") (param $n i32) (result i32)
		(local $i i32) (local $acc i32)
		(loop $next
			(local.set $acc (call $hot12 (local.get $i) (local.get $acc)
				(i32.const 2) (i32.const 3) (i32.const 4) (i32.const 5) (i32.const 6)
				(i32.const 7) (i32.const 8) (i32.const 9) (i32.const 10) (i32.const 11)))
			(local.set $acc (call $leaf18 (local.get $acc) (local.get $i)
				(i32.const 1) (i32.const 2) (i32.const 3) (i32.const 4) (i32.const 5) (i32.const 6)
				(i32.const 7) (i32.const 8) (i32.const 9) (i32.const 10) (i32.const 11) (i32.const 12)
				(i32.const 13) (i32.const 14) (i32.const 15) (i32.const 16)))
			(call $hotV (local.get $acc) (local.get $i)
				(i32.const 0) (i32.const 0) (i32.const 0) (i32.const 0) (i32.const 0) (i32.const 0)
				(i32.const 1) (i32.const 2))
			(local.set $i (i32.add (local.get $i) (i32.const 1)))
			(br_if $next (i32.lt_u (local.get $i) (local.get $n))))
		(local.get $acc))

	;; one-argument entries, so the host can call the wide functions (a host call takes four arguments)
	(func $hot12Drive (export "hot12Drive") (param $n i32) (result i32)
		(call $hot12 (local.get $n)
			(i32.const 1) (i32.const 2) (i32.const 3) (i32.const 4) (i32.const 5) (i32.const 6)
			(i32.const 7) (i32.const 8) (i32.const 9) (i32.const 10) (i32.const 11)))
	(func $cold12Drive (export "cold12Drive") (param $n i32) (result i32)
		(call $cold12 (local.get $n)
			(i32.const 1) (i32.const 2) (i32.const 3) (i32.const 4) (i32.const 5) (i32.const 6)
			(i32.const 7) (i32.const 8) (i32.const 9) (i32.const 10) (i32.const 11)))
	(func $leafDrive (export "leafDrive") (param $n i32) (result i32)
		(call $leaf18 (local.get $n)
			(i32.const 2) (i32.const 3) (i32.const 4) (i32.const 5) (i32.const 6) (i32.const 7)
			(i32.const 8) (i32.const 9) (i32.const 10) (i32.const 11) (i32.const 12) (i32.const 13)
			(i32.const 14) (i32.const 15) (i32.const 16) (i32.const 17) (i32.const 18)))
)
