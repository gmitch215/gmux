;; one loop per crossing kind, n iterations each, so a kind's cost is its loop less the empty loop
(module
	(import "native" "host" (func $host (param i32) (result i32)))
	(import "native" "thunk" (func $thunk (param i32 i32) (result i32)))

	(func $callee (param i32) (result i32) (i32.add (local.get 0) (i32.const 1)))

	(func (export "nop") (param i32) (result i32) (i32.add (local.get 0) (i32.const 1)))

	(func (export "empty") (param $n i32) (result i32)
		(local $i i32) (local $s i32)
		(loop $next
			(local.set $s (i32.add (local.get $s) (i32.const 1)))
			(local.set $i (i32.add (local.get $i) (i32.const 1)))
			(br_if $next (i32.lt_u (local.get $i) (local.get $n))))
		(local.get $s))

	(func (export "local") (param $n i32) (result i32)
		(local $i i32) (local $s i32)
		(loop $next
			(local.set $s (call $callee (local.get $s)))
			(local.set $i (i32.add (local.get $i) (i32.const 1)))
			(br_if $next (i32.lt_u (local.get $i) (local.get $n))))
		(local.get $s))

	(func (export "host") (param $n i32) (result i32)
		(local $i i32) (local $s i32)
		(loop $next
			(local.set $s (call $host (local.get $s)))
			(local.set $i (i32.add (local.get $i) (i32.const 1)))
			(br_if $next (i32.lt_u (local.get $i) (local.get $n))))
		(local.get $s))

	(func (export "thunk") (param $n i32) (result i32)
		(local $i i32) (local $s i32)
		(loop $next
			(local.set $s (call $thunk (i32.const 1024) (local.get $s)))
			(local.set $i (i32.add (local.get $i) (i32.const 1)))
			(br_if $next (i32.lt_u (local.get $i) (local.get $n))))
		(local.get $s))
)
