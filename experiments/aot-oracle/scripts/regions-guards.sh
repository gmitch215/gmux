#!/usr/bin/env bash
# a lifted region must never run code other than the code it was lifted from, and its windows must resolve with the
# rights its accesses need. x86-64 guests of tests/c/katybug, each lifted from its own dump, run in KATYBUG_REGS 0, 1
# and 2: output and exit status must equal the interpreter's and native Linux's.
#   epochs.c: every executed block lifted; mapped code is flipped, churned and remapped through read-write and
#     read-execute, and a loop that patches itself runs from a page that is writable and executable (never attached)
#   x86-region-smc.c: only region_fn lifted, on a page that is writable and executable, so no region attaches and the
#     rewritten immediate runs as the interpreter runs it
#   rights.c (without smc-self, which needs writable text) and x86-loops.c: stores to a page that lost write, fetches
#     and system calls on pages without the right, windows that cross a piece boundary
# A guest that lifts blocks on pages that are not writable and executable must enter its regions (entries > 0), one that
# lifts only such blocks must not. KATYBUG_DIR runs the check against another copy of Katybug's sources (a copy that
# attaches regions on writable and executable pages must fail region-smc and epochs); LIFT_MUTATE=storeread resolves
# store windows for reading (rights and loops must fail). EXPECT_FAIL=1 turns the exit status around for a mutant: 0
# when at least one row failed.
# LIFT_FLAGS adds lift.ts flags and CC_EXTRA the host flags of the lifted build (--epochs needs -DKB_EPOCH=1).
#   x86-pcs.c: one load between two-byte nops, either side of it in turn at the same address: equal IR and end, other instruction
#     boundaries, so the pc a fault reports is the guard's to tell apart
#   x86-flat.c: checked accesses (an index read from memory) on a buffer that is cut up, protected, remapped, grown and
#     forked under the loop, and read at addresses that share its low 32 bits
# FLAT=1 (with LIFT_FLAGS="--epochs ..." and CC_EXTRA="-DKB_EPOCH=1 -DKB_FLAT=1048576") lifts each guest twice: with --classes, to count
# its checked sites in each of the three regs forms (x86-flat.c runs `warm` for that, its loops on an unchanged buffer), then
# with --flat=<those counts>; x86-flat.c must take the table's fast path at least 1000 times. LIFT_MUTATE=flatrights, flatlow32 or
# noflatsync must fail x86-flat.c under it (GUEST=flat runs that guest alone)
# usage: [LLVM=<bin>] [KATYBUG_DIR=<sources>] [EXPECT_FAIL=1] [FLAT=1] [LIFT_FLAGS=..] [CC_EXTRA=..] regions-guards.sh <out dir>
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
flags=(--target=x86_64-linux-gnu -nostdlib -static -fuse-ld=lld -O2 -ffreestanding -fno-stack-protector -fno-builtin)
epochs=$'map-remap ok\nmap-churn ok\nmap-protect ok\nmap-unmap ok\nsig-install ok\nsig-unmask ok\nsig-churn ok\nsig-async ok\ncode-flip ok\ncode-churn ok\ncode-remap ok\ncode-smc ok\nfd-dup ok\nfd-churn ok'
$cc -o "$out/hot" -DKB_HOT "$K"/*.c -lm
$cc -o "$out/plain" "$K"/*.c -lm
failed=0
echo "guest,regs,result,entries,lifted,flat hits"
# guest name, source, expected output, region function ('' lifts every executed block), compiler flags, 1 when regions
# must be entered, 0 when none may be
check() {
	local g=$1 src=$2 want=$3 fn=$4 cflags=$5 entered=$6 warm=${7:-} flatmin=${8:-0} ranges=() got rc=0 big regs flat=()
	[ -z "${GUEST:-}" ] || [ "$GUEST" = "$g" ] || return 0
	"$llvm/clang" "${flags[@]}" $cflags -o "$out/$g" "$T/$src"
	got=$("$out/plain" "$out/$g" 2> /dev/null) || rc=$?
	if [ "$got" != "$want" ] || [ "$rc" != 0 ]; then
		echo "$g,-,FAIL the interpreter's own output (exit $rc)"
		failed=1
		return
	fi
	mkdir -p "$out/hot-$g"
	KATYBUG_SEGMENTS=1 KATYBUG_HOT="$out/hot-$g" "$out/hot" "$out/$g" > /dev/null 2>&1 || true
	big=$(find "$out/hot-$g" -name '*.hot' -newer "$out/$g" -exec ls -S {} + | head -1)
	if [ -n "$fn" ]; then
		read -r addr size < <("$llvm/llvm-nm" -S -n --defined-only "$out/$g" | awk -v f="$fn" '$4 == f { print $1, $2 }')
		ranges=(--ranges="0x$addr-$(printf '0x%x' $((0x$addr + 0x$size)))")
	fi
	if [ -n "${FLAT:-}" ]; then
		"$node" --no-warnings --experimental-strip-types "$here/lift.ts" --temps --windows --regs --slots ${LIFT_FLAGS:-} --classes ${ranges[@]+"${ranges[@]}"} "$out/aotc-$g.c" 1 "$big" 2> "$out/aotc-$g.log"
		$cc ${CC_EXTRA:-} -DKB_AOT -DKB_COUNT -DAOT_CLASS -I"$K" -I"$here/../src" -o "$out/aotc-$g" "$K"/*.c "$out/aotc-$g.c" -lm
		: > "$out/$g.census"
		for regs in 0 1 2; do
			KATYBUG_REGS=$regs KATYBUG_COUNT="$out/$g.census" "$out/aotc-$g" "$out/$g" $warm > /dev/null 2>&1 || true
		done
		flat=(--flat="$out/$g.census")
	fi
	"$node" --no-warnings --experimental-strip-types "$here/lift.ts" --temps --windows --regs --slots ${LIFT_FLAGS:-} ${flat[@]+"${flat[@]}"} ${ranges[@]+"${ranges[@]}"} "$out/aot-$g.c" 1 "$big" 2> "$out/aot-$g.log"
	$cc ${CC_EXTRA:-} -DKB_AOT -DKB_COUNT -I"$K" -I"$here/../src" -o "$out/aot-$g" "$K"/*.c "$out/aot-$g.c" -lm
	for regs in 0 1 2; do
		rc=0
		: > "$out/$g-$regs.count"
		got=$(KATYBUG_REGS=$regs KATYBUG_COUNT="$out/$g-$regs.count" "$out/aot-$g" "$out/$g" 2> /dev/null) || rc=$?
		local entries lifted hits ok=0
		hits=$(awk '/^katybug flat:/ { n += $4 } END { print n + 0 }' "$out/$g-$regs.count")
		entries=$(awk '/^katybug count:/ { for (i = 3; i < NF; i += 2) if ($i == "entries") n += $(i + 1) } END { print n + 0 }' "$out/$g-$regs.count")
		lifted=$(awk '/^katybug count:/ { for (i = 3; i < NF; i += 2) { if ($i == "lifted") l += $(i + 1); if ($i == "insns") n += $(i + 1) } } END { printf "%.1f%%", n ? 100 * l / n : 0 }' "$out/$g-$regs.count")
		[ "$entered" = 1 ] && [ "$entries" -gt 0 ] && ok=1
		[ "$entered" = 0 ] && [ "$entries" -eq 0 ] && ok=1
		[ -n "${FLAT:-}" ] && [ "$hits" -lt "$flatmin" ] && ok=0
		if [ "$got" = "$want" ] && [ "$rc" = 0 ] && [ "$ok" = 1 ]; then
			echo "$g,$regs,PASS,$entries,$lifted,$hits"
		else
			echo "$g,$regs,FAIL (exit $rc; output $([ "$got" = "$want" ] && echo equal || echo differs); entries $([ "$ok" = 1 ] && echo as wanted || echo not as wanted)),$entries,$lifted,$hits"
			failed=1
		fi
	done
}
check region-smc x86-region-smc.c "region-smc ok" region_fn "-Wl,-N -mno-sse -mno-mmx" 0
check epochs epochs.c "$epochs" "" "-mno-sse -mno-mmx" 1
check rights rights.c "$(grep -v '^smc-self ' "$T/rights-x86.expected")" "" "-mno-sse -mno-mmx -DNO_SELF" 1
check loops x86-loops.c "$(cat "$T/x86-loops.expected")" "" "-mno-sse -mno-mmx -mno-red-zone" 1
check flat x86-flat.c "$(cat "$T/x86-flat.expected")" "" "-mno-sse -mno-mmx -mno-red-zone" 1 warm 1000
check pcs x86-pcs.c "pcs 2 0 2 0" "" "-mno-sse -mno-mmx -mno-red-zone" 1
if [ -n "${EXPECT_FAIL:-}" ]; then
	[ "$failed" = 1 ]
	exit
fi
exit $failed
