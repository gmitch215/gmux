#!/usr/bin/env bash
# the library-call check: thunk.c, dynamically linked against Debian's glibc and Alpine's musl, runs
# natively, under a static katybug with its kernels off, and with them on (every size, lazy and
# immediate binding). The kernels must have run. Alpine's memcpy is the same code natively, so
# there native, off and on must be identical, faults included. glibc picks its variant by cpuid
# (and the off arm can stop at an SSE instruction katybug lacks), so there on is compared with
# native on every line but the faults' addr, rip and sum. x86_64 glibc runs natively under
# GLIBC_TUNABLES that mask avx, so it picks the sse2 variants katybug's cpuid leaves it; the
# clean string cases (thunk.c clean) must run strlen, memcmp, strcmp and memchr with 0 given up.
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
cp "$here/thunk.c" "$here/libm.c" "$here/libm-vectors.txt" "$out/t/"
cat > "$out/t/libm-each.sh" << 'EOF'
#!/bin/sh
# libm-each.sh launcher bin args...: one libm run (the launcher may be empty), then its prim line
cd /t
l=$1
shift
if [ -n "$l" ]; then
	KATYBUG_STATS=1 KATYBUG_PRIM_LOG=/t/prim.log timeout 600 $l "$@" 2>&1
else
	timeout 120 "$@" 2>&1
fi
echo "rc $?"
EOF
cat > "$out/t/each.sh" << 'EOF'
#!/bin/sh
# each.sh bin [launcher [arg]]: one thunk run, then its prim line
cd /t
if [ -n "${2:-}" ]; then
	KATYBUG_STATS=1 KATYBUG_PRIM_LOG=/t/prim.log timeout 300 $2 "$1" ${3:-} 2>&1
else
	timeout 60 "$1" ${3:-} 2>&1
fi
echo "rc $?"
EOF
tar -C "$root/src/gmux/katybug" -cf "$out/t/src.tar" .
tar -C "$out" -cf - t | on_host "mkdir -p ~/$rig && tar -C ~/$rig -xf -"
on_host "$dock -v \"\$HOME/$rig/t:/t\" alpine:3.20 sh -c 'apk add --no-cache build-base > /dev/null &&
	mkdir -p /src && tar -C /src -xf /t/src.tar && cc -std=c11 -D_DEFAULT_SOURCE -O2 -static -o /t/katybug /src/*.c -lm &&
	cc -O1 -fno-builtin -o /t/thunk-musl /t/thunk.c && cc -O1 -fno-builtin -Wl,-z,now -o /t/thunk-musl-now /t/thunk.c &&
	cc -O1 -fno-builtin -ffp-contract=off -o /t/libm-musl /t/libm.c -lm'"
on_host "$dock -v \"\$HOME/$rig/t:/t\" debian:bookworm-slim sh -c 'apt-get -qq update > /dev/null &&
	apt-get -qq install -y gcc libc6-dev > /dev/null 2>&1 && gcc -O1 -fno-builtin -o /t/thunk-glibc /t/thunk.c &&
	gcc -O1 -fno-builtin -Wl,-z,now -o /t/thunk-glibc-now /t/thunk.c &&
	gcc -O1 -fno-builtin -ffp-contract=off -o /t/libm-glibc /t/libm.c -lm'"
fail=0
for img in debian:bookworm-slim alpine:3.20; do
	tag=${img%%:*}
	libc=glibc
	[ "$tag" = alpine ] && libc=musl
	for bind in "" -now; do
		bin=/t/thunk-$libc$bind
		run() { on_host "rm -f \$HOME/$rig/t/prim.log; $dock -v \"\$HOME/$rig/t:/t\" ${tun:-} $img sh /t/each.sh $bin '$1' ${2:-}; cat \$HOME/$rig/t/prim.log 2> /dev/null || true"; }
		# glibc on x86-64 runs natively with the variants katybug's cpuid selects (sse2)
		nat=
		[ "$platform$libc" = linux/amd64glibc ] && nat="-e GLIBC_TUNABLES=glibc.cpu.hwcaps=-AVX,-AVX2,-AVX512F,-AVX512VL,-AVX512BW,-AVX512DQ,-SSE4_1,-SSE4_2,-SSSE3,-FMA,-FMA4,-BMI1,-BMI2,-MOVBE,-ERMS,-FSRM,-RTM,-LZCNT,-POPCNT"
		tun=$nat run "" > "$out/$tag$bind.native.txt"
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
		# the four string functions' clean cases (no fault): every one recognized, none given up
		tun=$nat run "" clean > "$out/$tag$bind.native.clean.txt"
		run "/t/katybug" clean > "$out/$tag$bind.on.clean.txt"
		on_host "$dock -v \"\$HOME/$rig/t:/t\" -e KATYBUG_PRIM=0 $img sh /t/each.sh $bin /t/katybug clean" > "$out/$tag$bind.off.clean.txt"
		for arm in native on off; do grep -v '^katybug:' "$out/$tag$bind.$arm.clean.txt" > "$out/$tag$bind.$arm.clean.out"; done
		cprim=$(grep '^katybug: prim' "$out/$tag$bind.on.clean.txt" | tail -1 || true)
		echo "# $tag$bind clean: $cprim"
		for f in strlen memcmp strcmp memchr; do
			ran=$(printf '%s\n' "$cprim" | grep -o "$f [0-9]* (" | tr -dc '0-9')
			gave=$(printf '%s\n' "$cprim" | grep -o "$f [0-9]* ([0-9]* gave up" | grep -o '([0-9]*' | tr -dc '0-9')
			if [ "${ran:-0}" -eq 0 ] || [ "${gave:-0}" -ne 0 ]; then
				echo "FAIL $tag$bind clean: $f ran ${ran:-0}, gave up ${gave:-0}"
				fail=1
			fi
		done
		for arm in native off; do
			cmp -s "$out/$tag$bind.$arm.clean.out" "$out/$tag$bind.on.clean.out" || {
				echo "FAIL clean $arm != on"
				diff "$out/$tag$bind.$arm.clean.out" "$out/$tag$bind.on.clean.out" | head || true
				fail=1
			}
		done
		echo "$(wc -l < "$out/$tag$bind.on.clean.out") clean lines"
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

# libm.c: exp, log and pow, natively, with the kernels off and on. check reads libm-vectors.txt (the column
# glibc or musl returns on this architecture), sample hashes pseudo-random inputs, refuse gives the inputs
# the kernels leave to the guest and the rounding modes. Native, off and on print the same lines (refuse's
# mode lines, where katybug rounds to nearest whatever the register holds, only off against on). glibc on
# x86-64 runs natively without FMA (the variant katybug's cpuid selects). The kernels must have run, and
# the refusals must have reached them; glibc on AArch64 is fused by its compiler and is left to the guest
n=${LIBM_SAMPLES:-300000}
for img in debian:bookworm-slim alpine:3.20; do
	tag=${img%%:*}
	libc=glibc
	[ "$tag" = alpine ] && libc=musl
	col=4
	[ "$platform" = linux/arm64 ] && { [ "$libc" = glibc ] && col=5 || col=6; }
	tun=
	[ "$platform" = linux/amd64 ] && [ "$libc" = glibc ] && tun="-e GLIBC_TUNABLES=glibc.cpu.hwcaps=-AVX2,-FMA,-FMA4"
	for mode in "check /t/libm-vectors.txt $col" "sample $n" refuse round; do
		name=libm-$tag-${mode%% *}
		lrun() { on_host "rm -f \$HOME/$rig/t/prim.log; $dock -v \"\$HOME/$rig/t:/t\" $2 $img sh /t/libm-each.sh '$1' /t/libm-$libc $mode; cat \$HOME/$rig/t/prim.log 2> /dev/null || true"; }
		lrun "" "$tun" > "$out/$name.native.txt"
		lrun /t/katybug "" > "$out/$name.on.txt"
		lrun /t/katybug "-e KATYBUG_PRIM=0" > "$out/$name.off.txt"
		for arm in native on off; do grep -v '^katybug:' "$out/$name.$arm.txt" > "$out/$name.$arm.out"; done
		prim=$(grep '^katybug: prim' "$out/$name.on.txt" | tail -1 || true)
		echo "# $name: $(printf '%s\n' "$prim" | grep -o 'exp [0-9]* ([0-9]* gave up) log [0-9]* ([0-9]* gave up) pow [0-9]* ([0-9]* gave up)')"
		grep -q '^rc 0$' "$out/$name.on.out" || {
			echo "FAIL $name: rc"
			tail -3 "$out/$name.on.out"
			fail=1
		}
		# round: only off against on (katybug's SSE and FP rounding ignore the mode, native's do not)
		arms="native off"
		[ "${mode%% *}" = round ] && arms=off
		for arm in $arms; do
			cmp -s "$out/$name.$arm.out" "$out/$name.on.out" || {
				echo "FAIL $name: $arm != on"
				diff "$out/$name.$arm.out" "$out/$name.on.out" | head || true
				fail=1
			}
		done
		# the calls that ran and gave up in this mode: refuse and round are small and fixed, so their counts
		# are pinned (refuse: 17 arguments of exp and log, 255 pairs of pow; round: three calls each)
		case "${mode%% *}" in
			refuse) want="exp 4 13 log 6 11 pow 39 216" ;;
			round) want="exp 0 3 log 0 3 pow 0 3" ;;
			*) want= ;;
		esac
		for f in exp log pow; do
			ran=$(printf '%s\n' "$prim" | grep -o "$f [0-9]* (" | tr -dc '0-9')
			gave=$(printf '%s\n' "$prim" | grep -o "$f [0-9]* ([0-9]* gave up" | grep -o '([0-9]*' | tr -dc '0-9')
			if [ "$platform$libc" = linux/arm64glibc ]; then
				[ "${ran:-0}" -eq 0 ] || {
					echo "FAIL $name: $f ran $ran under AArch64 glibc"
					fail=1
				}
			elif [ "${mode%% *}" = sample ] && [ "${ran:-0}" -eq 0 ]; then
				echo "FAIL $name: no $f kernel ran"
				fail=1
			elif [ -n "$want" ] && [ "$f ${ran:-0} ${gave:-0}" != "$(printf '%s\n' "$want" | grep -o "$f [0-9]* [0-9]*")" ]; then
				echo "FAIL $name: $f ran ${ran:-0} and gave up ${gave:-0}, want $(printf '%s\n' "$want" | grep -o "$f [0-9]* [0-9]*")"
				fail=1
			fi
		done
		echo "$(wc -l < "$out/$name.on.out") lines"
	done
done
exit $fail
