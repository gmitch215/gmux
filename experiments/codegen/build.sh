#!/usr/bin/env bash
# inputs: burrow's wasm3, drupflare's php8.5 build, event-quanta's burn loop, and a gzip of vmlinux and busybox
set -euo pipefail
cd "$(dirname "$0")/src"
root=../../..
cp "$root/node_modules/@drupflare/burrow/dist/vendor/wasm3.wasm" wasm3.bin
cp "$root/../drupflare/worker/.interp/php8.5.wasm" php.bin
wat2wasm ../../event-quanta/src/wasm/work.wat -o work.wasm
cp work.wasm work.bin
cat ../../boot/vendor/vmlinux.min.wasm ../../boot/vendor/busybox.wasm | gzip -9 > pack.bin
