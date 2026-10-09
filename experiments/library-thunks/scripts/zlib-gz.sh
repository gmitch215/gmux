#!/usr/bin/env bash
# a 64 MiB file through zbench's gzip-format compress and decompress (gz c, gz d: windowBits 31, 64 KiB pieces through
# deflate and inflate), natively, under katybug with its kernels off and with them on, over the katybug and zbench
# zlib-check.sh left in its rig: the compressed bytes and the decompressed file must be the same in the three arms,
# the decompressed file must be the original, and the container's own gzip must read what the kernels' arm wrote.
# usage: zlib-gz.sh <out dir> [MiB]; KATYBUG_ARCH=aarch64 for arm64 (default x86_64); NATIVE_HOST required for x86_64
# (an ssh host with docker, or local), RIG as in zlib-check.sh
set -euo pipefail
case ${KATYBUG_ARCH:-x86_64} in
	x86_64) platform=linux/amd64 sfx= host=${NATIVE_HOST:?set NATIVE_HOST to an ssh host with docker, or local} ;;
	aarch64) platform=linux/arm64 sfx=-aarch64 host=${NATIVE_HOST:-local} ;;
	*)
		echo "KATYBUG_ARCH: x86_64 or aarch64" >&2
		exit 2
		;;
esac
dock="docker run --rm --platform $platform --memory 2g --cpus 2 --user \$(id -u):\$(id -g)"
rig=${RIG:-gmux-rig/k7z$sfx}
on_host() {
	if [ "$host" = local ]; then (cd && sh -c "$1"); else ssh "$host" "$1"; fi
}
out=${1:?usage: zlib-gz.sh <out dir> [MiB]}
mib=${2:-64}
mkdir -p "$out"
fail=0
for pair in debian:bookworm-slim:glibc alpine:3.20:musl; do
	img=${pair%:*}
	libc=${pair##*:}
	tag=${img%%:*}
	z=/t/gz-$tag
	echo "## $tag"
	run() {
		on_host "$dock -v \"\$HOME/$rig/t:/t\" -e KATYBUG_STATS=1 -e KATYBUG_PRIM_LOG=/t/gz-$tag.$1.log $img sh -c 'mkdir -p $z && cd $z && $2'"
	}
	z=/t/gz-$tag
	run native "rm -f *; /t/zbench-$libc gz gen $mib big.bin; wc -c < big.bin" | tee "$out/$tag.gen"
	for arm in native off on; do
		pre=""
		[ $arm = on ] && pre=/t/katybug
		[ $arm = off ] && pre="env KATYBUG_PRIM=memcpy,memmove,memset,exp,log,pow /t/katybug"
		run $arm "rm -f /t/gz-$tag.$arm.log; $pre /t/zbench-$libc gz c big.bin big.$arm.gz 31 6; $pre /t/zbench-$libc gz d big.$arm.gz big.$arm.out 31; cmp big.bin big.$arm.out && echo roundtrip=same; grep prim /t/gz-$tag.$arm.log 2> /dev/null | cut -c1-4000" | tee "$out/$tag.$arm"
	done
	for arm in off on; do
		on_host "$dock -v \"\$HOME/$rig/t:/t\" $img sh -c 'cd $z && cmp big.native.gz big.$arm.gz && echo \"$arm gz == native gz\"'" || {
			echo "FAIL $tag: the $arm arm wrote other compressed bytes"
			fail=1
		}
	done
	on_host "$dock -v \"\$HOME/$rig/t:/t\" $img sh -c 'cd $z && gzip -dc big.on.gz | cmp - big.bin && echo \"gzip reads the kernel arm: same\"'" || {
		echo "FAIL $tag: the container's gzip does not read the kernel arm's file"
		fail=1
	}
	for arm in native off on; do
		grep -q roundtrip=same "$out/$tag.$arm" || {
			echo "FAIL $tag $arm: the round trip is not the original"
			fail=1
		}
	done
	for e in deflate inflate; do
		n=$(grep -o " $e [1-9][0-9]* (" "$out/$tag.on" | head -1 | cut -d' ' -f3 || true)
		[ "${n:-0}" -gt 0 ] || {
			echo "FAIL $tag: the $e kernel did not run"
			fail=1
		}
	done
done
exit $fail
