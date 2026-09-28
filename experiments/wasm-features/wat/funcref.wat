;; dispatch through typed function references (call_ref from a typed table) against call_indirect
;; through a funcref table, one call per op
(module
	(memory (export "memory") 1)
	(type $op (func (param i64) (result i64)))
	(table $typed 4 (ref null $op))
	(table $plain 4 funcref)
	(elem (table $plain) (i32.const 0) func $a $b $c $d)
	(elem declare func $a $b $c $d)
	(func $a (type $op) (param $x i64) (result i64) (i64.add (local.get $x) (i64.const 1)))
	(func $b (type $op) (param $x i64) (result i64) (i64.xor (local.get $x) (i64.const 0x5bd1e995)))
	(func $c (type $op) (param $x i64) (result i64) (i64.mul (local.get $x) (i64.const 3)))
	(func $d (type $op) (param $x i64) (result i64) (i64.rotl (local.get $x) (i64.const 5)))
	(func (export "init") (local $i i32)
		(table.set $typed (i32.const 0) (ref.func $a))
		(table.set $typed (i32.const 1) (ref.func $b))
		(table.set $typed (i32.const 2) (ref.func $c))
		(table.set $typed (i32.const 3) (ref.func $d))
		(loop $l
			(i32.store8 (local.get $i)
				(i32.and (i32.shr_u (i32.mul (local.get $i) (i32.const 2654435761)) (i32.const 13)) (i32.const 3)))
			(local.set $i (i32.add (local.get $i) (i32.const 1)))
			(br_if $l (i32.lt_u (local.get $i) (i32.const 65536)))))
	(func (export "ref") (param $n i32) (result i64) (local $pc i32) (local $acc i64)
		(block $done
			(loop $l
				(br_if $done (i32.eqz (local.get $n)))
				(local.set $acc (call_ref $op (local.get $acc)
					(table.get $typed (i32.load8_u (i32.and (local.get $pc) (i32.const 65535))))))
				(local.set $pc (i32.add (local.get $pc) (i32.const 1)))
				(local.set $n (i32.sub (local.get $n) (i32.const 1)))
				(br $l)))
		(local.get $acc))
	(func (export "indirect") (param $n i32) (result i64) (local $pc i32) (local $acc i64)
		(block $done
			(loop $l
				(br_if $done (i32.eqz (local.get $n)))
				(local.set $acc (call_indirect $plain (type $op) (local.get $acc)
					(i32.load8_u (i32.and (local.get $pc) (i32.const 65535)))))
				(local.set $pc (i32.add (local.get $pc) (i32.const 1)))
				(local.set $n (i32.sub (local.get $n) (i32.const 1)))
				(br $l)))
		(local.get $acc)))
