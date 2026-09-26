;; a user program for toy-kernel.wat ("o" on its console) with a frame that lands outside every stack segment
(module
	(import "env" "memory" (memory 2 64 shared))
	(import "env" "__gmux_stack_move" (func $move (param i32) (result i32)))
	(func (export "_start") (drop (call $move (i32.const 16)))))
