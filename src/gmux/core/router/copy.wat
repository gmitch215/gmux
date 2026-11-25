;; the three copies between the kernel's memory and a task's own (domain.ts, Domain.copier); wat
;; because it needs two memories. Both are imported shared with the widest limits any machine fits
(module
	(import "env" "kernel" (memory $kernel 0 65536 shared))
	(import "env" "user" (memory $user 0 65536 shared))

	(func (export "in") (param $k i32) (param $u i32) (param $n i32)
		(memory.copy $kernel $user (local.get $k) (local.get $u) (local.get $n)))

	(func (export "out") (param $k i32) (param $u i32) (param $n i32)
		(memory.copy $user $kernel (local.get $u) (local.get $k) (local.get $n)))

	(func (export "zero") (param $u i32) (param $n i32)
		(memory.fill $user (local.get $u) (i32.const 0) (local.get $n)))
)
