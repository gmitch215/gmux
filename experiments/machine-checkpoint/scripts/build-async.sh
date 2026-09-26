#!/usr/bin/env bash
# shared-kernel vmlinux and fuel busybox, asyncified at their park imports for checkpoints
set -euo pipefail
cd "$(dirname "$0")/../../boot/vendor"
opt=../../../node_modules/.bin/wasm-opt
features=(--enable-threads --enable-bulk-memory --enable-mutable-globals --enable-sign-ext --enable-exception-handling)
kernel=env.wasm_serialize_tasks,env.wasm_create_and_run_task,env.wasm_idle_wait,env.wasm_cpu_relax,env.wasm_halt,env.wasm_user_mode_tail
user=env.__gmux_fuel
for n in 0 1 2 3 4 5 6; do user+=",env.__wasm_syscall_$n"; done
python3 ../../../scripts/wasm/export-globals.py busybox.fuel.wasm busybox.globals.wasm --all-mutable
"$opt" vmlinux.shared.wasm "${features[@]}" --asyncify --pass-arg=asyncify-imports@$kernel -O1 -o vmlinux.async.wasm &
"$opt" busybox.globals.wasm "${features[@]}" --asyncify --pass-arg=asyncify-imports@$user -O1 -o busybox.async.wasm
wait
ls -la vmlinux.shared.wasm vmlinux.async.wasm busybox.fuel.wasm busybox.async.wasm
