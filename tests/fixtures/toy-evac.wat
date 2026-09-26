;; a user program for toy-kernel.wat ("i" on its console) whose state lives in wasm locals across a
;; kernel park: it counts to 40 through fuel yields, parks inside a helper (syscall 9, until "r"),
;; then prints through syscalls whose numbers come from that state: 2 "handled", 5 "vfork child",
;; and 4 "user back". Lost locals print neither of the first two. The park is a function whose body
;; is one call with no block around it (musl's __restore_sigs), which must still resume; the helper
;; then throws, and the catch prints 5 from a local only the catch reads (a setjmp landing's saved
;; stack pointer)
(module
	(import "env" "memory" (memory 2 64 shared))
	(import "env" "__wasm_syscall_0" (func $syscall (param i32 i32 i32) (result i32)))
	(import "env" "__gmux_fuel" (func $fuel))
	(tag $thrown)

	(func $park (param $unused i32)
		(local.set $unused (call $syscall (i32.const 0) (i32.const 0) (i32.const 9))))

	(func $helper (param $x i32)
		(call $park (i32.const 0))
		(drop (call $syscall (i32.const 0) (i32.const 0) (i32.sub (local.get $x) (i32.const 38))))
		(throw $thrown))

	(func (export "_start") (local $i i32) (local $caught i32)
		(loop $count
			(call $fuel)
			(local.set $i (i32.add (local.get $i) (i32.const 1)))
			(br_if $count (i32.lt_u (local.get $i) (i32.const 40))))
		(local.set $caught (i32.sub (local.get $i) (i32.const 35)))
		(try
			(do (call $helper (local.get $i)))
			(catch $thrown (drop (call $syscall (i32.const 0) (i32.const 0) (local.get $caught)))))
		(drop (call $syscall (i32.const 0) (i32.const 0) (i32.const 4)))))
