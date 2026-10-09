#!/usr/bin/env bash
# the cksum loop kernel: the static x86-64 coreutils 9.5 that userland-build.sh makes (build/katybug/transcript/ubin/coreutils
# by default) runs cksum on files of 0, 1, 7, 8, 9, 15, 16, 17, 63, 64, 65535, 65536 and 65537 bytes and one of 64 MiB in one
# command, and on the 64 MiB file from a redirect and from a pipe, natively and under katybug with the kernel off and on; every
# output must be the same. cksum-faults.c enters the loop's block from a program that copies it out of the same file and prints
# every register and flag after it, or at a fault; its output is cksum-faults.expected (native Linux's). The kernel must have
# run in every katybug arm.
# usage: tests/c/katybug/cksum.sh [coreutils]
# NATIVE_HOST required: an ssh host that runs x86-64 natively
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
root=$(cd "$here/../../.." && pwd)
llvm=${LLVM:-/opt/homebrew/opt/llvm/bin}
host=${NATIVE_HOST:?set NATIVE_HOST to an ssh host that runs x86-64 natively}
cu=${1:-$root/build/katybug/transcript/ubin/coreutils}
cu=$(cd "$(dirname "$cu")" && pwd)/$(basename "$cu")
out=$(mktemp -d)
rig=gmux-rig/k34-sha256
cc -std=c11 -D_DEFAULT_SOURCE -D_DARWIN_C_SOURCE -O2 -Wall -Wextra -Werror -o "$out/katybug" "$root"/src/gmux/katybug/*.c -lm
"$llvm/clang" --target=x86_64-linux-gnu -nostdlib -static -fuse-ld=lld -O2 -ffreestanding -fno-stack-protector \
	-fno-builtin -mno-sse -mno-mmx -mno-red-zone -o "$out/cksum-faults" "$here/cksum-faults.c"
fail=0
ran() {
	# ran <label> <log>: the kernel's calls in a katybug stats log
	local n
	n=$(grep -o "cksum [0-9]*" "$2" | tail -1 | cut -d' ' -f2)
	echo "# $1: cksum kernel $n calls"
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
cat "$out/cksum-faults" | ssh "$host" "cat > ~/$rig/cksum-faults && chmod +x ~/$rig/cksum-faults"
gen=': > f0; for n in 1 7 8 9 15 16 17 63 64 65535 65536 65537; do seq 1 100000 | head -c $n > f$n; done; [ -f big ] || awk "BEGIN {for (i = 1; i <= 9500000; i++) print i}" | head -c 67108864 > big'
mkdir -p "$out/w"
(cd "$out/w" && sh -c "$gen")
files="f0 f1 f7 f8 f9 f15 f16 f17 f63 f64 f65535 f65536 f65537 big"

# the loop entered directly: native output is the committed one
ssh "$host" "cd ~/$rig && ./cksum-faults ./coreutils" > "$out/faults.native"
same "$here/cksum-faults.expected" "$out/faults.native" "cksum-faults: native differs from cksum-faults.expected"
(cd "$out" && KATYBUG_PRIM=0 ./katybug ./cksum-faults "$cu" > faults.off)
rm -f "$out/p.log"
(cd "$out" && KATYBUG_STATS=1 KATYBUG_PRIM_LOG="$out/p.log" ./katybug ./cksum-faults "$cu" > faults.on)
same "$here/cksum-faults.expected" "$out/faults.off" "cksum-faults: kernel off differs from native"
same "$here/cksum-faults.expected" "$out/faults.on" "cksum-faults: kernel on differs from native"
ran "cksum-faults" "$out/p.log"
echo "$(wc -l < "$out/faults.on") fault-case lines, $(grep -c fault "$out/faults.on") with a fault"

# the files in one command, a redirect and a pipe
ssh "$host" "cd ~/$rig && $gen && { ./coreutils --coreutils-prog=cksum $files; ./coreutils --coreutils-prog=cksum < big; cat big | ./coreutils --coreutils-prog=cksum; echo rc \$?; }" \
	> "$out/files.native"
for arm in off on; do
	rm -f "$out/p.log"
	if [ $arm = off ]; then export KATYBUG_PRIM=0; else unset KATYBUG_PRIM; fi
	(
		cd "$out/w"
		export KATYBUG_STATS=1 KATYBUG_PRIM_LOG="$out/p.log"
		{
			"$out/katybug" "$cu" --coreutils-prog=cksum $files 2> /dev/null
			"$out/katybug" "$cu" --coreutils-prog=cksum < big 2> /dev/null
			cat big | "$out/katybug" "$cu" --coreutils-prog=cksum 2> /dev/null
			echo "rc $?"
		} > ../files.$arm
	)
	[ $arm = on ] && ran "files, redirect and pipe" "$out/p.log"
done
unset KATYBUG_PRIM
same "$out/files.native" "$out/files.on" "files: kernel on differs from native"
same "$out/files.native" "$out/files.off" "files: kernel off differs from native"
echo "$(wc -l < "$out/files.on") lines"
exit $fail
