#!/usr/bin/env bash
# the syscall share of a real configure and make run: GNU coreutils 9.5 (the pin of
# tests/suites/coreutils-build.sh) configured and built in an Alpine container on an aarch64 Linux
# kernel, so the syscall numbers are the asm-generic ones gmux's kernel takes. One untraced pass for
# user and sys time, one strace -f pass for the counts; share.ts tabulates the traces.
# usage: share.sh <out dir> [jobs]
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
mkdir -p "$1"
out=$(cd "$1" && pwd)
jobs=${2:-4}
tar=coreutils-9.5.tar.xz
sum=cd328edeac92f6a665de9f323c93b712af1858bc2e0d88f3f7100469470a1b8a
[ -f "$out/$tar" ] || curl -sSfL -o "$out/$tar" "https://ftp.gnu.org/gnu/coreutils/$tar"
echo "$sum  $out/$tar" | shasum -a 256 -c - > /dev/null
: > "$out/time.txt"
docker run --rm --memory 4g --cpus "$jobs" --cap-add SYS_PTRACE -v "$out:/out" alpine:3.20 sh -c "
	set -eu
	apk add --no-cache build-base linux-headers xz strace bash > /dev/null
	grep '#define __NR' /usr/include/asm-generic/unistd.h > /out/nr.txt
	for mode in plain traced; do
		mkdir -p /w/\$mode && cd /w/\$mode && tar xf /out/$tar && cd coreutils-9.5
		export FORCE_UNSAFE_CONFIGURE=1
		if [ \$mode = traced ]; then
			strace -f -s 160 -o /out/configure.st ./configure -q LDFLAGS=-static --disable-nls --enable-single-binary=symlinks
			strace -f -s 160 -o /out/make.st make -s -j$jobs
		else
			bash -c \"TIMEFORMAT='configure real=%R user=%U sys=%S'; time ./configure -q LDFLAGS=-static --disable-nls --enable-single-binary=symlinks\" 2>&1 | grep real= >> /out/time.txt
			bash -c \"TIMEFORMAT='make real=%R user=%U sys=%S'; time make -s -j$jobs\" 2>&1 | grep real= >> /out/time.txt
		fi
	done
"
ls -l "$out"/*.st "$out/time.txt"
