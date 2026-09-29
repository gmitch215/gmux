;; the native side of a thunk: the stack pointer set on entry, then the work (one add)
(module
	(global $sp (mut i32) (i32.const 0))
	(func (export "f_nop") (param $sp i32) (param $a i32) (result i32)
		(global.set $sp (local.get $sp))
		(i32.add (local.get $a) (i32.const 1)))
)
