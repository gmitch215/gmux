#!/usr/bin/env bash
# the checkpointable builds of a staged kernel directory: vmlinux and busybox asyncified at the
# imports a task parks in (MachineOptions.asyncify), busybox with every mutable global exported so a
# checkpoint saves them. Machine.checkpoint refuses while a program without these runs
set -euo pipefail
dir=${1:?usage: scripts/wasm/asyncify.sh <dir holding vmlinux.wasm busybox.wasm>}
root=$(cd "$(dirname "$0")/../.." && pwd)
opt=$root/node_modules/.bin/wasm-opt
tmp=$(mktemp -d)
features=(--enable-threads --enable-bulk-memory --enable-mutable-globals --enable-sign-ext
	--enable-exception-handling --enable-multimemory --enable-nontrapping-float-to-int)
kernel=env.wasm_serialize_tasks,env.wasm_create_and_run_task,env.wasm_idle_wait,env.wasm_cpu_relax
kernel+=,env.wasm_halt,env.wasm_user_mode_tail
user=env.__gmux_fuel
for n in 0 1 2 3 4 5 6; do user+=",env.__wasm_syscall_$n"; done
"$root/scripts/ts" "$root/scripts/wasm/export-globals.ts" "$dir/busybox.wasm" "$tmp/busybox.globals.wasm" --all-mutable
"$opt" "$dir/vmlinux.wasm" "${features[@]}" --asyncify --pass-arg=asyncify-imports@$kernel -O1 \
	-o "$dir/vmlinux.async.wasm" &
"$opt" "$tmp/busybox.globals.wasm" "${features[@]}" --asyncify --pass-arg=asyncify-imports@$user -O1 \
	-o "$dir/busybox.async.wasm"
wait
