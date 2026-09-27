#!/usr/bin/env bash
# builds the topology arms' portable inputs: the guest module (no imports, no bulk memory, no builtin
# idioms, which Katybug's wasm frontend does not run) and Katybug for Node through emscripten.
# The native wasm3 and Katybug are built on the measuring host (wasm3-native.sh, clang).
# usage: build.sh <out dir>; needs emscripten (emcc, em-config)
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
root=$(cd "$here/../../.." && pwd)
mkdir -p "$1"
out=$(cd "$1" && pwd)
"$(em-config LLVM_ROOT)/clang" --target=wasm32 -O2 -nostdlib -fno-builtin -mno-bulk-memory -mno-bulk-memory-opt \
	-Wl,--no-entry -Wl,-z,stack-size=65536 -Wl,--initial-memory=4194304 \
	-o "$out/guests.wasm" "$here/../src/guests.c"
emcc -O2 -D_DEFAULT_SOURCE -s NODERAWFS=1 -s ALLOW_MEMORY_GROWTH=1 -s MAXIMUM_MEMORY=4GB -s EXIT_RUNTIME=1 \
	-o "$out/katybug-hosted.js" "$root"/src/gmux/katybug/*.c "$here/../src/hosted-stubs.c"
echo "built $out/guests.wasm and $out/katybug-hosted.js"
