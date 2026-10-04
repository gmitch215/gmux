#!/usr/bin/env bash
# the sha256 block kernel: the static x86-64 coreutils 9.5 that userland-build.sh makes (build/katybug/
# transcript/ubin/coreutils by default) hashes files of 0, 1, 55, 56, 63, 64 and 65 bytes and one of 64 MiB,
# and checks them with -c, natively and under katybug with the kernels off and on; every output must be
# the same. sha256-faults.c calls the function from a program that copies its code out of the same file;
# its output is sha256-faults.expected (native Linux's). The kernel must have run in both.
# usage: tests/c/katybug/sha256.sh [coreutils]; NATIVE_HOST required: an ssh host that runs x86-64 natively
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
	-fno-builtin -mno-sse -mno-mmx -mno-red-zone -o "$out/sha256-faults" "$here/sha256-faults.c"
fail=0
ran() {
	# ran <label> <log>: the kernel's calls in a katybug stats log
	local n
	n=$(grep -o 'sha256 [0-9]*' "$2" | tail -1 | cut -d' ' -f2)
	echo "# $1: sha256 kernel $n calls"
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

# the function called directly: native output is the committed one
cat "$cu" | ssh "$host" "mkdir -p ~/$rig && cat > ~/$rig/coreutils && chmod +x ~/$rig/coreutils"
cat "$out/sha256-faults" | ssh "$host" "cat > ~/$rig/sha256-faults && chmod +x ~/$rig/sha256-faults"
ssh "$host" "cd ~/$rig && ./sha256-faults ./coreutils" > "$out/faults.native"
same "$here/sha256-faults.expected" "$out/faults.native" "sha256-faults: native differs from sha256-faults.expected"
(cd "$out" && KATYBUG_PRIM=0 ./katybug ./sha256-faults "$cu" > faults.off)
rm -f "$out/p.log"
(cd "$out" && KATYBUG_STATS=1 KATYBUG_PRIM_LOG="$out/p.log" ./katybug ./sha256-faults "$cu" > faults.on)
same "$here/sha256-faults.expected" "$out/faults.off" "sha256-faults: kernel off differs from native"
same "$here/sha256-faults.expected" "$out/faults.on" "sha256-faults: kernel on differs from native"
ran sha256-faults "$out/p.log"
echo "$(wc -l < "$out/faults.on") fault-case lines, $(grep -c fault "$out/faults.on") with a fault"

# the files: 0, 1, 55, 56, 63, 64, 65 bytes and 64 MiB, the same bytes on both machines
gen=': > f0; for n in 1 55 56 63 64 65; do seq 1 100 | head -c $n > f$n; done; [ -f big ] || awk "BEGIN {for (i = 1; i <= 9500000; i++) print i}" | head -c 67108864 > big'
mkdir -p "$out/w"
(cd "$out/w" && sh -c "$gen")
ssh "$host" "cd ~/$rig && $gen && ./coreutils --coreutils-prog=sha256sum f0 f1 f55 f56 f63 f64 f65 big > sums && ./coreutils --coreutils-prog=sha256sum -c sums; echo rc \$?" \
	> "$out/files.native"
ssh "$host" "cat ~/$rig/sums" > "$out/w/sums"
files="f0 f1 f55 f56 f63 f64 f65 big"
for arm in off on; do
	rm -f "$out/p.log"
	if [ $arm = off ]; then export KATYBUG_PRIM=0; else unset KATYBUG_PRIM; fi
	(
		cd "$out/w"
		export KATYBUG_STATS=1 KATYBUG_PRIM_LOG="$out/p.log"
		"$out/katybug" "$cu" --coreutils-prog=sha256sum $files > ../sums.$arm 2> /dev/null
		rc=0
		"$out/katybug" "$cu" --coreutils-prog=sha256sum -c sums > ../check.$arm 2> /dev/null || rc=$?
		echo "rc $rc" >> ../check.$arm
	)
	[ $arm = on ] && ran "sha256sum and -c, 64 MiB" "$out/p.log"
done
unset KATYBUG_PRIM
ssh "$host" "cat ~/$rig/sums" > "$out/sums.native"
{
	cat "$out/sums.on" && cat "$out/check.on"
} > "$out/files.on"
{
	cat "$out/sums.off" && cat "$out/check.off"
} > "$out/files.off"
{
	cat "$out/sums.native" && cat "$out/files.native"
} > "$out/files.nat"
same "$out/files.nat" "$out/files.on" "files: kernel on differs from native"
same "$out/files.nat" "$out/files.off" "files: kernel off differs from native"
echo "$(wc -l < "$out/files.on") lines"
exit $fail
