#!/usr/bin/env bash
# the library-call check: thunk.c, dynamically linked against Debian's glibc and Alpine's musl, runs
# natively, under a static katybug with its kernels off, and with them on (every size, lazy and
# immediate binding). The kernels must have run. Alpine's memcpy is the same code natively, so
# there native, off and on must be identical, faults included. glibc picks its variant by cpuid
# (and the off arm can stop at an SSE instruction katybug lacks), so there on is compared with
# native on every line but the faults' addr, rip and sum.
# usage: tests/c/katybug/thunk.sh; KATYBUG_ARCH=aarch64 checks arm64 (default x86_64);
# NATIVE_HOST required for x86_64, local by default for aarch64
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
dock="docker run --rm --platform $platform --memory 1g --cpus 2"
rig=gmux-rig/k7$sfx
on_host() {
	if [ "$host" = local ]; then (cd && sh -c "$1"); else ssh "$host" "$1"; fi
}
out=$(mktemp -d)
mkdir -p "$out/t"
cp "$here/thunk.c" "$out/t/"
cat > "$out/t/each.sh" << 'EOF'
#!/bin/sh
# each.sh bin [launcher]: one thunk run, then its prim line
cd /t
if [ -n "${2:-}" ]; then
	KATYBUG_STATS=1 KATYBUG_PRIM_LOG=/t/prim.log timeout 300 $2 "$1" 2>&1
else
	timeout 60 "$1" 2>&1
fi
echo "rc $?"
EOF
tar -C "$root/src/gmux/katybug" -cf "$out/t/src.tar" .
tar -C "$out" -cf - t | on_host "mkdir -p ~/$rig && tar -C ~/$rig -xf -"
on_host "$dock -v \"\$HOME/$rig/t:/t\" alpine:3.20 sh -c 'apk add --no-cache build-base > /dev/null &&
	mkdir -p /src && tar -C /src -xf /t/src.tar && cc -std=c11 -D_DEFAULT_SOURCE -O2 -static -o /t/katybug /src/*.c -lm &&
	cc -O1 -fno-builtin -o /t/thunk-musl /t/thunk.c && cc -O1 -fno-builtin -Wl,-z,now -o /t/thunk-musl-now /t/thunk.c'"
on_host "$dock -v \"\$HOME/$rig/t:/t\" debian:bookworm-slim sh -c 'apt-get -qq update > /dev/null &&
	apt-get -qq install -y gcc libc6-dev > /dev/null 2>&1 && gcc -O1 -fno-builtin -o /t/thunk-glibc /t/thunk.c &&
	gcc -O1 -fno-builtin -Wl,-z,now -o /t/thunk-glibc-now /t/thunk.c'"
fail=0
for img in debian:bookworm-slim alpine:3.20; do
	tag=${img%%:*}
	libc=glibc
	[ "$tag" = alpine ] && libc=musl
	for bind in "" -now; do
		bin=/t/thunk-$libc$bind
		run() { on_host "rm -f \$HOME/$rig/t/prim.log; $dock -v \"\$HOME/$rig/t:/t\" $img sh /t/each.sh $bin $1; cat \$HOME/$rig/t/prim.log 2> /dev/null || true"; }
		run "" > "$out/$tag$bind.native.txt"
		run "/t/katybug" > "$out/$tag$bind.on.txt"
		on_host "$dock -v \"\$HOME/$rig/t:/t\" -e KATYBUG_PRIM=0 $img sh /t/each.sh $bin /t/katybug" > "$out/$tag$bind.off.txt"
		grep -v '^katybug:' "$out/$tag$bind.on.txt" > "$out/$tag$bind.on.out"
		grep -v '^katybug:' "$out/$tag$bind.off.txt" > "$out/$tag$bind.off.out"
		prim=$(grep '^katybug: prim' "$out/$tag$bind.on.txt" | tail -1 || true)
		echo "# $tag$bind: $prim"
		calls=$(printf '%s\n' "$prim" | { grep -o 'mem[a-z]* [0-9]*' || true; } | awk '{s += $2} END {print s + 0}')
		if [ "$calls" -eq 0 ]; then
			echo "FAIL no kernel ran"
			fail=1
		fi
		if [ "$libc" = musl ]; then
			for arm in native.txt off.out; do
				cmp -s "$out/$tag$bind.$arm" "$out/$tag$bind.on.out" || {
					echo "FAIL $arm != on"
					diff "$out/$tag$bind.$arm" "$out/$tag$bind.on.out" | head || true
					fail=1
				}
			done
		else
			# fault lines without rip and sum: a variant's partial copy and entry differ by cpuid
			strip() { sed -E '/fault/ s/ (addr|rip|sum)=[^ ]*//g' "$1"; }
			diff <(strip "$out/$tag$bind.native.txt") <(strip "$out/$tag$bind.on.out") > /dev/null || {
				echo "FAIL native != on"
				diff <(strip "$out/$tag$bind.native.txt") <(strip "$out/$tag$bind.on.out") | head || true
				fail=1
			}
			echo "off arm: $(tail -1 "$out/$tag$bind.off.out")"
		fi
		echo "$(wc -l < "$out/$tag$bind.on.out") lines, $(grep -c fault "$out/$tag$bind.on.out") fault lines"
	done
done
exit $fail
