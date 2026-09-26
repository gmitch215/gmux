#!/usr/bin/env bash
# stages build/kernel from a linux-wasm build: the kernel with only the exports the host calls plus its
# five task globals, busybox and katybug instrumented (scripts/wasm/instrument.sh), and the initramfs
set -euo pipefail
in=${1:?usage: scripts/build-kernel.sh <dir holding vmlinux.wasm busybox.wasm initramfs.cpio.gz>}
root=$(cd "$(dirname "$0")/.." && pwd)
out=$root/build/kernel
tmp=$(mktemp -d)
mkdir -p "$out"
keep=boot_command_line,init_task,initrd_start,initrd_end,get_user_stack_pointer,get_user_tls_base
keep+=,ret_from_fork,_start,_start_secondary,raise_exception,wasm_user_work_pending
keep+=,wasm_user_stack_low,wasm_user_stack_high,wasm_trap_unwound_kernel,wasm_user_interrupt
keep+=,wasm_owner_table,wasm_current_owner,wasm_current_euid,wasm_current_mm,wasm_console_irq
for n in 0 1 2 3 4 5 6; do keep+=",wasm_syscall_$n"; done
wasm2wat --enable-threads "$in/vmlinux.wasm" -o "$tmp/vmlinux.wat"
"$root/scripts/ts" "$root/scripts/wasm/strip-exports.ts" "$tmp/vmlinux.wat" "$tmp/vmlinux.min.wat" "$keep"
wat2wasm --enable-threads "$tmp/vmlinux.min.wat" -o "$tmp/vmlinux.min.wasm"
"$root/scripts/ts" "$root/scripts/wasm/export-globals.ts" "$tmp/vmlinux.min.wasm" "$out/vmlinux.wasm" \
	gmux_sp=0 gmux_tls=1 gmux_current=4 gmux_usp=5 gmux_utls=6
"$root/scripts/ts" "$root/scripts/wasm/memory-note.ts" "$out/vmlinux.wasm"
"$root/scripts/wasm/instrument.sh" "$in/busybox.wasm" "$out/busybox.wasm"
# the same BusyBox runnable by every process on one instance (MachineOptions.shareInstances)
"$root/scripts/ts" "$root/scripts/wasm/share.ts" "$in/busybox.wasm" "$out/busybox.wasm" "$out/busybox.share.wasm"
# and the build a non-root task runs, every store checked against the page owner table
wasm2wat --enable-threads --enable-exceptions --generate-names "$in/busybox.wasm" -o "$tmp/busybox.wat"
"$root/scripts/ts" "$root/scripts/wasm/guard-pass.ts" "$tmp/busybox.wat" "$tmp/busybox.guard.wat" --inline > /dev/null
wat2wasm --enable-threads --enable-exceptions --enable-multi-memory "$tmp/busybox.guard.wat" -o "$tmp/busybox.guard.wasm"
"$root/scripts/wasm/instrument.sh" "$tmp/busybox.guard.wasm" "$out/busybox.guard.wasm"
"$root/scripts/ts" "$root/scripts/wasm/exec-stubs.ts" "$in/initramfs.cpio.gz" "$out/initramfs.bin"
# the registry keys: the hashes of the unfueled busybox and katybug the stubs carry
sum=$(shasum -a 256 "$in/busybox.wasm" | cut -d' ' -f1)
if [ -f "$in/katybug.wasm" ]; then
	"$root/scripts/wasm/instrument.sh" "$in/katybug.wasm" "$out/katybug.wasm"
	kb=$(shasum -a 256 "$in/katybug.wasm" | cut -d' ' -f1)
	printf '{ "busybox": "%s", "katybug": "%s" }\n' "$sum" "$kb" > "$out/manifest.json"
else
	printf '{ "busybox": "%s" }\n' "$sum" > "$out/manifest.json"
fi
ls -la "$out"
