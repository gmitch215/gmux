#!/usr/bin/env bash
# the x86-64 files a machine needs to run zbench over a guest libz: Alpine's loader and libz.so.1 and
# zbench linked against them (Alpine's zlib is stock: the compress2 kernel takes it). Built in an amd64
# Alpine container on the host docker runs on (an arm64 Mac emulates it).
# usage: zlib-guest.sh <out dir>   (writes zbench, ld-musl-x86_64.so.1, libz.so.1 and zlib.txt there)
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
out=${1:?usage: zlib-guest.sh <out dir>}
mkdir -p "$out"
out=$(cd "$out" && pwd)
docker run --rm --platform linux/amd64 --memory 1g --cpus 2 -v "$here/..:/src:ro" -v "$out:/out" alpine:3.20 sh -c '
	apk add --no-cache build-base zlib-dev > /dev/null &&
	cc -O1 -fno-builtin -o /out/zbench /src/zbench.c -lz &&
	cp -L /lib/ld-musl-x86_64.so.1 /lib/libz.so.1 /out/ &&
	apk list -I zlib | head -1 > /out/zlib.txt'
cat "$out/zlib.txt"
