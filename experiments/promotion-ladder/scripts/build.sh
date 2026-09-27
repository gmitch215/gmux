#!/usr/bin/env bash
# builds the ladder's guest: zlib from src/sources.json's pin, checked, and src/guest.c, for wasm32 with
# no imports and no bulk memory (wasm3 and the native side's rebasing both stay simple).
# usage: build.sh <out dir>; needs curl and emscripten's clang (em-config LLVM_ROOT) or CLANG
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
root=$(cd "$here/../../.." && pwd)
mkdir -p "$1"
out=$(cd "$1" && pwd)
pin() { "$root/scripts/ts" "$root/scripts/pin.ts" zlib "$1"; }
clang=${CLANG:-$(em-config LLVM_ROOT)/clang}
if [ ! -d "$out/zlib" ]; then
	curl -fsSL -o "$out/zlib.tar.gz" "$(pin url)"
	echo "$(pin sha256)  $out/zlib.tar.gz" | shasum -a 256 -c - > /dev/null
	mkdir -p "$out/zlib"
	tar -C "$out/zlib" --strip-components=1 -xzf "$out/zlib.tar.gz"
fi
z=$out/zlib
"$clang" --target=wasm32 -O2 -nostdlib -fno-builtin -mno-bulk-memory -DZ_SOLO -I"$z" \
	-Wl,--no-entry -Wl,-z,stack-size=65536 -Wl,--initial-memory=8388608 \
	"$z/deflate.c" "$z/trees.c" "$z/adler32.c" "$z/crc32.c" "$z/zutil.c" "$here/../src/guest.c" \
	-o "$out/guest.wasm"
echo "built $out/guest.wasm ($(wc -c < "$out/guest.wasm") bytes)"
