#!/usr/bin/env bash
# zlib thunks: zbench.c against the guest's libz in a Debian (1.2.13) and an Alpine (1.3.1) container, run
# natively, under a static katybug with its kernels off, and with them on (crc32, adler32, compress2 and
# uncompress over the zlib katybug was built with: Alpine's 1.3.1, -DKB_ZLIB). `check` must print the same
# lines in all three arms; where it does not, the guest's zlib and the host's write different bytes, and
# `bytes` (4 MiB at levels 1, 6, 9) says which version and level. Prints the lines of each arm and a verdict.
# usage: zlib-check.sh <out dir>; KATYBUG_ARCH=aarch64 for arm64 (default x86_64); NATIVE_HOST required
# for x86_64 (an ssh host with docker, or local), local by default for aarch64
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
root=$(cd "$here/../../.." && pwd)
case ${KATYBUG_ARCH:-x86_64} in
	x86_64) platform=linux/amd64 sfx= host=${NATIVE_HOST:?set NATIVE_HOST to an ssh host with docker, or local} ;;
	aarch64) platform=linux/arm64 sfx=-aarch64 host=${NATIVE_HOST:-local} ;;
	*)
		echo "KATYBUG_ARCH: x86_64 or aarch64" >&2
		exit 2
		;;
esac
dock="docker run --rm --platform $platform --memory 2g --cpus 2"
rig=gmux-rig/k7z$sfx
on_host() {
	if [ "$host" = local ]; then (cd && sh -c "$1"); else ssh "$host" "$1"; fi
}
out=${1:?usage: zlib-check.sh <out dir>}
mkdir -p "$out/t"
cp "$here/../zbench.c" "$out/t/"
tar -C "$root/src/gmux/katybug" -cf "$out/t/src.tar" .
tar -C "$out" -cf - t | on_host "mkdir -p ~/$rig && tar -C ~/$rig -xf -"
on_host "$dock -v \"\$HOME/$rig/t:/t\" alpine:3.20 sh -c 'apk add --no-cache build-base zlib-dev zlib-static > /dev/null &&
	mkdir -p /src && tar -C /src -xf /t/src.tar && cc -std=c11 -D_DEFAULT_SOURCE -DKB_ZLIB -O2 -static -o /t/katybug /src/*.c -lm -lz &&
	cc -O1 -fno-builtin -o /t/zbench-musl /t/zbench.c -lz && apk list -I zlib | head -1 > /t/zlib-musl.txt'"
on_host "$dock -v \"\$HOME/$rig/t:/t\" debian:bookworm-slim sh -c 'apt-get -qq update > /dev/null &&
	apt-get -qq install -y gcc libc6-dev zlib1g-dev > /dev/null 2>&1 && gcc -O1 -fno-builtin -o /t/zbench-glibc /t/zbench.c -lz &&
	dpkg-query -W -f \"zlib1g \\\${Version}\\n\" zlib1g > /t/zlib-glibc.txt'"
for img in debian:bookworm-slim alpine:3.20; do
	tag=${img%%:*}
	libc=glibc
	[ "$tag" = alpine ] && libc=musl
	echo "## $tag: guest libz $(on_host "cat \$HOME/$rig/t/zlib-$libc.txt")"
	for mode in bytes check; do
		run() { on_host "rm -f \$HOME/$rig/t/prim.log; $dock -v \"\$HOME/$rig/t:/t\" ${2:-} $img sh -c 'cd /t && KATYBUG_STATS=1 KATYBUG_PRIM_LOG=/t/prim.log $1 /t/zbench-$libc $mode 2>&1 | grep -v ^katybug:; true'; cat \$HOME/$rig/t/prim.log 2> /dev/null || true"; }
		run "" > "$out/$tag.$mode.native"
		run /t/katybug "" > "$out/$tag.$mode.on"
		# off: the zlib calls only (glibc's memcpy stops at an SSE store katybug lacks without its kernel)
		run /t/katybug "-e KATYBUG_PRIM=memcpy,memmove,memset,exp,log,pow" > "$out/$tag.$mode.off"
		for arm in native off on; do grep -v '^katybug:' "$out/$tag.$mode.$arm" > "$out/$tag.$mode.$arm.out"; done
		echo "# $tag $mode: native $(wc -l < "$out/$tag.$mode.native.out") lines, off == native: $(cmp -s "$out/$tag.$mode.off.out" "$out/$tag.$mode.native.out" && echo yes || echo NO), on == off: $(cmp -s "$out/$tag.$mode.on.out" "$out/$tag.$mode.off.out" && echo yes || echo NO)"
		grep '^katybug: prim' "$out/$tag.$mode.on" | tail -1 | grep -o 'crc32.*' || true
		if [ $mode = bytes ]; then cat "$out/$tag.$mode.native.out"; fi
		diff "$out/$tag.$mode.off.out" "$out/$tag.$mode.on.out" | head -12 || true
	done
done
