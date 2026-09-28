;; an interpreter's dispatch three ways over one byte program: handlers that tail-call the next
;; handler (threaded), a loop that calls each handler through the table, and a loop over br_table;
;; an op at pc does the same work in each, so the three return the same value
(module
	(memory (export "memory") 1)
	(type $step (func (param i32 i64 i32) (result i64)))
	(type $op (func (param i32 i64) (result i64)))
	(table $threaded 4 funcref)
	(elem (table $threaded) (i32.const 0) func $ta $tb $tc $td)
	(table $ops 4 funcref)
	(elem (table $ops) (i32.const 0) func $oa $ob $oc $od)

	(func (export "init") (local $i i32)
		(loop $l
			(i32.store8 (local.get $i)
				(i32.and (i32.shr_u (i32.mul (local.get $i) (i32.const 2654435761)) (i32.const 13)) (i32.const 3)))
			(local.set $i (i32.add (local.get $i) (i32.const 1)))
			(br_if $l (i32.lt_u (local.get $i) (i32.const 65536)))))

	;; threaded: a handler gets its own pc and the ops left, including its own
	(func $ta (type $step) (param $pc i32) (param $acc i64) (param $n i32) (result i64)
		(local.set $acc (i64.add (local.get $acc) (i64.const 1)))
		(local.set $n (i32.sub (local.get $n) (i32.const 1)))
		(if (i32.eqz (local.get $n)) (then (return (local.get $acc))))
		(local.set $pc (i32.add (local.get $pc) (i32.const 1)))
		(return_call_indirect $threaded (type $step) (local.get $pc) (local.get $acc) (local.get $n)
			(i32.load8_u (i32.and (local.get $pc) (i32.const 65535)))))
	(func $tb (type $step) (param $pc i32) (param $acc i64) (param $n i32) (result i64)
		(local.set $acc (i64.xor (local.get $acc) (i64.extend_i32_u (local.get $pc))))
		(local.set $n (i32.sub (local.get $n) (i32.const 1)))
		(if (i32.eqz (local.get $n)) (then (return (local.get $acc))))
		(local.set $pc (i32.add (local.get $pc) (i32.const 1)))
		(return_call_indirect $threaded (type $step) (local.get $pc) (local.get $acc) (local.get $n)
			(i32.load8_u (i32.and (local.get $pc) (i32.const 65535)))))
	(func $tc (type $step) (param $pc i32) (param $acc i64) (param $n i32) (result i64)
		(local.set $acc (i64.mul (local.get $acc) (i64.const 3)))
		(local.set $n (i32.sub (local.get $n) (i32.const 1)))
		(if (i32.eqz (local.get $n)) (then (return (local.get $acc))))
		(local.set $pc (i32.add (local.get $pc) (i32.const 1)))
		(return_call_indirect $threaded (type $step) (local.get $pc) (local.get $acc) (local.get $n)
			(i32.load8_u (i32.and (local.get $pc) (i32.const 65535)))))
	(func $td (type $step) (param $pc i32) (param $acc i64) (param $n i32) (result i64)
		(local.set $acc (i64.add (i64.rotl (local.get $acc) (i64.const 5)) (i64.extend_i32_u (local.get $pc))))
		(local.set $n (i32.sub (local.get $n) (i32.const 1)))
		(if (i32.eqz (local.get $n)) (then (return (local.get $acc))))
		(local.set $pc (i32.add (local.get $pc) (i32.const 1)))
		(return_call_indirect $threaded (type $step) (local.get $pc) (local.get $acc) (local.get $n)
			(i32.load8_u (i32.and (local.get $pc) (i32.const 65535)))))
	(func (export "tail") (param $n i32) (result i64)
		(if (i32.eqz (local.get $n)) (then (return (i64.const 0))))
		(return_call_indirect $threaded (type $step) (i32.const 0) (i64.const 0) (local.get $n)
			(i32.load8_u (i32.const 0))))

	;; the same work as plain functions, called once per op
	(func $oa (type $op) (param $pc i32) (param $acc i64) (result i64) (i64.add (local.get $acc) (i64.const 1)))
	(func $ob (type $op) (param $pc i32) (param $acc i64) (result i64)
		(i64.xor (local.get $acc) (i64.extend_i32_u (local.get $pc))))
	(func $oc (type $op) (param $pc i32) (param $acc i64) (result i64) (i64.mul (local.get $acc) (i64.const 3)))
	(func $od (type $op) (param $pc i32) (param $acc i64) (result i64)
		(i64.add (i64.rotl (local.get $acc) (i64.const 5)) (i64.extend_i32_u (local.get $pc))))
	(func (export "calls") (param $n i32) (result i64) (local $pc i32) (local $acc i64)
		(block $done
			(loop $l
				(br_if $done (i32.eqz (local.get $n)))
				(local.set $acc (call_indirect $ops (type $op) (local.get $pc) (local.get $acc)
					(i32.load8_u (i32.and (local.get $pc) (i32.const 65535)))))
				(local.set $pc (i32.add (local.get $pc) (i32.const 1)))
				(local.set $n (i32.sub (local.get $n) (i32.const 1)))
				(br $l)))
		(local.get $acc))

	;; and inline, one br_table per op
	(func (export "switch") (param $n i32) (result i64) (local $pc i32) (local $acc i64)
		(block $done
			(loop $l
				(br_if $done (i32.eqz (local.get $n)))
				(block $next (block $d (block $c (block $b (block $a
					(br_table $a $b $c $d (i32.load8_u (i32.and (local.get $pc) (i32.const 65535)))))
					(local.set $acc (i64.add (local.get $acc) (i64.const 1))) (br $next))
					(local.set $acc (i64.xor (local.get $acc) (i64.extend_i32_u (local.get $pc)))) (br $next))
					(local.set $acc (i64.mul (local.get $acc) (i64.const 3))) (br $next))
					(local.set $acc (i64.add (i64.rotl (local.get $acc) (i64.const 5)) (i64.extend_i32_u (local.get $pc)))))
				(local.set $pc (i32.add (local.get $pc) (i32.const 1)))
				(local.set $n (i32.sub (local.get $n) (i32.const 1)))
				(br $l)))
		(local.get $acc)))
