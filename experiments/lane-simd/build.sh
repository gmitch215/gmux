#!/usr/bin/env bash
# the kernels for wasm SIMD (the lane and Node) and natively for this host
set -euo pipefail
cd "$(dirname "$0")/src"
clang=${CLANG:-/opt/homebrew/opt/llvm/bin/clang}
"$clang" --target=wasm32 -O3 -msimd128 -nostdlib -Wl,--no-entry -Wl,--export=init -Wl,--export=sgemm \
	-Wl,--export=dot8 -Wl,--export=conv3 -Wl,--initial-memory=41943040 -o kernels.wasm kernels.c
"$clang" -O3 -mcpu=native -o native kernels.c native.c
