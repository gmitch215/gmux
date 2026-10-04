#!/usr/bin/env bash
# builds src/gmux/core/*.c into one freestanding wasm32 module, <out directory>/gmux-core.wasm, with the
# machine's memory imported and its own data placed at the base the host chooses (position independent).
# LLVM=<bin directory> picks the clang and wasm-ld (default: the PATH's, or Homebrew's on macOS)
# usage: scripts/build-core.sh <out directory>
set -euo pipefail
out=${1:?usage: scripts/build-core.sh <out directory>}
root=$(cd "$(dirname "$0")/.." && pwd)
llvm=${LLVM:-}
if [ -z "$llvm" ] && [ -x /opt/homebrew/opt/llvm/bin/clang ]; then llvm=/opt/homebrew/opt/llvm/bin; fi
clang=${llvm:+$llvm/}clang
mkdir -p "$out"
sources=("$root"/src/gmux/core/*.c)
# the memory is shared with the kernel (4 GiB is wasm32's most), so the module declares it shared
"$clang" --target=wasm32 -O2 -g0 -ffreestanding -fno-builtin -nostdlib -fPIC -matomics -mbulk-memory \
	-Wall -Wextra -Werror -I"$root/src/gmux/core" "${sources[@]}" -o "$out/gmux-core.wasm" \
	-Wl,--no-entry,-shared,--import-memory,--shared-memory,--initial-memory=65536,--max-memory=4294967296
echo "$out/gmux-core.wasm"
