;; a stack parked through JSPI for the whole job: run() calls wait(), which suspends until the host resolves it
(module
	(import "host" "wait" (func $wait (result i32)))
	(func (export "run") (result i32) (i32.add (call $wait) (i32.const 1))))
