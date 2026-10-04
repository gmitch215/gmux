#!/usr/bin/env bash
# builds the syscall router (src/gmux/core/router) into a directory, default build/router: router.wasm
# from router.c by clang and lld, statx.wasm from statx.wat by binaryen. CLANG names a clang with the
# wasm32 target (Homebrew's llvm on a Mac)
set -euo pipefail
root=$(cd "$(dirname "$0")/.." && pwd)
out=${1:-$root/build/router}
src=$root/src/gmux/core/router
clang=${CLANG:-clang}
if [ -z "${CLANG:-}" ] && [ -x /opt/homebrew/opt/llvm/bin/clang ]; then
	clang=/opt/homebrew/opt/llvm/bin/clang
fi
mkdir -p "$out"
"$clang" --target=wasm32 -O2 -ffreestanding -mtail-call -matomics -mbulk-memory -c \
	"$src/router.c" -o "$out/router.o"
# the router imports the task's memory and keeps none of its own; the link takes no -O, which
# would have clang run a wasm-opt found on PATH over it
"$clang" --target=wasm32 -nostdlib -fuse-ld=lld -Wl,--no-entry,--allow-undefined \
	-Wl,--import-memory,--shared-memory,--initial-memory=65536,--max-memory=4294967296 \
	"$out/router.o" -o "$out/router.wasm"
"$root/scripts/ts" "$root/scripts/wasm/assemble-wat.ts" "$src/statx.wat" "$out/statx.wasm"
