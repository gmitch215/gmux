#!/usr/bin/env bash
# builds wasm3 natively the way burrow builds src/vendor/wasm3.wasm (same pin, patches, fusion
# catalog and defines), with a driver that calls one export and prints its result, so the native and
# hosted arms run the same interpreter. needs git, node and a C compiler.
# usage: wasm3-native.sh <burrow repo> <out dir>
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
burrow=$(cd "$1" && pwd)
mkdir -p "$2"
out=$(cd "$2" && pwd)
ref=$(sed -n 's/^WASM3_REF="\${WASM3_REF:-\([0-9a-f]*\)}"$/\1/p' "$burrow/tools/build-interp.sh")
src=$out/wasm3
if [ ! -d "$src/.git" ]; then
	git init -q "$src"
	git -C "$src" remote add origin https://github.com/wasm3/wasm3.git
fi
git -C "$src" fetch -q --depth 1 origin "$ref"
git -C "$src" -c advice.detachedHead=false checkout -q --force FETCH_HEAD
S=$src/source
patch -s -p1 -d "$S" < "$burrow/tools/interp/wasm3-fold-loop-back-edge.patch"
patch -s -p1 -d "$S" < "$burrow/tools/interp/wasm3-fuse-hook.patch"
node "$burrow/tools/interp/gen-fuse.mjs" "$burrow/tools/interp/fuse-catalog.json" "$S/m3_exec.h" "$S/m3_fuse.h"
printf '\n#if d_m3Fuse\n#include "m3_fuse.h"\n#endif\n' >> "$S/m3_compile.c"
${CC:-cc} -O3 -DNDEBUG -I"$S" -Dd_m3HasWASI=0 -Dd_m3HasTracer=0 -Dd_m3HasUVWASI=0 -Dd_m3Fuse=1 \
	"$S"/m3_bind.c "$S"/m3_code.c "$S"/m3_compile.c "$S"/m3_core.c "$S"/m3_env.c "$S"/m3_exec.c \
	"$S"/m3_function.c "$S"/m3_info.c "$S"/m3_module.c "$S"/m3_parse.c "$S"/m3_api_libc.c \
	"$S"/m3_validate.c "$here/../src/wasm3-driver.c" -lm -o "$out/wasm3-native"
echo "built $out/wasm3-native (wasm3 $ref)"
