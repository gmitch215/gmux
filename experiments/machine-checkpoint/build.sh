#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/src/wasm"
opt=../../../../node_modules/.bin/wasm-opt
wat2wasm kernel.wat -o kernel.wasm
wat2wasm process.wat -o process.wasm
"$opt" kernel.wasm --asyncify --pass-arg=asyncify-imports@host.block -O1 -o kernel.async.wasm
"$opt" process.wasm --asyncify --pass-arg=asyncify-imports@kernel.syscall -O1 -o process.async.wasm
cp ../../../boot/vendor/vmlinux.wasm vmlinux.wasm
