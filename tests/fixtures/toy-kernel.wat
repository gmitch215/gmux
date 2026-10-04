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
	(import "env" "wasm_release_task" (func $release (param i32)))
	(import "env" "wasm_random_get_bytes" (func $random (param i32 i32) (result i32)))
	(import "env" "wasm_net_listen" (func $netListen (param i32 i32) (result i32)))
	(import "env" "wasm_net_next" (func $netNext (param i32 i32 i32) (result i32)))
	(import "env" "wasm_net_send" (func $netSend (param i32 i32 i32) (result i32)))
	(import "env" "wasm_net_end" (func $netEnd (param i32 i32)))

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
	(data (i32.const 0x740) "Y")
	;; what readlinkat answers for /proc/self/fd/3, and the bytes read from the file behind it
	(data (i32.const 0x750) "/toy/file")
	(data (i32.const 0x760) "hello")
	(data (i32.const 0x748) "Z")
	(data (i32.const 0x768) "T")
	;; /proc/self/maps: the toy file shared at 0xa0000
	(data (i32.const 0x880) "000a0000-000a1000 rw-s 00000000 00:01 7 /toy/file\n")
	;; getdents64 of /: ".", ".." and the regular file "file"
	(data (i32.const 0x900)
		"\01\00\00\00\00\00\00\00\01\00\00\00\00\00\00\00\18\00\04.\00\00\00\00"
		"\02\00\00\00\00\00\00\00\02\00\00\00\00\00\00\00\18\00\04..\00\00\00"
		"\03\00\00\00\00\00\00\00\03\00\00\00\00\00\00\00\18\00\08file\00")
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
					;; "y" runs program "Y", which fsyncs
					(if (i32.eq (i32.load8_u (i32.const 0x600)) (i32.const 121))
						(then (drop (call $create (i32.const 1) (i32.const 3) (i32.const 0x490) (i32.const 0x740) (i32.const 0x744) (i32.const 0x10000) (i32.const 0)))))
					;; "t" runs program "T", which statxes one path over and over
					(if (i32.eq (i32.load8_u (i32.const 0x600)) (i32.const 116))
						(then (drop (call $create (i32.const 1) (i32.const 3) (i32.const 0x490) (i32.const 0x768) (i32.const 0x76c) (i32.const 0x10000) (i32.const 0)))))
					;; "n" runs program "Z", which writes synchronously, msyncs and syncs
					(if (i32.eq (i32.load8_u (i32.const 0x600)) (i32.const 110))
						(then (drop (call $create (i32.const 1) (i32.const 3) (i32.const 0x490) (i32.const 0x748) (i32.const 0x74c) (i32.const 0x10000) (i32.const 0)))))
					(if (i32.eq (i32.load8_u (i32.const 0x600)) (i32.const 117))
						(then (drop (call $create (i32.const 1) (i32.const 3) (i32.const 0x490) (i32.const 0x700) (i32.const 0x704) (i32.const 0x10000) (i32.const 0)))))
					;; "l" listens on port 80, as a program's listen() does (kernel patch 0031)
					(if (i32.eq (i32.load8_u (i32.const 0x600)) (i32.const 108))
						(then (drop (call $netListen (i32.const 80) (i32.const 1)))))
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

	;; rt_sigaction (134) and rt_sigprocmask (135) record the signal set they were given at 0x804.
	;; A toy file for the host's fsync hook: readlinkat (78) names fd 3 /toy/file and refuses fd 4;
	;; openat (56) keeps its flags at 0x834, what it opened at 0x844 (1 /proc/self/maps, 2 /, 0 a file)
	;; and answers fd 5
	(func (export "wasm_syscall_4") (param $sp i32) (param $tp i32) (param $nr i32)
		(param $a i32) (param $b i32) (param $c i32) (param $d i32) (result i32)
		(if (i32.eq (local.get $nr) (i32.const 135)) (then (i32.store (i32.const 0x804) (i32.load (local.get $b)))))
		(if (i32.eq (local.get $nr) (i32.const 78))
			(then
				(if (i32.eq (i32.load8_u (i32.add (local.get $b) (i32.const 14))) (i32.const 0x34))
					(then (return (i32.const -9))))
				(memory.copy (local.get $c) (i32.const 0x750) (i32.const 9))
				(return (i32.const 9))))
		(if (i32.eq (local.get $nr) (i32.const 56))
			(then
				(i32.store (i32.const 0x834) (local.get $c))
				(i32.store (i32.const 0x844)
					(select
						(i32.const 2)
						(i32.and
							(i32.eq (i32.load8_u (i32.add (local.get $b) (i32.const 1))) (i32.const 0x70))
							(i32.eq (i32.load8_u (i32.add (local.get $b) (i32.const 11))) (i32.const 0x6d)))
						(i32.eqz (i32.load8_u (i32.add (local.get $b) (i32.const 1))))))
				(return (i32.const 5))))
		(i32.const 0))

	;; fsync (82) and fdatasync (83) count at 0x830; close (57) lets the next open read again
	(func (export "wasm_syscall_1") (param $sp i32) (param $tp i32) (param $nr i32) (param $a i32) (result i32)
		(if (i32.or (i32.eq (local.get $nr) (i32.const 82)) (i32.eq (local.get $nr) (i32.const 83)))
			(then (i32.store (i32.const 0x830) (i32.add (i32.load (i32.const 0x830)) (i32.const 1)))))
		(if (i32.eq (local.get $nr) (i32.const 57)) (then (i32.store (i32.const 0x83c) (i32.const 0))))
		(i32.const 0))

	;; mmap (222) hands out 0xa0000 and counts at 0x84c; every mapping starts where it is asked about
	;; and runs for the length at 0x850 (1 MiB, until the test shrinks it)
	(data (i32.const 0x850) "\00\00\10\00")
	(func (export "wasm_syscall_6") (param $sp i32) (param $tp i32) (param $nr i32)
		(param $a i32) (param $b i32) (param $c i32) (param $d i32) (param $e i32) (param $f i32) (result i32)
		(if (i32.eq (local.get $nr) (i32.const 222))
			(then
				(i32.store (i32.const 0x84c) (i32.add (i32.load (i32.const 0x84c)) (i32.const 1)))
				(return (i32.const 0xa0000))))
		(i32.const -38))
	(func (export "wasm_current_mm") (result i32) (i32.const 1))
	;; program "T"'s stack runs from 0x5000 to 0xa000; anything else is its own mapping's start
	(func (export "wasm_user_stack_low") (param $at i32) (result i32)
		(select (i32.const 0x5000) (local.get $at)
			(i32.and (i32.ge_u (local.get $at) (i32.const 0x9000)) (i32.lt_u (local.get $at) (i32.const 0xa000)))))
	;; kernel patch 0022: the path-query generation at 0x858 and the view at 0x85c
	(func (export "wasm_fs_gen") (result i32) (i32.load (i32.const 0x858)))
	(func (export "wasm_fs_view") (result i32) (i32.load (i32.const 0x85c)))
	;; kernel patch 0029: the mount and chroot count (index -1) at 0x870, else counter i & 0xff at
	;; 0x1400 + 4 * i
	(func (export "wasm_fs_gen_at") (param $i i32) (result i32)
		(if (i32.eq (local.get $i) (i32.const -1)) (then (return (i32.load (i32.const 0x870)))))
		(i32.load (i32.add (i32.const 0x1400) (i32.shl (i32.and (local.get $i) (i32.const 0xff)) (i32.const 2)))))
	(data (i32.const 0x85c) "\01")
	(data (i32.const 0x864) "\05")
	(func (export "wasm_user_stack_high") (param $at i32) (result i32)
		(i32.add (local.get $at) (i32.load (i32.const 0x850))))

	;; tkill (130): the signal at its default action ends task 3, which never runs again
	(func (export "wasm_syscall_2") (param $sp i32) (param $tp i32) (param $nr i32)
		(param $a i32) (param $b i32) (result i32)
		;; fcntl (25) F_GETFL: fd 5 is O_WRONLY | O_SYNC, any other O_WRONLY
		(if (i32.eq (local.get $nr) (i32.const 25))
			(then (return (select (i32.const 0x101001) (i32.const 1) (i32.eq (local.get $a) (i32.const 5))))))
		(if (i32.ne (local.get $nr) (i32.const 130)) (then (return (i32.const -38))))
		(i32.store (i32.const 0x800) (local.get $b))
		(call $say (i32.const 0x4f0) (i32.const 13))
		(loop $forever (drop (call $switch (i32.const 3) (i32.const 1))) (br $forever))
		(i32.const 0))

	;; clone (220): task 3 makes task 4 and waits for it, as CLONE_VFORK does; returns the child's pid
	(func (export "wasm_syscall_5") (param $sp i32) (param $tp i32) (param $nr i32)
		(param $a i32) (param $b i32) (param $c i32) (param $d i32) (param $e i32) (result i32)
		(local $len i32)
		;; statx (291): the toy file is a regular file of mode 0644 and 5 bytes, inode 12, under the
		;; directories "/toy" (11) and "/" (10), by the length of the path; counts at 0x860, its size
		;; at 0x864, with STATX_INO, STATX_TYPE and STATX_MNT_ID and mount 0 in its mask
		(if (i32.eq (local.get $nr) (i32.const 291))
			(then
				(i32.store (i32.const 0x860) (i32.add (i32.load (i32.const 0x860)) (i32.const 1)))
				(loop $length
					(if (i32.load8_u (i32.add (local.get $b) (local.get $len)))
						(then
							(local.set $len (i32.add (local.get $len) (i32.const 1)))
							(br $length))))
				(i32.store (local.get $e) (i32.const 0x17ff))
				(i64.store (i32.add (local.get $e) (i32.const 32))
					(select (i64.const 10)
						(select (i64.const 11) (i64.const 12) (i32.eq (local.get $len) (i32.const 4)))
						(i32.eq (local.get $len) (i32.const 1))))
				(i32.store16 (i32.add (local.get $e) (i32.const 28))
					(select (i32.const 0x41ed) (i32.const 0x81a4)
						(i32.or (i32.eq (local.get $len) (i32.const 1)) (i32.eq (local.get $len) (i32.const 4)))))
				(i64.store (i32.add (local.get $e) (i32.const 40)) (i64.extend_i32_u (i32.load (i32.const 0x864))))
				(i64.store (i32.add (local.get $e) (i32.const 144)) (i64.const 0))
				(return (i32.const 0))))
		(if (i32.ne (local.get $nr) (i32.const 220)) (then (return (i32.const -38))))
		(drop (call $create (i32.const 3) (i32.const 4) (i32.const 0x480) (i32.const 0) (i32.const 0) (i32.const 0) (i32.const 0)))
		(i32.const 4))

	;; execve (221): loads program "U", wakes the waiting parent, then returns to user mode as exec does
	(func (export "wasm_syscall_3") (param $sp i32) (param $tp i32) (param $nr i32)
		(param $a i32) (param $b i32) (param $c i32) (result i32)
		;; mkdirat (34) counts at 0x838 and finds the directory there; read (63) gives "hello" once
		;; (0x83c remembers); write (64) appends to 0x2800, its length at 0x840
		(if (i32.eq (local.get $nr) (i32.const 34))
			(then
				(i32.store (i32.const 0x838) (i32.add (i32.load (i32.const 0x838)) (i32.const 1)))
				(return (i32.const -17))))
		(if (i32.eq (local.get $nr) (i32.const 63))
			(then
				(if (i32.load (i32.const 0x83c)) (then (return (i32.const 0))))
				(i32.store (i32.const 0x83c) (i32.const 1))
				(if (i32.eq (i32.load (i32.const 0x844)) (i32.const 1))
					(then
						(memory.copy (local.get $b) (i32.const 0x880) (i32.const 50))
						(return (i32.const 50))))
				(memory.copy (local.get $b) (i32.const 0x760) (i32.const 5))
				(return (i32.const 5))))
		;; getdents64 (61) lists / once per open; msync (227) succeeds
		(if (i32.eq (local.get $nr) (i32.const 61))
			(then
				(if (i32.load (i32.const 0x83c)) (then (return (i32.const 0))))
				(i32.store (i32.const 0x83c) (i32.const 1))
				(memory.copy (local.get $b) (i32.const 0x900) (i32.const 72))
				(return (i32.const 72))))
		(if (i32.eq (local.get $nr) (i32.const 227)) (then (return (i32.const 0))))
		;; unlinkat (35) counts at 0x848
		(if (i32.eq (local.get $nr) (i32.const 35))
			(then
				(i32.store (i32.const 0x848) (i32.add (i32.load (i32.const 0x848)) (i32.const 1)))
				(return (i32.const 0))))
		(if (i32.eq (local.get $nr) (i32.const 64))
			(then
				(memory.copy
					(i32.add (i32.const 0x2800) (i32.load (i32.const 0x840)))
					(local.get $b)
					(local.get $c))
				(i32.store (i32.const 0x840) (i32.add (i32.load (i32.const 0x840)) (local.get $c)))
				(return (local.get $c))))
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
	;; the page allocator's free pages (kernel patch 0020) at 0x1100: 150 frames, frame 120 free, and a
	;; bit for frame 200, past the count, that the host must ignore
	(data (i32.const 0x1100) "\96\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\00\01\00\00\00\00\00\00\00\00\00\01\00\00")
	(func (export "wasm_free_pages") (result i32) (i32.const 0x1100))
	;; told of a restore (kernel patch 0023): 32 fresh host bytes where the crng's key would be
	(func (export "wasm_restored") (drop (call $random (i32.const 0x1200) (i32.const 32))))
	;; cpu 1 sleeps on its interrupt word and reports the console's interrupt (2) when the host raises it
	(func (export "_start_secondary") (param $idle i32)
		(local $bits i64)
		(loop $wait
			(call $idle (i32.const 0x308) (i64.const -1))
			(local.set $bits (i64.atomic.rmw.xchg (i32.const 0x308) (i64.const 0)))
			(if (i64.ne (i64.and (local.get $bits) (i64.const 4)) (i64.const 0))
				(then (call $say (i32.const 0x550) (i32.const 12))))
			;; the stream relay's interrupt (3): echo what the host sends and end when it does
			(if (i64.ne (i64.and (local.get $bits) (i64.const 8)) (i64.const 0))
				(then (call $netEcho)))
			(br $wait)))
	;; the event at 0x1300 (op, id, argument) and its bytes at 0x1310
	(func $netEcho
		(loop $next
			(if (call $netNext (i32.const 0x1300) (i32.const 0x1310) (i32.const 64))
				(then
					(if (i32.eq (i32.load (i32.const 0x1300)) (i32.const 2))
						(then (drop (call $netSend (i32.load (i32.const 0x1304)) (i32.const 0x1310) (i32.load (i32.const 0x1308))))))
					(if (i32.eq (i32.load (i32.const 0x1300)) (i32.const 3))
						(then (call $netEnd (i32.load (i32.const 0x1304)) (i32.const 0))))
					(br $next)))))
	(func (export "wasm_net_irq") (result i32) (i32.const 3))
	;; the test has the kernel release the task named at 0x854 when input next arrives
	(func (export "wasm_console_irq") (result i32)
		(if (i32.load (i32.const 0x854))
			(then
				(call $release (i32.load (i32.const 0x854)))
				(i32.store (i32.const 0x854) (i32.const 0))))
		(i32.const 2))
	(func (export "get_user_stack_pointer") (result i32) (i32.const 0x3000))
	(func (export "get_user_tls_base") (result i32) (i32.const 0)))
