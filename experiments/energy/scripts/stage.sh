#!/usr/bin/env bash
# the census programs as the host runs them: <name>.node.wasm (fuel and stack checks, the node
# arm) and <name>.async.wasm (the same, globals exported and asyncified at the syscall and fuel
# imports, the workerd arm); the unmodified <name>.wasm is the image file the kernel reads
# usage: stage.sh <census dir> <out dir> [names]
set -euo pipefail
census=${1:?usage: stage.sh <census dir> <out dir> [names]}
out=${2:?}
names=${3:-lua gzip bzip2 sqlite sed gawk}
root=$(cd "$(dirname "$0")/../../.." && pwd)
opt=$root/node_modules/.bin/wasm-opt
features=(--enable-threads --enable-bulk-memory --enable-mutable-globals --enable-sign-ext
	--enable-exception-handling --enable-multimemory --enable-nontrapping-float-to-int)
user=env.__gmux_fuel
for n in 0 1 2 3 4 5 6; do user+=",env.__wasm_syscall_$n"; done
mkdir -p "$out"
for name in $names; do
	cp "$census/$name.wasm" "$out/$name.wasm"
	"$root/scripts/wasm/instrument.sh" "$census/$name.wasm" "$out/$name.node.wasm"
	"$root/scripts/ts" "$root/scripts/wasm/export-globals.ts" "$out/$name.node.wasm" "$out/$name.globals.wasm" --all-mutable
	"$opt" "$out/$name.globals.wasm" "${features[@]}" --asyncify --pass-arg=asyncify-imports@$user -O1 -o "$out/$name.async.wasm"
	ls -l "$out/$name.node.wasm" "$out/$name.async.wasm"
done
