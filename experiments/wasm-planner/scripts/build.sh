#!/usr/bin/env bash
# builds the planner's guests at one optimisation level: zlib, bzip2 and zstd as wasm32 modules with no
# imports and no bulk memory, from source trees a promotion-ladder or promotion-cut build.sh fetched.
# usage: build.sh <opt level, e.g. 0 1 2> <source dir holding zlib/ bzip2/ zstd/> <out dir>
# needs emscripten's clang (em-config LLVM_ROOT) or CLANG, and its sysroot
set -euo pipefail
[ $# -eq 3 ] || { echo "usage: build.sh <opt level> <source dir> <out dir>" >&2; exit 2; }
opt=$1
src=$(cd "$2" && pwd)
mkdir -p "$3"
out=$(cd "$3" && pwd)
here=$(cd "$(dirname "$0")" && pwd)
root=$(cd "$here/../../.." && pwd)
clang=${CLANG:-$(em-config LLVM_ROOT)/clang}
sysroot=${SYSROOT_INCLUDE:-$(em-config CACHE)/sysroot/include}
cut=$root/experiments/promotion-cut/src

flags="--target=wasm32 -O$opt -nostdlib -fno-builtin -mno-bulk-memory -mno-bulk-memory-opt -mno-nontrapping-fptoint -mno-reference-types -mno-multivalue -w"
link="-Wl,--no-entry -Wl,-z,stack-size=65536"

z=$src/zlib
"$clang" $flags -DZ_SOLO -I"$z" $link -Wl,--initial-memory=8388608 \
	"$z/deflate.c" "$z/trees.c" "$z/adler32.c" "$z/crc32.c" "$z/zutil.c" "$root/experiments/promotion-ladder/src/guest.c" \
	-o "$out/zlib.wasm"

b=$src/bzip2
"$clang" $flags -DBZ_NO_STDIO -I"$b" -I"$cut" -isystem "$sysroot" $link -Wl,--initial-memory=33554432 \
	"$b/blocksort.c" "$b/huffman.c" "$b/crctable.c" "$b/randtable.c" "$b/compress.c" "$b/decompress.c" "$b/bzlib.c" \
	"$cut/bzip2.c" -o "$out/bzip2.wasm"

zs=$src/zstd/lib
"$clang" $flags -DZSTD_DISABLE_ASM -DZSTD_LEGACY_SUPPORT=0 -DDEBUGLEVEL=0 \
	-I"$zs" -I"$zs/common" -I"$cut" -isystem "$sysroot" $link -Wl,--initial-memory=33554432 \
	"$zs"/common/*.c "$zs"/compress/*.c "$zs"/decompress/*.c "$cut/zstd.c" -o "$out/zstd.wasm"

for g in zlib bzip2 zstd; do echo "built $out/$g.wasm at -O$opt ($(wc -c < "$out/$g.wasm") bytes)"; done
