;; a user program for toy-kernel.wat ("i" on its console) that spins, yielding only on fuel
(module
	(import "env" "memory" (memory 2 64 shared))
	(import "env" "__gmux_fuel" (func $fuel))
	(func (export "_start") (loop $spin (call $fuel) (br $spin))))
