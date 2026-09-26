(module
	(import "env" "memory" (memory 2 64 shared))
	(import "env" "wasm_create_and_run_task" (func $create (param i32 i32 i32 i32 i32 i32 i32) (result i32)))
	(import "env" "wasm_serialize_tasks" (func $switch (param i32 i32) (result i32)))
	(import "env" "wasm_idle_wait" (func $idle (param i32 i64)))
	(import "env" "wasm_halt" (func $halt))
	(import "env" "wasm_driver_hvc_put" (func $put (param i32 i32) (result i32)))
	(import "env" "wasm_driver_hvc_get" (func $get (param i32 i32) (result i32)))
	(import "env" "wasm_user_mode_tail" (func $tail (param i32)))
	(import "env" "wasm_load_executable" (func $load (param i32 i32 i32 i32) (result i32)))
	(import "env" "wasm_cpu_clock_get_monotonic" (func $clock (param i64) (result i64)))
	(import "env" "wasm_start_cpu" (func $startCpu (param i32 i32)))

	(global $init_task (export "init_task") i32 (i32.const 1))
	(global $boot_command_line (export "boot_command_line") i32 (i32.const 0x100))
	(global $initrd_start (export "initrd_start") i32 (i32.const 0x200))
	(global $initrd_end (export "initrd_end") i32 (i32.const 0x204))
	(global $sp (export "gmux_sp") (mut i32) (i32.const 0))
	(global $tls (export "gmux_tls") (mut i32) (i32.const 0))
	(global $current (export "gmux_current") (mut i32) (i32.const 0))
	(global $usp (export "gmux_usp") (mut i32) (i32.const 0))
	(global $utls (export "gmux_utls") (mut i32) (i32.const 0))

	(data (i32.const 0x400) "boot\n")
	(data (i32.const 0x410) "parent ok\n")
	(data (i32.const 0x420) "parent bad\n")
	(data (i32.const 0x430) "child\n")
	(data (i32.const 0x440) "child ok\n")
	(data (i32.const 0x450) "child bad\n")
	(data (i32.const 0x460) "echo:")
	(data (i32.const 0x470) "parent back ok\n")
	(data (i32.const 0x480) "child\00")
	(data (i32.const 0x490) "user\00")
	(data (i32.const 0x4a0) "handled\n")
	(data (i32.const 0x4b0) "user back\n")
	(data (i32.const 0x4c0) "vfork child\n")
	(data (i32.const 0x4d0) "vfork parent\n")
	(data (i32.const 0x4e0) "vfork bad\n")
	;; the first byte of an executable is its hash (tests/unit/machine.test.ts)
	(data (i32.const 0x700) "U")
	(data (i32.const 0x708) "V")
	(data (i32.const 0x710) "F")
	(data (i32.const 0x718) "I")
	(data (i32.const 0x720) "O")
	(data (i32.const 0x728) "M")
	(data (i32.const 0x730) "S")
	(data (i32.const 0x738) "X")
	(data (i32.const 0x560) "exec refused\n")
	(data (i32.const 0x570) "exec taken\n")
	(data (i32.const 0x530) "shared ok\n")
	(data (i32.const 0x540) "shared bad\n")
	(data (i32.const 0x4f0) "fatal signal\n")
	(data (i32.const 0x500) "clock moves\n")
	(data (i32.const 0x510) "clock stuck\n")
	(data (i32.const 0x520) "user interrupt\n")
	(data (i32.const 0x550) "console irq\n")

	(func $say (param $at i32) (param $len i32) (drop (call $put (local.get $at) (local.get $len))))

	(func $check (param $id i32) (param $ok i32) (param $okLen i32) (param $bad i32) (param $badLen i32)
		(if (i32.eq (global.get $current) (local.get $id))
			(then (call $say (local.get $ok) (local.get $okLen)))
			(else (call $say (local.get $bad) (local.get $badLen)))))

	(func (export "_start")
		(local $n i32)
		(global.set $current (i32.const 1))
		(call $say (i32.const 0x400) (i32.const 5))
		(drop (call $create (i32.const 1) (i32.const 2) (i32.const 0x480) (i32.const 0) (i32.const 0) (i32.const 0) (i32.const 0)))
		(call $check (i32.const 1) (i32.const 0x410) (i32.const 10) (i32.const 0x420) (i32.const 11))
		(loop $idle
			(call $idle (i32.const 0x300) (i64.const 1000000))
			(local.set $n (call $get (i32.const 0x600) (i32.const 64)))
			(if (i32.gt_s (local.get $n) (i32.const 0))
				(then
					(call $say (i32.const 0x460) (i32.const 5))
					(call $say (i32.const 0x600) (local.get $n))
					(if (i32.eq (i32.load8_u (i32.const 0x600)) (i32.const 113)) (then (call $halt)))
					;; "k" starts cpu 1, the interrupt cpu
					(if (i32.eq (i32.load8_u (i32.const 0x600)) (i32.const 107))
						(then (call $startCpu (i32.const 1) (i32.const 9))))
					(if (i32.eq (i32.load8_u (i32.const 0x600)) (i32.const 114))
						(then (drop (call $switch (i32.const 1) (i32.const 3)))))
					;; "x" asks the host to load program "X", as exec does (kernel patch 0018)
					(if (i32.eq (i32.load8_u (i32.const 0x600)) (i32.const 120))
						(then
							(if (call $load (i32.const 0x738) (i32.const 0x73c) (i32.const 0x10000) (i32.const 0))
								(then (call $say (i32.const 0x560) (i32.const 13)))
								(else (call $say (i32.const 0x570) (i32.const 11))))))
					(if (i32.eq (i32.load8_u (i32.const 0x600)) (i32.const 118))
						(then (drop (call $create (i32.const 1) (i32.const 3) (i32.const 0x490) (i32.const 0x708) (i32.const 0x70c) (i32.const 0x10000) (i32.const 0)))))
					;; with the host clock standing still: charging 250 ns moves the clock, charging nothing does not
					(if (i32.eq (i32.load8_u (i32.const 0x600)) (i32.const 99))
						(then
							(if (i32.and
									(i64.eq (i64.sub (call $clock (i64.const 250)) (call $clock (i64.const 0))) (i64.const 0))
									(i64.eq (i64.sub (call $clock (i64.const 250)) (call $clock (i64.const 250))) (i64.const -250)))
								(then (call $say (i32.const 0x500) (i32.const 12)))
								(else (call $say (i32.const 0x510) (i32.const 12))))))
					(if (i32.eq (i32.load8_u (i32.const 0x600)) (i32.const 109))
						(then (drop (call $create (i32.const 1) (i32.const 3) (i32.const 0x490) (i32.const 0x728) (i32.const 0x72c) (i32.const 0x10000) (i32.const 0)))))
					(if (i32.eq (i32.load8_u (i32.const 0x600)) (i32.const 111))
						(then (drop (call $create (i32.const 1) (i32.const 3) (i32.const 0x490) (i32.const 0x720) (i32.const 0x724) (i32.const 0x10000) (i32.const 0)))))
					(if (i32.eq (i32.load8_u (i32.const 0x600)) (i32.const 105))
						(then (drop (call $create (i32.const 1) (i32.const 3) (i32.const 0x490) (i32.const 0x718) (i32.const 0x71c) (i32.const 0x10000) (i32.const 0)))))
					(if (i32.eq (i32.load8_u (i32.const 0x600)) (i32.const 102))
						(then (drop (call $create (i32.const 1) (i32.const 3) (i32.const 0x490) (i32.const 0x710) (i32.const 0x714) (i32.const 0x10000) (i32.const 0)))))
					;; two processes of program "S" at their own data starts, each yielding to task 1 once
					(if (i32.eq (i32.load8_u (i32.const 0x600)) (i32.const 119))
						(then
							(drop (call $create (i32.const 1) (i32.const 3) (i32.const 0x490) (i32.const 0x730) (i32.const 0x734) (i32.const 0x10000) (i32.const 0)))
							(drop (call $create (i32.const 1) (i32.const 5) (i32.const 0x490) (i32.const 0x730) (i32.const 0x734) (i32.const 0x20000) (i32.const 0)))
							(drop (call $switch (i32.const 1) (i32.const 3)))
							(drop (call $switch (i32.const 1) (i32.const 5)))))
					(if (i32.eq (i32.load8_u (i32.const 0x600)) (i32.const 117))
						(then (drop (call $create (i32.const 1) (i32.const 3) (i32.const 0x490) (i32.const 0x700) (i32.const 0x704) (i32.const 0x10000) (i32.const 0)))))
					(if (i32.eq (i32.load8_u (i32.const 0x600)) (i32.const 115))
						(then
							(drop (call $switch (i32.const 1) (i32.const 2)))
							(call $check (i32.const 1) (i32.const 0x470) (i32.const 15) (i32.const 0x420) (i32.const 11))))))
			(br $idle)))

	(func (export "ret_from_fork") (param $prev i32) (param $next i32) (result i32)
		(global.set $current (local.get $next))
		;; tasks 3 and 5 return to user mode and run their programs
		(if (i32.or (i32.eq (local.get $next) (i32.const 3)) (i32.eq (local.get $next) (i32.const 5)))
			(then (return (i32.const 0))))
		;; task 4 is the child of task 3's clone
		(if (i32.eq (local.get $next) (i32.const 4)) (then (return (i32.const 1))))
		(call $say (i32.const 0x430) (i32.const 6))
		(loop $again
			(drop (call $switch (local.get $next) (local.get $prev)))
			(call $check (i32.const 2) (i32.const 0x440) (i32.const 9) (i32.const 0x450) (i32.const 10))
			(br $again))
		(i32.const 0))

	;; 1 raises a signal on the way out, 2 prints, 3 is sigreturn, 4 prints and parks for good
	(func (export "wasm_syscall_0") (param $sp i32) (param $tp i32) (param $nr i32) (result i32)
		(if (i32.eq (local.get $nr) (i32.const 1)) (then (call $tail (i32.const 1))))
		(if (i32.eq (local.get $nr) (i32.const 2)) (then (call $say (i32.const 0x4a0) (i32.const 8))))
		(if (i32.eq (local.get $nr) (i32.const 3)) (then (call $tail (i32.const 2))))
		(if (i32.eq (local.get $nr) (i32.const 4))
			(then
				(call $say (i32.const 0x4b0) (i32.const 10))
				(loop $forever (drop (call $switch (i32.const 3) (i32.const 1))) (br $forever))))
		;; park task 3 until "r" on the console switches back to it
		(if (i32.eq (local.get $nr) (i32.const 9)) (then (drop (call $switch (i32.const 3) (i32.const 1)))))
		(if (i32.eq (local.get $nr) (i32.const 5)) (then (call $say (i32.const 0x4c0) (i32.const 12))))
		(if (i32.eq (local.get $nr) (i32.const 6)) (then (call $say (i32.const 0x4d0) (i32.const 13))))
		(if (i32.eq (local.get $nr) (i32.const 7)) (then (call $say (i32.const 0x4e0) (i32.const 10))))
		;; the vfork parent is done: let the child's exec finish
		(if (i32.eq (local.get $nr) (i32.const 8))
			(then (loop $forever (drop (call $switch (i32.const 3) (i32.const 4))) (br $forever))))
		;; 10 yields to task 1; 11 and 12 report; 13 parks for good
		(if (i32.eq (local.get $nr) (i32.const 10)) (then (drop (call $switch (global.get $current) (i32.const 1)))))
		(if (i32.eq (local.get $nr) (i32.const 11)) (then (call $say (i32.const 0x530) (i32.const 10))))
		(if (i32.eq (local.get $nr) (i32.const 12)) (then (call $say (i32.const 0x540) (i32.const 11))))
		(if (i32.eq (local.get $nr) (i32.const 13))
			(then (loop $forever (drop (call $switch (global.get $current) (i32.const 1))) (br $forever))))
		;; gettid
		(if (i32.eq (local.get $nr) (i32.const 178)) (then (return (i32.const 3))))
		;; getpid, as the host's pass through the kernel for pending work: the work is done
		(if (i32.eq (local.get $nr) (i32.const 172))
			(then
				(i32.store (i32.const 0x80c) (i32.const 0))
				(call $say (i32.const 0x520) (i32.const 15))))
		(i32.const 0))

	;; rt_sigaction (134) and rt_sigprocmask (135) record the signal set they were given at 0x804
	(func (export "wasm_syscall_4") (param $sp i32) (param $tp i32) (param $nr i32)
		(param $a i32) (param $b i32) (param $c i32) (param $d i32) (result i32)
		(if (i32.eq (local.get $nr) (i32.const 135)) (then (i32.store (i32.const 0x804) (i32.load (local.get $b)))))
		(i32.const 0))

	;; tkill (130): the signal at its default action ends task 3, which never runs again
	(func (export "wasm_syscall_2") (param $sp i32) (param $tp i32) (param $nr i32)
		(param $a i32) (param $b i32) (result i32)
		(if (i32.ne (local.get $nr) (i32.const 130)) (then (return (i32.const -38))))
		(i32.store (i32.const 0x800) (local.get $b))
		(call $say (i32.const 0x4f0) (i32.const 13))
		(loop $forever (drop (call $switch (i32.const 3) (i32.const 1))) (br $forever))
		(i32.const 0))

	;; clone (220): task 3 makes task 4 and waits for it, as CLONE_VFORK does; returns the child's pid
	(func (export "wasm_syscall_5") (param $sp i32) (param $tp i32) (param $nr i32)
		(param $a i32) (param $b i32) (param $c i32) (param $d i32) (param $e i32) (result i32)
		(if (i32.ne (local.get $nr) (i32.const 220)) (then (return (i32.const -38))))
		(drop (call $create (i32.const 3) (i32.const 4) (i32.const 0x480) (i32.const 0) (i32.const 0) (i32.const 0) (i32.const 0)))
		(i32.const 4))

	;; execve (221): loads program "U", wakes the waiting parent, then returns to user mode as exec does
	(func (export "wasm_syscall_3") (param $sp i32) (param $tp i32) (param $nr i32)
		(param $a i32) (param $b i32) (param $c i32) (result i32)
		(if (i32.ne (local.get $nr) (i32.const 221)) (then (return (i32.const -38))))
		(drop (call $load (i32.const 0x700) (i32.const 0x704) (i32.const 0x10000) (i32.const 0)))
		(drop (call $switch (i32.const 4) (i32.const 3)))
		(call $tail (i32.const -1))
		(i32.const 0))

	;; the test raises pending work by writing 0x80c
	(func (export "wasm_user_work_pending") (result i32) (i32.load (i32.const 0x80c)))
	;; the test makes the interrupt run park its cpu by writing 0x814, as a handler that reaches the
	;; scheduler does
	(func (export "wasm_user_interrupt") (result i32)
		(if (i32.load (i32.const 0x814))
			(then
				(i32.store (i32.const 0x814) (i32.const 0))
				(call $idle (i32.const 0x818) (i64.const 0))))
		(i32.load (i32.const 0x80c)))
	;; the test sets the calling task's euid by writing 0x81c
	(func (export "wasm_current_euid") (result i32) (i32.load (i32.const 0x81c)))
	;; the test says whether the trap unwound a syscall by writing 0x810
	(func (export "wasm_trap_unwound_kernel") (result i32) (i32.load (i32.const 0x810)))
	;; a page owner table (kernel patch 0014) at 0x1000: page 16, where "i" puts task 3's data, is tag 7
	(data (i32.const 0x1020) "\07\00")
	(func (export "wasm_owner_table") (result i32) (i32.const 0x1000))
	;; cpu 1 sleeps on its interrupt word and reports the console's interrupt (2) when the host raises it
	(func (export "_start_secondary") (param $idle i32)
		(loop $wait
			(call $idle (i32.const 0x308) (i64.const -1))
			(if (i64.ne (i64.and (i64.atomic.rmw.xchg (i32.const 0x308) (i64.const 0)) (i64.const 4)) (i64.const 0))
				(then (call $say (i32.const 0x550) (i32.const 12))))
			(br $wait)))
	(func (export "wasm_console_irq") (result i32) (i32.const 2))
	(func (export "get_user_stack_pointer") (result i32) (i32.const 0x3000))
	(func (export "get_user_tls_base") (result i32) (i32.const 0)))
