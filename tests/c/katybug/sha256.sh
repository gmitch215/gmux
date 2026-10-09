#!/usr/bin/env bash
# the hash block kernels (sha256, md5, sha1, sha512): the static x86-64 coreutils 9.5 that userland-build.sh makes
# (build/katybug/transcript/ubin/coreutils by default) hashes files of 0, 1, 55, 56, 63, 64, 65, 111, 112, 127,
# 128 and 129 bytes and one of 64 MiB, and checks them with -c, natively and under katybug with the kernels off
# and on; every output must be the same. sha256-faults.c calls each tool's block function from a program that
# copies its code out of the same file; its output is <tool>-faults.expected (native Linux's). The kernel must
# have run in both.
# usage: tests/c/katybug/sha256.sh [coreutils [tool...]]; tools default to sha256 md5 sha1 sha512
# NATIVE_HOST required: an ssh host that runs x86-64 natively
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
root=$(cd "$here/../../.." && pwd)
llvm=${LLVM:-/opt/homebrew/opt/llvm/bin}
host=${NATIVE_HOST:?set NATIVE_HOST to an ssh host that runs x86-64 natively}
cu=${1:-$root/build/katybug/transcript/ubin/coreutils}
cu=$(cd "$(dirname "$cu")" && pwd)/$(basename "$cu")
shift || true
tools=${*:-sha256 md5 sha1 sha512}
out=$(mktemp -d)
rig=gmux-rig/k34-sha256
cc -std=c11 -D_DEFAULT_SOURCE -D_DARWIN_C_SOURCE -O2 -Wall -Wextra -Werror -o "$out/katybug" "$root"/src/gmux/katybug/*.c -lm
"$llvm/clang" --target=x86_64-linux-gnu -nostdlib -static -fuse-ld=lld -O2 -ffreestanding -fno-stack-protector \
	-fno-builtin -mno-sse -mno-mmx -mno-red-zone -o "$out/sha256-faults" "$here/sha256-faults.c"
fail=0
ran() {
	# ran <label> <log> <tool>: the kernel's calls in a katybug stats log
	local n
	n=$(grep -o "$3 [0-9]*" "$2" | tail -1 | cut -d' ' -f2)
	echo "# $1: $3 kernel $n calls"
	[ "${n:-0}" -gt 0 ] || {
		echo "FAIL $1: the kernel did not run"
		fail=1
	}
}
same() {
	cmp -s "$1" "$2" || {
		echo "FAIL $3"
		diff "$1" "$2" | head -5 || true
		fail=1
	}
}

cat "$cu" | ssh "$host" "mkdir -p ~/$rig && cat > ~/$rig/coreutils && chmod +x ~/$rig/coreutils"
cat "$out/sha256-faults" | ssh "$host" "cat > ~/$rig/sha256-faults && chmod +x ~/$rig/sha256-faults"
# the files: 0, 1, 55, 56, 63, 64, 65 bytes and 64 MiB, the same bytes on both machines
gen=': > f0; for n in 1 55 56 63 64 65 111 112 127 128 129; do seq 1 100 | head -c $n > f$n; done; [ -f big ] || awk "BEGIN {for (i = 1; i <= 9500000; i++) print i}" | head -c 67108864 > big'
mkdir -p "$out/w"
(cd "$out/w" && sh -c "$gen")
files="f0 f1 f55 f56 f63 f64 f65 f111 f112 f127 f128 f129 big"

for tool in $tools; do
	exp="$here/$tool-faults.expected"
	echo "# $tool"
	# the function called directly: native output is the committed one
	ssh "$host" "cd ~/$rig && ./sha256-faults ./coreutils $tool" > "$out/faults.native"
	if [ -f "$exp" ]; then
		same "$exp" "$out/faults.native" "$tool-faults: native differs from $tool-faults.expected"
	else
		echo "FAIL $tool-faults.expected does not exist; native output is $out/faults.native"
		fail=1
		continue
	fi
	(cd "$out" && KATYBUG_PRIM=0 ./katybug ./sha256-faults "$cu" $tool > faults.off)
	rm -f "$out/p.log"
	(cd "$out" && KATYBUG_STATS=1 KATYBUG_PRIM_LOG="$out/p.log" ./katybug ./sha256-faults "$cu" $tool > faults.on)
	same "$exp" "$out/faults.off" "$tool-faults: kernel off differs from native"
	same "$exp" "$out/faults.on" "$tool-faults: kernel on differs from native"
	ran "$tool-faults" "$out/p.log" "$tool"
	echo "$(wc -l < "$out/faults.on") fault-case lines, $(grep -c fault "$out/faults.on") with a fault"

	ssh "$host" "cd ~/$rig && $gen && ./coreutils --coreutils-prog=${tool}sum $files > sums.$tool && ./coreutils --coreutils-prog=${tool}sum -c sums.$tool; echo rc \$?" \
		> "$out/files.native"
	ssh "$host" "cat ~/$rig/sums.$tool" > "$out/w/sums"
	for arm in off on; do
		rm -f "$out/p.log"
		if [ $arm = off ]; then export KATYBUG_PRIM=0; else unset KATYBUG_PRIM; fi
		(
			cd "$out/w"
			export KATYBUG_STATS=1 KATYBUG_PRIM_LOG="$out/p.log"
			"$out/katybug" "$cu" --coreutils-prog=${tool}sum $files > ../sums.$arm 2> /dev/null
			rc=0
			"$out/katybug" "$cu" --coreutils-prog=${tool}sum -c sums > ../check.$arm 2> /dev/null || rc=$?
			echo "rc $rc" >> ../check.$arm
		)
		[ $arm = on ] && ran "${tool}sum and -c, 64 MiB" "$out/p.log" "$tool"
	done
	unset KATYBUG_PRIM
	ssh "$host" "cat ~/$rig/sums.$tool" > "$out/sums.native"
	{
		cat "$out/sums.on" && cat "$out/check.on"
	} > "$out/files.on"
	{
		cat "$out/sums.off" && cat "$out/check.off"
	} > "$out/files.off"
	{
		cat "$out/sums.native" && cat "$out/files.native"
	} > "$out/files.nat"
	same "$out/files.nat" "$out/files.on" "$tool files: kernel on differs from native"
	same "$out/files.nat" "$out/files.off" "$tool files: kernel off differs from native"
	echo "$(wc -l < "$out/files.on") lines"
done
exit $fail
