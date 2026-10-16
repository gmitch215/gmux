#!/usr/bin/env bash
# builds the two guests natively as controls for the wasm arms: zlib's deflate (experiments/promotion-ladder/src/guest.c)
# and zstd (experiments/promotion-cut/src/zstd.c), each at -O2 and at -O3 -march=native
# usage: build.sh <out dir>   env: ZLIB_SRC and ZSTD_SRC (the pinned source trees, required), CC (default cc)
#
# Both guests define their own byte-loop memcpy, memset, memcmp, memmove and strlen (a freestanding wasm module has no libc).
# Here those definitions are renamed to guest_* by -D on the guest's own translation unit, so the guest's callers and the
# library sources link libc's. The libraries are built without -fno-builtin. The zstd guest keeps its arena malloc, which
# run() resets each iteration, and the harness avoids stdio so nothing else allocates. zstd is built with ZSTD_DISABLE_ASM
# like the wasm module.
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
exp=$here/../..
: "${ZLIB_SRC:?set ZLIB_SRC to the pinned zlib tree}" "${ZSTD_SRC:?set ZSTD_SRC to the pinned zstd tree}"
mkdir -p "$1"
out=$(cd "$1" && pwd)
cc=${CC:-cc}
rename='-Dmemcpy=guest_memcpy -Dmemmove=guest_memmove -Dmemset=guest_memset -Dmemcmp=guest_memcmp -Dstrlen=guest_strlen'

build() {
	local arm=$1 opt=$2
	local z=$out/obj-zlib-$arm
	mkdir -p "$z" "$out/obj-zstd-$arm"
	for f in deflate trees adler32 crc32 zutil; do
		$cc $opt -DZ_SOLO -I"$ZLIB_SRC" -c "$ZLIB_SRC/$f.c" -o "$z/$f.o"
	done
	$cc $opt -DZ_SOLO -I"$ZLIB_SRC" -fno-builtin $rename -c "$exp/promotion-ladder/src/guest.c" -o "$z/guest.o"
	$cc $opt "$here/harness.c" "$z"/*.o -o "$out/zlib-$arm"
	local s=$out/obj-zstd-$arm
	for f in "$ZSTD_SRC"/lib/common/*.c "$ZSTD_SRC"/lib/compress/*.c "$ZSTD_SRC"/lib/decompress/*.c; do
		$cc $opt -w -DZSTD_DISABLE_ASM -DZSTD_LEGACY_SUPPORT=0 -DDEBUGLEVEL=0 -I"$ZSTD_SRC/lib" -I"$ZSTD_SRC/lib/common" -c "$f" -o "$s/$(basename "$f" .c).o"
	done
	# mini.h's malloc, calloc and free are the arena the guest resets, so only the mem* and strlen routines are renamed here
	$cc $opt -w -fno-builtin -Dmemcpy=guest_memcpy -Dmemmove=guest_memmove -Dmemset=guest_memset -Dmemcmp=guest_memcmp -Dstrlen=guest_strlen \
		-DZSTD_DISABLE_ASM -DZSTD_LEGACY_SUPPORT=0 -DDEBUGLEVEL=0 -I"$ZSTD_SRC/lib" -I"$ZSTD_SRC/lib/common" -I"$exp/promotion-cut/src" \
		-c "$exp/promotion-cut/src/zstd.c" -o "$s/guest.o"
	$cc $opt "$here/harness.c" "$s"/*.o -o "$out/zstd-$arm"
}

build O2 "-O2"
build O3native "-O3 -march=native"
echo "built $out/{zlib,zstd}-{O2,O3native} with $($cc --version | head -1)"
