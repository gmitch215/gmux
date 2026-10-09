#!/usr/bin/env bash
# zlib thunks: zbench.c against the guest's libz in a Debian 12 (1.2.13), an Alpine 3.20 (1.3.x), a Debian 11 (1.2.11,
# the eol image: bullseye is off the main mirrors) and a Fedora 41 (zlib-ng, a fork that writes other bytes) container, run natively, under a static katybug with its
# kernels off, and with them on (crc32, adler32, compress2 and uncompress, and the stream entries deflateInit_ to
# inflateCodesUsed, over the zlib katybug was built with, -DKB_ZLIB, linked from Alpine's). `check`, `bytes` (4 MiB at
# levels 1, 6, 9) and the stream modes (stream-deflate, stream-inflate, stream-misc, alloc, fault) must print the same
# lines in all three arms; the kernels must run for the stock libz and must not for the fork, whose bytes they would
# change. zpoison (an object that imports deflateSetHeader or inflateBack) and fork (a stream open across a fork, with
# and without fork-by-exec) are single hazards with their own expectations. Prints the lines of each arm and a verdict,
# and exits 1 on a FAIL.
# usage: zlib-check.sh <out dir>; KATYBUG_ARCH=aarch64 for arm64 (default x86_64); NATIVE_HOST required
# for x86_64 (an ssh host with docker, or local), local by default for aarch64; KB_CC=clang builds katybug with
# the container's clang and lld (CI's compilers are clang 18 and lld 18), RIG the directory under $HOME it works in
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
rig=${RIG:-gmux-rig/k7z$sfx}
on_host() {
	if [ "$host" = local ]; then (cd && sh -c "$1"); else ssh "$host" "$1"; fi
}
out=${1:?usage: zlib-check.sh <out dir>}
mkdir -p "$out/t"
cp "$here/../zbench.c" "$here/../zpoison.c" "$out/t/"
tar -C "$root/src/gmux/katybug" -cf "$out/t/src.tar" .
tar -C "$out" -cf - t | on_host "mkdir -p ~/$rig && tar -C ~/$rig -xf -"
on_host "$dock -v \"\$HOME/$rig/t:/t\" alpine:3.20 sh -c 'apk add --no-cache build-base zlib-dev zlib-static ${KB_CC:+clang lld} > /dev/null &&
	mkdir -p /src && tar -C /src -xf /t/src.tar && ${KB_CC:-cc} -std=c11 -D_DEFAULT_SOURCE -DKB_ZLIB -O2 -static ${KB_CC:+-fuse-ld=lld -Wall -Wextra -Werror} -o /t/katybug /src/*.c -lm -lz &&
	cc -O1 -fno-builtin -o /t/zbench-musl /t/zbench.c -lz && cc -O1 -fno-builtin -o /t/zpoison-musl /t/zpoison.c -lz &&
	apk list -I zlib | head -1 > /t/zlib-musl.txt'"
on_host "$dock -v \"\$HOME/$rig/t:/t\" debian:bookworm-slim sh -c 'apt-get -qq update > /dev/null &&
	apt-get -qq install -y gcc libc6-dev zlib1g-dev > /dev/null 2>&1 && gcc -O1 -fno-builtin -o /t/zbench-glibc /t/zbench.c -lz &&
	gcc -O1 -fno-builtin -o /t/zpoison-glibc /t/zpoison.c -lz &&
	dpkg-query -W -f \"zlib1g \\\${Version}\\n\" zlib1g > /t/zlib-glibc.txt'"
on_host "$dock -v \"\$HOME/$rig/t:/t\" debian/eol:bullseye-slim sh -c 'apt-get -qq update > /dev/null &&
	apt-get -qq install -y gcc libc6-dev zlib1g-dev > /dev/null 2>&1 && gcc -O1 -fno-builtin -o /t/zbench-glibc11 /t/zbench.c -lz &&
	gcc -O1 -fno-builtin -o /t/zpoison-glibc11 /t/zpoison.c -lz &&
	dpkg-query -W -f \"zlib1g \\\${Version}\\n\" zlib1g > /t/zlib-glibc11.txt'"
on_host "$dock -v \"\$HOME/$rig/t:/t\" debian:trixie-slim sh -c 'apt-get -qq update > /dev/null &&
	apt-get -qq install -y gcc libc6-dev zlib1g-dev > /dev/null 2>&1 && gcc -O1 -fno-builtin -o /t/zbench-glibc13 /t/zbench.c -lz &&
	gcc -O1 -fno-builtin -o /t/zpoison-glibc13 /t/zpoison.c -lz &&
	dpkg-query -W -f \"zlib1g \\\${Version}\\n\" zlib1g > /t/zlib-glibc13.txt'"
on_host "$dock -v \"\$HOME/$rig/t:/t\" fedora:41 sh -c 'dnf -q -y install gcc zlib-ng-compat-devel > /dev/null 2>&1 &&
	gcc -O1 -fno-builtin -o /t/zbench-fedora /t/zbench.c -lz && gcc -O1 -fno-builtin -o /t/zpoison-fedora /t/zpoison.c -lz &&
	rpm -q zlib-ng-compat > /t/zlib-fedora.txt'"
fail=0
bad() {
	echo "FAIL $*"
	fail=1
}
# the calls a kernel ran, from the last prim line of a log: cnt <file> <entry>
cnt() {
	grep '^katybug: prim' "$1" | tail -1 | grep -o " $2 [0-9]* (" | head -1 | cut -d' ' -f3 || true
}
streams() {
	grep '^katybug: prim' "$1" | tail -1 | grep -o '\(deflate\|inflate\)[A-Za-z0-9_]* [0-9]* ([0-9]* gave up)' | tr '\n' ';' || true
}
for img in debian:bookworm-slim debian:trixie-slim alpine:3.20 debian/eol:bullseye-slim fedora:41; do
	tag=${img%%:*}
	libc=glibc
	[ "$tag" = alpine ] && libc=musl
	[ "$tag" = fedora ] && libc=fedora
	[ "$img" = debian/eol:bullseye-slim ] && libc=glibc11 && tag=bullseye
	[ "$img" = debian:trixie-slim ] && libc=glibc13 && tag=trixie
	# streams over a libz that is not 1.2.13, 1.3.1 or 1.3.2 stay the guest's (1.2.11 differs at level 0, in
	# deflateBound and in inflateSync; zlib-ng is another library); glibc 2.31 under katybug prints nothing in fault
	streams_run=1
	modes="bytes check stream-deflate stream-inflate stream-misc alloc fault"
	if [ "$tag" = fedora ] || [ "$tag" = bullseye ]; then streams_run=0; fi
	[ "$tag" = bullseye ] && modes="bytes check stream-deflate stream-inflate stream-misc alloc"
	echo "## $tag: guest libz $(on_host "cat \$HOME/$rig/t/zlib-$libc.txt")"
	# a guest run: guest <args...>; ARM is native, off or on; the log of the kernels is printed after the lines
	guest() {
		local arm=$1 prog=$2 envs=$3
		shift 3
		local pre="" dargs="$envs"
		[ $arm = on ] && pre=/t/katybug
		if [ $arm = off ]; then
			pre=/t/katybug
			dargs="$dargs -e KATYBUG_PRIM=memcpy,memmove,memset,exp,log,pow"
		fi
		on_host "rm -f \$HOME/$rig/t/prim.log; $dock -v \"\$HOME/$rig/t:/t\" $dargs $img sh -c 'cd /t && KATYBUG_STATS=1 KATYBUG_PRIM_LOG=/t/prim.log $pre /t/$prog-$libc $* 2>&1 | grep -v ^katybug:; true'; cat \$HOME/$rig/t/prim.log 2> /dev/null || true"
	}
	# zlib-ng's inflate writes into the unused tail of a longer destination with code its CPU features pick
	# (7 bytes under katybug, none natively), which zlib's interface allows, so variant 5 says nothing there
	drop='^katybug:'
	[ "$tag" = fedora ] && drop='^katybug:|^uncompress variant 5 |^wrong as-inflate2 '
	for mode in $modes; do
		for arm in native off on; do guest $arm zbench "" $mode > "$out/$tag.$mode.$arm"; done
		for arm in native off on; do grep -Ev "$drop" "$out/$tag.$mode.$arm" > "$out/$tag.$mode.$arm.out" || true; done
		# a guest katybug cannot run at all (Fedora's AArch64 libc stops at an instruction it lacks, rc 132) is
		# not a verdict on the kernels
		if [ "$tag" = fedora ] && [ ! -s "$out/$tag.$mode.off.out" ]; then
			echo "SKIP $tag: katybug prints nothing with its kernels off, so the fork cannot be checked here"
			continue 2
		fi
		[ -s "$out/$tag.$mode.native.out" ] || bad "$tag $mode: the native run printed nothing"
		echo "# $tag $mode: native $(wc -l < "$out/$tag.$mode.native.out") lines, off == native: $(cmp -s "$out/$tag.$mode.off.out" "$out/$tag.$mode.native.out" && echo yes || echo NO), on == off: $(cmp -s "$out/$tag.$mode.on.out" "$out/$tag.$mode.off.out" && echo yes || echo NO)"
		grep '^katybug: prim' "$out/$tag.$mode.on" | tail -1 | grep -o 'crc32.*' | cut -c1-900 || true
		if [ $mode = bytes ]; then cat "$out/$tag.$mode.native.out"; fi
		diff "$out/$tag.$mode.off.out" "$out/$tag.$mode.on.out" | head -12 || true
		# zlib-ng's stream calls need not equal the stock library's (its streams are the guest's in every arm), so
		# for its stream modes the two katybug arms are what must agree
		arms="off on"
		if [ "$tag" = fedora ]; then
			case $mode in stream-* | alloc | fault) arms=on ;; esac
		fi
		for arm in $arms; do
			cmp -s "$out/$tag.$mode.$arm.out" "$out/$tag.$mode.native.out" || bad "$tag $mode: $arm != native"
		done
		[ "$arms" = on ] && { cmp -s "$out/$tag.$mode.on.out" "$out/$tag.$mode.off.out" || bad "$tag $mode: on != off"; }
		echo "# $tag $mode: stream entries: $(streams "$out/$tag.$mode.on")"
	done
	ran=$(cnt "$out/$tag.check.on" compress2)
	d=$(cnt "$out/$tag.stream-deflate.on" deflate)
	i=$(cnt "$out/$tag.stream-inflate.on" inflate)
	if [ "$tag" = fedora ]; then
		[ "${ran:-0}" -eq 0 ] || bad "$tag: the compress2 kernel ran $ran times over a libz that is not stock zlib"
	else
		[ "${ran:-0}" -gt 0 ] || bad "$tag: the compress2 kernel did not run over a stock libz"
	fi
	if [ $streams_run = 0 ]; then
		[ "${d:-0}" -eq 0 ] && [ "${i:-0}" -eq 0 ] || bad "$tag: the stream kernels ran ($d deflate, $i inflate) over a libz they were not compared with"
	else
		[ "${d:-0}" -gt 0 ] || bad "$tag: no deflate stream kernel ran over a stock libz"
		[ "${i:-0}" -gt 0 ] || bad "$tag: no inflate stream kernel ran over a stock libz"
		[ "$(cnt "$out/$tag.fault.on" deflate || echo 0)" -gt 0 ] && [ "$(cnt "$out/$tag.fault.on" inflate || echo 0)" -gt 0 ] || bad "$tag: the fault mode ran no stream kernel"
	fi
	echo "# $tag: compress2 kernel calls ${ran:-0}, deflate ${d:-0}, inflate ${i:-0}"
	# objects that import what a stream mirror cannot serve: unchanged, no stream kernel in the process
	for p in hdr back; do
		for arm in native off on; do guest $arm zpoison "" $p > "$out/$tag.zpoison-$p.$arm"; done
		for arm in native off on; do grep -Ev '^katybug:' "$out/$tag.zpoison-$p.$arm" > "$out/$tag.zpoison-$p.$arm.out" || true; done
		[ -s "$out/$tag.zpoison-$p.native.out" ] || bad "$tag zpoison $p: the native run printed nothing"
		echo "# $tag zpoison $p: off == native: $(cmp -s "$out/$tag.zpoison-$p.off.out" "$out/$tag.zpoison-$p.native.out" && echo yes || echo NO), on == native: $(cmp -s "$out/$tag.zpoison-$p.on.out" "$out/$tag.zpoison-$p.native.out" && echo yes || echo NO)"
		cmp -s "$out/$tag.zpoison-$p.off.out" "$out/$tag.zpoison-$p.native.out" || bad "$tag zpoison $p: off != native"
		cmp -s "$out/$tag.zpoison-$p.on.out" "$out/$tag.zpoison-$p.native.out" || bad "$tag zpoison $p: on != native"
		ranp=$(grep '^katybug: prim' "$out/$tag.zpoison-$p.on" | tail -1 | grep -o '\(deflate\|inflate\)[A-Za-z0-9_]* [1-9][0-9]* (' | head -3 | tr '\n' ' ' || true)
		[ -z "$ranp" ] || bad "$tag zpoison $p: stream kernels ran: $ranp"
		echo "# $tag zpoison $p: stream entries: $(streams "$out/$tag.zpoison-$p.on")"
	done
	# a stream open across fork: a plain fork copies the host's table; fork-by-exec sends guest memory only, so the
	# child's use of the old stream fails in its libz's state check (Z_STREAM_ERROR) and is counted as lost
	for arm in native off on; do guest $arm zbench "" fork > "$out/$tag.fork.$arm"; done
	guest on zbench "-e KATYBUG_FORK=exec" fork > "$out/$tag.fork.exec"
	for arm in native off on exec; do grep -Ev '^katybug:' "$out/$tag.fork.$arm" > "$out/$tag.fork.$arm.out" || true; done
	echo "# $tag fork: off == native: $(cmp -s "$out/$tag.fork.off.out" "$out/$tag.fork.native.out" && echo yes || echo NO), on == native: $(cmp -s "$out/$tag.fork.on.out" "$out/$tag.fork.native.out" && echo yes || echo NO)"
	cmp -s "$out/$tag.fork.off.out" "$out/$tag.fork.native.out" || bad "$tag fork: off != native"
	cmp -s "$out/$tag.fork.on.out" "$out/$tag.fork.native.out" || bad "$tag fork: on != native"
	if [ $streams_run = 1 ]; then
		# under fork-by-exec: every line but the child's use of the old stream and its end equals native's
		grep -Ev '^fork child-old|^child end' "$out/$tag.fork.exec.out" > "$out/$tag.fork.exec.rest" || true
		grep -Ev '^fork child-old|^child end' "$out/$tag.fork.native.out" > "$out/$tag.fork.native.rest" || true
		cmp -s "$out/$tag.fork.exec.rest" "$out/$tag.fork.native.rest" || bad "$tag fork-by-exec: the parent's or the child's own stream differs from native"
		grep -q '^fork child-old #0 rc -2 ' "$out/$tag.fork.exec.out" || bad "$tag fork-by-exec: the child's old stream did not return Z_STREAM_ERROR"
		grep '^katybug: prim' "$out/$tag.fork.exec" | grep -q 'zstream lost [1-9]' || bad "$tag fork-by-exec: no lost stream was counted"
		echo "# $tag fork-by-exec: $(grep '^fork child-old' "$out/$tag.fork.exec.out" | cut -c1-80); $(grep -o 'zstream lost [0-9]*' "$out/$tag.fork.exec" | head -1)"
	fi
done
exit $fail
