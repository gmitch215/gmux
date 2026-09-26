;; recursion to a given depth: a frame per level, so the deepest depth that returns measures the stack
(module
	(func $rec (export "rec") (param $n i32) (result i32)
		(if (result i32) (local.get $n)
			(then (i32.add (call $rec (i32.sub (local.get $n) (i32.const 1))) (i32.const 1)))
			(else (i32.const 0)))))
