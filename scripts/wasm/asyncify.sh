#!/usr/bin/env bash
# the checkpointable builds of a staged kernel directory: vmlinux and busybox asyncified at the
# imports a task parks in (MachineOptions.asyncify). busybox comes from the share build, which already
# exports every mutable global (a checkpoint saves them), imports a mutable memory base and carries the
# gmux.share note, so the host can hand a finished process's instance to the next exec.
# Machine.checkpoint refuses while a program without these runs
set -euo pipefail
dir=${1:?usage: scripts/wasm/asyncify.sh <dir holding vmlinux.wasm busybox.share.wasm>}
root=$(cd "$(dirname "$0")/../.." && pwd)
opt=$root/node_modules/.bin/wasm-opt
features=(--enable-threads --enable-bulk-memory --enable-mutable-globals --enable-sign-ext
	--enable-exception-handling --enable-multimemory --enable-nontrapping-float-to-int)
kernel=env.wasm_serialize_tasks,env.wasm_create_and_run_task,env.wasm_idle_wait,env.wasm_cpu_relax
kernel+=,env.wasm_halt,env.wasm_user_mode_tail
user=env.__gmux_fuel
for n in 0 1 2 3 4 5 6; do user+=",env.__wasm_syscall_$n"; done
"$opt" "$dir/vmlinux.wasm" "${features[@]}" --asyncify --pass-arg=asyncify-imports@$kernel -O1 \
	-o "$dir/vmlinux.async.wasm" &
"$opt" "$dir/busybox.share.wasm" "${features[@]}" --asyncify --pass-arg=asyncify-imports@$user -O1 \
	-o "$dir/busybox.async.wasm"
wait
"$root/scripts/ts" "$root/scripts/wasm/check-async.ts" "$dir/busybox.share.wasm" "$dir/busybox.async.wasm"
# a server the site starts at boot runs for the machine's life, so it parks in a checkpoint too: the
# instrumented build with every mutable global exported, asyncified like BusyBox (no share notes)
if [ -f "$dir/lighttpd.wasm" ]; then
	globals=$(mktemp -d)
	"$root/scripts/ts" "$root/scripts/wasm/export-globals.ts" "$dir/lighttpd.wasm" "$globals/lighttpd.wasm" --all-mutable
	"$opt" "$globals/lighttpd.wasm" "${features[@]}" --asyncify --pass-arg=asyncify-imports@$user -O1 \
		-o "$dir/lighttpd.async.wasm"
	"$root/scripts/ts" "$root/scripts/wasm/check-async.ts" --plain "$globals/lighttpd.wasm" "$dir/lighttpd.async.wasm"
fi
