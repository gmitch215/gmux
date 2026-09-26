#!/usr/bin/env bash
# prepares a user program for the host: fuel checks at every loop head, so one that never makes a
# syscall still yields the host thread; a check on every stack pointer write, so an overflow is a
# fault instead of a write into the mapping below; only the exports the host calls, since each
# instance builds an exports object (BusyBox links 2,051); and a note of the table size it needs. The kernel finds a program by the hash of
# the file it reads, which stays unmodified; the host runs this output in its place
set -euo pipefail
in=${1:?usage: scripts/wasm/instrument.sh <program.wasm> <instrumented.wasm>}
out=${2:?}
here=$(cd "$(dirname "$0")" && pwd)
tmp=$(mktemp -d)
wasm2wat --enable-threads --enable-exceptions --enable-multi-memory --generate-names "$in" -o "$tmp/in.wat"
python3 "$here/fuel-pass.py" "$tmp/in.wat" "$tmp/fuel.wat" > /dev/null
# GMUX_NO_STACK_CHECK=1 exists to measure the check's cost, not to ship without it
if [ "${GMUX_NO_STACK_CHECK:-}" = 1 ]; then cp "$tmp/fuel.wat" "$tmp/stack.wat"; else
	python3 "$here/stack-pass.py" "$tmp/fuel.wat" "$tmp/stack.wat" > /dev/null
fi
keep=_start,__libc_clone_callback,__libc_handle_signal,__set_tls_base,__get_tls_base,__c_longjmp
keep+=,__wasm_apply_data_relocs,__wasm_apply_tls_relocs,__wasm_apply_global_relocs,__wasm_call_ctors,__gmux_set_stack_limits
# a program that calls dlopen keeps its exports (side modules link against them), and a side
# module (no _start) is nothing but its exports
if grep -q '(import "env" "__gmux_dlopen"' "$tmp/stack.wat" || ! grep -q '(export "_start"' "$tmp/stack.wat"; then
	cp "$tmp/stack.wat" "$tmp/out.wat"
else
	python3 "$here/strip-exports.py" "$tmp/stack.wat" "$tmp/out.wat" "$keep" > /dev/null
fi
# GMUX_NAMES=1 keeps the function names, for a profile
wat2wasm --enable-threads --enable-exceptions --enable-multi-memory ${GMUX_NAMES:+--debug-names} \
	"$tmp/out.wat" -o "$out"
python3 "$here/table-note.py" "$tmp/out.wat" "$out" > /dev/null
