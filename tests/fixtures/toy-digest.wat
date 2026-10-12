;; a user program for toy-kernel.wat ("y" on its console, registered as "Y"): hashes "abc" with the
;; host's sha256 through __gmux_digest, parks inside the open digest (syscall 9, until "r"), then
;; finishes it and parks for good. The results are left in memory for the test to read: the id at
;; 0x14200, the length of the finished digest at 0x14204, the digest at 0x14100, what a bogus id
;; answers at 0x14208 and what an address past the memory answers at 0x1420c
(module
	(import "env" "memory" (memory 2 64 shared))
	(import "env" "__wasm_syscall_0" (func $syscall (param i32 i32 i32) (result i32)))
	(import "env" "__gmux_digest" (func $digest (param i32 i32 i32 i32) (result i32)))

	(func (export "_start") (local $id i32)
		(i32.store8 (i32.const 0x14000) (i32.const 97))
		(i32.store8 (i32.const 0x14001) (i32.const 98))
		(i32.store8 (i32.const 0x14002) (i32.const 99))
		(local.set $id (call $digest (i32.const 0) (i32.const 3) (i32.const 0) (i32.const 0)))
		(i32.store (i32.const 0x14200) (local.get $id))
		(drop (call $digest (i32.const 1) (local.get $id) (i32.const 0x14000) (i32.const 3)))
		(i32.store (i32.const 0x14208) (call $digest (i32.const 1) (i32.const 77) (i32.const 0x14000) (i32.const 3)))
		(i32.store (i32.const 0x1420c) (call $digest (i32.const 1) (local.get $id) (i32.const 0x7ffffff0) (i32.const 64)))
		(drop (call $syscall (i32.const 0) (i32.const 0) (i32.const 9)))
		(i32.store (i32.const 0x14204) (call $digest (i32.const 2) (local.get $id) (i32.const 0x14100) (i32.const 0)))
		(drop (call $syscall (i32.const 0) (i32.const 0) (i32.const 4)))))
