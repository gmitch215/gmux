#!/usr/bin/env bash
# builds the planner's census guests, bzip2 and zstd (pinned in src/sources.json, checked), as wasm32
# modules with no imports and no bulk memory; zlib comes from experiments/promotion-ladder/scripts/build.sh.
# usage: build.sh <out dir>; needs curl and emscripten's clang (em-config LLVM_ROOT) or CLANG, and its sysroot
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
mkdir -p "$1"
out=$(cd "$1" && pwd)
clang=${CLANG:-$(em-config LLVM_ROOT)/clang}
sysroot=${SYSROOT_INCLUDE:-$(em-config CACHE)/sysroot/include}
pin() { node -e 'const s=require(process.argv[1]);console.log(s[process.argv[2]][process.argv[3]])' "$here/../src/sources.json" "$1" "$2"; }

fetch() {
	[ -d "$out/$1" ] && return 0
	curl -fsSL -o "$out/$1.tar.gz" "$(pin "$1" url)"
	echo "$(pin "$1" sha256)  $out/$1.tar.gz" | shasum -a 256 -c - > /dev/null
	mkdir -p "$out/$1"
	tar -C "$out/$1" --strip-components=1 -xzf "$out/$1.tar.gz"
}

flags="--target=wasm32 -O2 -nostdlib -fno-builtin -mno-bulk-memory -mno-bulk-memory-opt -mno-nontrapping-fptoint -mno-reference-types -mno-multivalue -w"
link="-Wl,--no-entry -Wl,-z,stack-size=65536 -Wl,--initial-memory=33554432"

fetch bzip2
b=$out/bzip2
"$clang" $flags -DBZ_NO_STDIO -I"$b" -I"$here/../src" -isystem "$sysroot" $link \
	"$b/blocksort.c" "$b/huffman.c" "$b/crctable.c" "$b/randtable.c" "$b/compress.c" "$b/decompress.c" "$b/bzlib.c" \
	"$here/../src/bzip2.c" -o "$out/bzip2.wasm"

fetch zstd
z=$out/zstd/lib
"$clang" $flags -DZSTD_DISABLE_ASM -DZSTD_LEGACY_SUPPORT=0 -DDEBUGLEVEL=0 \
	-I"$z" -I"$z/common" -I"$here/../src" -isystem "$sysroot" $link \
	"$z"/common/*.c "$z"/compress/*.c "$z"/decompress/*.c "$here/../src/zstd.c" -o "$out/zstd.wasm"

for g in bzip2 zstd; do echo "built $out/$g.wasm ($(wc -c < "$out/$g.wasm") bytes)"; done
