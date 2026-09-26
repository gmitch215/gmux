;; the cost of one translation per load, isolated: a sum over 16 MiB with no translation, with a
;; page table in a second memory, with the page table in the same memory at a base in a global, and
;; hoisted: one translation per 4 KiB page, the loads inside the page direct (a translated block that
;; resolves its pages on entry)
(module
	(memory $m 512 512)
	(memory $t 1 1)
	(global $pt (mut i32) (i32.const 0x1000000))

	(func (export "plain") (param $n i32) (param $passes i32) (result i32)
		(local $p i32) (local $s i32)
		(loop $pass
			(local.set $p (i32.const 0))
			(loop $next
				(local.set $s (i32.add (local.get $s) (i32.load $m (local.get $p))))
				(br_if $next (i32.lt_u (local.tee $p (i32.add (local.get $p) (i32.const 4))) (local.get $n))))
			(br_if $pass (local.tee $passes (i32.sub (local.get $passes) (i32.const 1)))))
		(local.get $s))

	(func (export "second") (param $n i32) (param $passes i32) (result i32)
		(local $p i32) (local $s i32) (local $e i32)
		(loop $pass
			(local.set $p (i32.const 0))
			(loop $next
				(local.set $e (i32.load $t (i32.shl (i32.shr_u (local.get $p) (i32.const 12)) (i32.const 2))))
				(local.set $s (i32.add (local.get $s)
					(i32.load $m (i32.add (local.get $p) (i32.and (local.get $e) (i32.const -2))))))
				(br_if $next (i32.lt_u (local.tee $p (i32.add (local.get $p) (i32.const 4))) (local.get $n))))
			(br_if $pass (local.tee $passes (i32.sub (local.get $passes) (i32.const 1)))))
		(local.get $s))

	(func (export "same") (param $n i32) (param $passes i32) (result i32)
		(local $p i32) (local $s i32) (local $e i32)
		(loop $pass
			(local.set $p (i32.const 0))
			(loop $next
				(local.set $e (i32.load $m (i32.add (global.get $pt) (i32.shl (i32.shr_u (local.get $p) (i32.const 12)) (i32.const 2)))))
				(local.set $s (i32.add (local.get $s)
					(i32.load $m (i32.add (local.get $p) (i32.and (local.get $e) (i32.const -2))))))
				(br_if $next (i32.lt_u (local.tee $p (i32.add (local.get $p) (i32.const 4))) (local.get $n))))
			(br_if $pass (local.tee $passes (i32.sub (local.get $passes) (i32.const 1)))))
		(local.get $s))

	(func (export "hoisted") (param $n i32) (param $passes i32) (result i32)
		(local $page i32) (local $base i32) (local $off i32) (local $s i32)
		(loop $pass
			(local.set $page (i32.const 0))
			(loop $pages
				;; resolve the page once
				(local.set $base (i32.add (local.get $page)
					(i32.and (i32.load $t (i32.shl (i32.shr_u (local.get $page) (i32.const 12)) (i32.const 2))) (i32.const -2))))
				(local.set $off (i32.const 0))
				(loop $next
					(local.set $s (i32.add (local.get $s) (i32.load $m (i32.add (local.get $base) (local.get $off)))))
					(br_if $next (i32.lt_u (local.tee $off (i32.add (local.get $off) (i32.const 4))) (i32.const 4096))))
				(br_if $pages (i32.lt_u (local.tee $page (i32.add (local.get $page) (i32.const 4096))) (local.get $n))))
			(br_if $pass (local.tee $passes (i32.sub (local.get $passes) (i32.const 1)))))
		(local.get $s))

	;; hoisted's loop shape with no translation, to separate the shape from the translation
	(func (export "nested") (param $n i32) (param $passes i32) (result i32)
		(local $page i32) (local $off i32) (local $s i32)
		(loop $pass
			(local.set $page (i32.const 0))
			(loop $pages
				(local.set $off (i32.const 0))
				(loop $next
					(local.set $s (i32.add (local.get $s) (i32.load $m (i32.add (local.get $page) (local.get $off)))))
					(br_if $next (i32.lt_u (local.tee $off (i32.add (local.get $off) (i32.const 4))) (i32.const 4096))))
				(br_if $pages (i32.lt_u (local.tee $page (i32.add (local.get $page) (i32.const 4096))) (local.get $n))))
			(br_if $pass (local.tee $passes (i32.sub (local.get $passes) (i32.const 1)))))
		(local.get $s)))
