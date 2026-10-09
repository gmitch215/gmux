#!/usr/bin/env bash
# a lifted region must never run code other than the code it was lifted from. Two x86-64 guests of tests/c/katybug
# change code under blocks a region holds, then run with the region lifted from the unchanged dump: epochs.c (all
# executed blocks lifted; code is flipped, churned, remapped and patched after a syscall) and x86-region-smc.c (only
# region_fn lifted; the immediate of a block that no call enters but the one before it is rewritten between calls, so
# the region reaches it by a direct edge). Output and exit status must equal the interpreter's in KATYBUG_REGS 0, 1 and
# 2, and the region must have been entered (a guest that never enters it checks nothing). KATYBUG_DIR runs the check
# against another copy of Katybug's sources (a copy with a guard removed must fail it).
# usage: [LLVM=<bin>] [KATYBUG_DIR=<sources>] regions-guards.sh <out dir>
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
root=$(cd "$here/../../.." && pwd)
mkdir -p "$1"
out=$(cd "$1" && pwd)
llvm=${LLVM:-/opt/homebrew/opt/llvm/bin}
node=${NODE:-node}
K=${KATYBUG_DIR:-$root/src/gmux/katybug}
T=$root/tests/c/katybug
cc="cc -std=c11 -D_DEFAULT_SOURCE -D_DARWIN_C_SOURCE -O1"
flags=(--target=x86_64-linux-gnu -nostdlib -static -fuse-ld=lld -O2 -ffreestanding -fno-stack-protector -fno-builtin -Wl,-N -mno-sse -mno-mmx)
epochs=$'map-remap ok\nmap-churn ok\nmap-protect ok\nmap-unmap ok\nsig-install ok\nsig-unmask ok\nsig-churn ok\nsig-async ok\ncode-flip ok\ncode-churn ok\ncode-remap ok\ncode-smc ok\nfd-dup ok\nfd-churn ok'
$cc -o "$out/hot" -DKB_HOT "$K"/*.c -lm
$cc -o "$out/plain" "$K"/*.c -lm
failed=0
echo "guest,regs,result,entries,lifted"
# guest name, source, expected output, region function ('' lifts every executed block)
check() {
	local g=$1 src=$2 want=$3 fn=${4:-} ranges=() got rc=0 big regs
	"$llvm/clang" "${flags[@]}" -o "$out/$g" "$T/$src"
	got=$("$out/plain" "$out/$g" 2> /dev/null) || rc=$?
	if [ "$got" != "$want" ] || [ "$rc" != 0 ]; then
		echo "$g,-,FAIL the interpreter's own output (exit $rc)"
		failed=1
		return
	fi
	mkdir -p "$out/hot-$g"
	KATYBUG_SEGMENTS=1 KATYBUG_HOT="$out/hot-$g" "$out/hot" "$out/$g" > /dev/null 2>&1 || true
	big=$(ls -S "$out/hot-$g"/*.hot | head -1)
	if [ -n "$fn" ]; then
		read -r addr size < <("$llvm/llvm-nm" -S -n --defined-only "$out/$g" | awk -v f="$fn" '$4 == f { print $1, $2 }')
		ranges=(--ranges="0x$addr-$(printf '0x%x' $((0x$addr + 0x$size)))")
	fi
	"$node" --no-warnings --experimental-strip-types "$here/lift.ts" --temps --windows --regs --slots ${LIFT_FLAGS:-} ${ranges[@]+"${ranges[@]}"} "$out/aot-$g.c" 1 "$big" 2> "$out/aot-$g.log"
	$cc -DKB_AOT -DKB_COUNT -I"$K" -I"$here/../src" -o "$out/aot-$g" "$K"/*.c "$out/aot-$g.c" -lm
	for regs in 0 1 2; do
		rc=0
		: > "$out/$g-$regs.count"
		got=$(KATYBUG_REGS=$regs KATYBUG_COUNT="$out/$g-$regs.count" "$out/aot-$g" "$out/$g" 2> /dev/null) || rc=$?
		local entries lifted
		entries=$(awk '/^katybug count:/ { for (i = 3; i < NF; i += 2) if ($i == "entries") n += $(i + 1) } END { print n + 0 }' "$out/$g-$regs.count")
		lifted=$(awk '/^katybug count:/ { for (i = 3; i < NF; i += 2) { if ($i == "lifted") l += $(i + 1); if ($i == "insns") n += $(i + 1) } } END { printf "%.1f%%", n ? 100 * l / n : 0 }' "$out/$g-$regs.count")
		if [ "$got" = "$want" ] && [ "$rc" = 0 ] && [ "$entries" -gt 0 ]; then
			echo "$g,$regs,PASS,$entries,$lifted"
		else
			echo "$g,$regs,FAIL (exit $rc; output $([ "$got" = "$want" ] && echo equal || echo differs)),$entries,$lifted"
			failed=1
		fi
	done
}
check region-smc x86-region-smc.c "region-smc ok" region_fn
check epochs epochs.c "$epochs"
exit $failed
