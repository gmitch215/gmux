;; the statx cache's hit path (router.ts, StatxTable); wat because it reads two memories at once
;; table header at 0: hits, misses, verify. A hash picks a set of two slots, set s at (2s + 1) * 512.
;; A slot: hash, view, flags, mask, gen, ret, path length (0 when empty), has answer bytes; the 256
;; answer bytes at 32; the guard at 288: a count n, then n kernel counter indices (u16 at 292) and the
;; values they held (u32 at 308); the path at 340. With n = 0 the answer holds while `gen` is the
;; kernel's generation; else while `gen` is the count of mount and chroot changes (counter -1) and
;; every listed counter is what it was
(module
	(import "env" "user" (memory $user 1 65536 shared))
	(import "env" "table" (memory $table 1))
	(import "kernel" "view" (func $view (result i32)))
	(import "kernel" "gen" (func $gen (result i32)))
	(import "kernel" "at" (func $at (param i32) (result i32)))

	;; the cache key of the absolute path at $at, low half, and its length, high half; -1 for a
	;; relative or unterminated one (FNV-1a with view, flags and mask folded in; statxHash in
	;; machine.ts is the same function)
	(func $key (export "key") (param $at i32) (param $view i32) (param $flags i32) (param $mask i32) (result i64)
		(local $h i32)
		(local $i i64)
		(local $end i64)
		(local $size i64)
		(local $b i32)
		(local.set $size (i64.shl (i64.extend_i32_u (memory.size $user)) (i64.const 16)))
		(local.set $i (i64.extend_i32_u (local.get $at)))
		(if (i64.ge_u (local.get $i) (local.get $size)) (then (return (i64.const -1))))
		(if (i32.ne (i32.load8_u $user (local.get $at)) (i32.const 0x2f)) (then (return (i64.const -1))))
		(local.set $end (i64.add (local.get $i) (i64.const 4096)))
		(if (i64.gt_u (local.get $end) (local.get $size)) (then (local.set $end (local.get $size))))
		(local.set $h
			(i32.xor
				(i32.xor (i32.xor (i32.const 0x811c9dc5) (local.get $view))
					(i32.mul (local.get $flags) (i32.const 0x9e3779b1)))
				(i32.mul (local.get $mask) (i32.const 0x85ebca6b))))
		(loop $next
			(if (i64.ge_u (local.get $i) (local.get $end)) (then (return (i64.const -1))))
			(local.set $b (i32.load8_u $user (i32.wrap_i64 (local.get $i))))
			(if (i32.eqz (local.get $b))
				(then
					(return
						(i64.or (i64.extend_i32_u (local.get $h))
							(i64.shl (i64.sub (local.get $i) (i64.extend_i32_u (local.get $at))) (i64.const 32))))))
			(local.set $h (i32.mul (i32.xor (local.get $h) (local.get $b)) (i32.const 16777619)))
			(local.set $i (i64.add (local.get $i) (i64.const 1)))
			(br $next))
		(unreachable))

	;; whether the slot holds exactly this key and path
	(func $same
		(param $slot i32) (param $h i32) (param $view i32) (param $flags i32) (param $mask i32)
		(param $len i32) (param $path i32) (result i32)
		(local $i i32)
		(if (i32.ne (i32.load $table (local.get $slot)) (local.get $h)) (then (return (i32.const 0))))
		(if (i32.ne (i32.load $table offset=4 (local.get $slot)) (local.get $view)) (then (return (i32.const 0))))
		(if (i32.ne (i32.load $table offset=8 (local.get $slot)) (local.get $flags)) (then (return (i32.const 0))))
		(if (i32.ne (i32.load $table offset=12 (local.get $slot)) (local.get $mask)) (then (return (i32.const 0))))
		(if (i32.ne (i32.load $table offset=24 (local.get $slot)) (local.get $len)) (then (return (i32.const 0))))
		(loop $bytes
			(if (i32.lt_u (local.get $i) (local.get $len))
				(then
					(if
						(i32.ne (i32.load8_u $user (i32.add (local.get $path) (local.get $i)))
							(i32.load8_u $table offset=340 (i32.add (local.get $slot) (local.get $i))))
						(then (return (i32.const 0))))
					(local.set $i (i32.add (local.get $i) (i32.const 1)))
					(br $bytes))))
		(i32.const 1))

	;; wasm_syscall_5's arguments for a statx; the cached answer, or 1 for the hook to ask the kernel
	(func $hit (export "hit")
		(param $sp i32) (param $tls i32) (param $nr i32) (param $dirfd i32) (param $path i32)
		(param $flags i32) (param $mask i32) (param $buf i32) (result i32)
		(local $view i32)
		(local $key i64)
		(local $h i32)
		(local $len i32)
		(local $slot i32)
		(local $n i32)
		(local $i i32)
		(block $miss
			(br_if $miss (i32.load $table offset=8 (i32.const 0)))
			(local.set $view (call $view))
			(br_if $miss (i32.eqz (local.get $view)))
			(local.set $key (call $key (local.get $path) (local.get $view) (local.get $flags) (local.get $mask)))
			(br_if $miss (i64.lt_s (local.get $key) (i64.const 0)))
			(local.set $h (i32.wrap_i64 (local.get $key)))
			(local.set $len (i32.wrap_i64 (i64.shr_u (local.get $key) (i64.const 32))))
			(local.set $slot
				(i32.shl
					(i32.add (i32.shl (i32.and (local.get $h) (i32.const 2047)) (i32.const 1)) (i32.const 1))
					(i32.const 9)))
			(if
				(i32.eqz
					(call $same (local.get $slot) (local.get $h) (local.get $view) (local.get $flags) (local.get $mask)
						(local.get $len) (local.get $path)))
				(then
					(local.set $slot (i32.add (local.get $slot) (i32.const 512)))
					(br_if $miss
						(i32.eqz
							(call $same (local.get $slot) (local.get $h) (local.get $view) (local.get $flags)
								(local.get $mask) (local.get $len) (local.get $path))))))
			(local.set $n (i32.load $table offset=288 (local.get $slot)))
			(if (local.get $n)
				(then
					(br_if $miss (i32.ne (i32.load $table offset=16 (local.get $slot)) (call $at (i32.const -1))))
					(loop $guard
						(br_if $miss
							(i32.ne
								(i32.load $table offset=308 (i32.add (local.get $slot) (i32.shl (local.get $i) (i32.const 2))))
								(call $at
									(i32.load16_u $table offset=292
										(i32.add (local.get $slot) (i32.shl (local.get $i) (i32.const 1)))))))
						(local.set $i (i32.add (local.get $i) (i32.const 1)))
						(br_if $guard (i32.lt_u (local.get $i) (local.get $n)))))
				(else
					(br_if $miss (i32.ne (i32.load $table offset=16 (local.get $slot)) (call $gen)))))
			(if (i32.load $table offset=28 (local.get $slot))
				(then
					;; a buffer outside the memory is the kernel's to refuse with EFAULT
					(br_if $miss
						(i64.gt_u (i64.add (i64.extend_i32_u (local.get $buf)) (i64.const 256))
							(i64.shl (i64.extend_i32_u (memory.size $user)) (i64.const 16))))
					(memory.copy $user $table (local.get $buf) (i32.add (local.get $slot) (i32.const 32)) (i32.const 256))))
			(i32.store $table (i32.const 0) (i32.add (i32.load $table (i32.const 0)) (i32.const 1)))
			(return (i32.load $table offset=20 (local.get $slot))))
		(i32.store $table offset=4 (i32.const 0) (i32.add (i32.load $table offset=4 (i32.const 0)) (i32.const 1)))
		(i32.const 1))
)
