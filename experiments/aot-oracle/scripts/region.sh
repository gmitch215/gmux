#!/usr/bin/env bash
# hot functions lifted as regions, several ways, from a katybug-profile workload's own dump. fn is the top function
# alone (a call out of it leaves the region and comes back to the return site); fnc is that function and the
# callees that run 1% of all ops merged into one region; all is the 99% of the executed blocks (the earlier arms'
# form). sepN, dirN and mrgN take the function and its hottest callee (N = 2) or all its hot callees (N = 3): sep
# is a region per function with the interpreter between them, dir the same regions with direct calls between
# them (lift.ts --calls), nio the same with each callee out of line (--noinline), mrg one merged region (mrg3 is
# fnc; none for a workload with only one callee). Per arm,
# on a Linux x86-64 host: the lifted C (aot-<arm>-<workload>.c, where ladder-wasm.sh finds it), a native Katybug
# build, its output against the binary's, the counters per 1,000 guest instructions (entries are region entries),
# peak RSS, and the byte sizes. counts-extra.csv carries the rest of the counters, counts-epochs.csv the epoch guard's, exits-*.txt the pcs regions leave at.
# KB_EPOCH=1 builds the arms with the epoch guard (-DKB_EPOCH=1); an arm named <arm>+ep (fn+ep) is that arm lifted
# with --epochs, which needs it; <arm>+b (fnc+b) is that arm lifted with --bounds, <arm>+b4 with --bounds=4080 (no index window wider than the memory plan's span).
# usage: [ARMS="fn fnc all sep2 dir2 mrg2 sep3 dir3"] [KB_EPOCH=1] region.sh <bin dir with busybox-amd64, coreutils, sqlite3, bash> <out dir> <workload> [rank of the function, 0]
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
root=$(cd "$here/../../.." && pwd)
bin=$(cd "$1" && pwd)
mkdir -p "$2"
out=$(cd "$2" && pwd)
w=$3
rank=${4:-0}
node=${NODE:-node}
K=$root/src/gmux/katybug
. "$here/workloads.sh"
build() { clang -std=c11 -D_DEFAULT_SOURCE -O2 "$@" -lm; }
lift() { "$node" --no-warnings --experimental-strip-types "$here/lift.ts" "$@"; }
fns() { "$node" --no-warnings --experimental-strip-types "$here/functions.ts" "$@"; }
md() { md5sum | cut -c1-8; }
[ -e "$out/in" ] || "$bin/busybox-amd64" seq 1 400000 > "$out/in"
[ -d "$out/fine-$w" ] || bash "$here/fine-dumps.sh" "$bin" "$out" "$w" > /dev/null
fine=$(ls -S "$out/fine-$w"/*.hot | head -1)
mkdir -p "$out/hot-$w"
build -o "$out/hot" -DKB_HOT "$K"/*.c
build -o "$out/plain" -DKB_COUNT "$K"/*.c
build -o "$out/interp" "$K"/*.c
# no traces in the dump: a promoted block is never traced, so the blocks it matches are the plain ones
KATYBUG_SEGMENTS=1 KATYBUG_HOT=$out/hot-$w sh -c "$(cmd "$out/hot" "$w")" > /dev/null 2>&1
hot=$(ls -S "$out/hot-$w"/*.hot | head -1)
fn=$(fns --emit="$rank" "$fine")
fnc=$(fns --emit="$rank+callees" "$fine")
mapfile -t split3 < <(fns --emit-split="$rank" "$fine")
mapfile -t split2 < <(fns --emit-split="$rank:1" "$fine")
{
	echo "fn   $fn"
	echo "fnc  $fnc"
	printf 'split3 %s\n' "${split3[@]}"
	printf 'split2 %s\n' "${split2[@]}"
} | tee "$out/ranges-$w.txt"
arms=${ARMS:-fn fnc all sep2 dir2 mrg2 sep3 dir3}
# a workload with one hot callee has no separate three-function arms, and its pair merged is fnc
[ "${#split3[@]}" -gt 2 ] || arms=$(printf '%s\n' $arms | grep -v '3$' | grep -v '^mrg2$' | tr '\n' ' ')
lifts=(--temps --windows --regs --slots)
# the lifter's arguments for an arm, after the flags: out.c, coverage, dumps
arm_lift() {
	local arm=$1 c=$out/aot-$1-$w.c
	local specs=() r
	local lifts=("${lifts[@]}")
	# an arm named <arm>+ep is the same region lifted with --epochs, built with -DKB_EPOCH=1
	case $arm in *+ep) lifts+=(--epochs) ;; esac
	arm=${arm%+ep}
	# an arm named <arm>+b is the same region lifted with --bounds (accesses with an index bound in windows)
	case $arm in *+b) lifts+=(--bounds) ;; *+b4) lifts+=(--bounds=4080) ;; esac
	arm=${arm%+b4}
	arm=${arm%+b}
	case $arm in
		*2) for r in "${split2[@]}"; do specs+=("$hot@$r"); done ;;
		*3) for r in "${split3[@]}"; do specs+=("$hot@$r"); done ;;
	esac
	case $arm in
		fn) lift "${lifts[@]}" --ranges="$fn" "$c" 1 "$hot" ;;
		fnc) lift "${lifts[@]}" --ranges="$fnc" "$c" 1 "$hot" ;;
		all) lift "${lifts[@]}" "$c" 0.99 "$hot" ;;
		sep?) lift "${lifts[@]}" "$c" 1 "${specs[@]}" ;;
		dir?) lift "${lifts[@]}" --calls "$c" 1 "${specs[@]}" ;;
		nio?) lift "${lifts[@]}" --calls --noinline "$c" 1 "${specs[@]}" ;;
		mrg?) lift "${lifts[@]}" --ranges="$(IFS=,; echo "${split2[*]}")" "$c" 1 "$hot" ;;
	esac
}
for arm in $arms; do arm_lift "$arm" 2> "$out/lift-$arm-$w.log"; done
want=$(sh -c "$(cmd "" "$w")" | md)
echo "workload,arm,regs,output,insns,rd,wr,lifted,entries,peak_rss_kib"
[ -s "$out/counts-extra.csv" ] || echo "workload,arm,regs,insns,entries,calls,win_enter,win_acc,chk_acc,grp_acc,cont,polls,win_idx,win_slow" > "$out/counts-extra.csv"
[ -s "$out/counts-epochs.csv" ] || echo "workload,arm,regs,insns,ep_in,ep_slow,ep_back" > "$out/counts-epochs.csv"
rss() { /usr/bin/time -f %M sh -c "$1" 2>&1 > /dev/null | tail -n 1; }
echo "$w,interp,-,-,-,-,-,-,-,$(rss "$(cmd "$out/interp" "$w")")"
echo "$w,binary,-,-,-,-,-,-,-,$(rss "$(cmd "" "$w")")"
for arm in $arms; do
	build -o "$out/aot-$arm-$w" -DKB_COUNT -DKB_EPOCH="${KB_EPOCH:-0}" -DKB_AOT -I"$K" -I"$here/../src" "$K"/*.c "$out/aot-$arm-$w.c"
	build -o "$out/run-$arm-$w" -DKB_EPOCH="${KB_EPOCH:-0}" -DKB_AOT -I"$K" -I"$here/../src" "$K"/*.c "$out/aot-$arm-$w.c"
	for regs in 0 1 2; do
		got=$(KATYBUG_REGS=$regs sh -c "$(cmd "$out/aot-$arm-$w" "$w")" 2> /dev/null | md)
		[ "$got" = "$want" ] && got=exact || got="$got DIFFERS from $want"
		: > "$out/$w-$arm-$regs.count"
		KATYBUG_REGS=$regs KATYBUG_EXITS=15 KATYBUG_COUNT=$out/$w-$arm-$regs.count sh -c "$(cmd "$out/aot-$arm-$w" "$w") > /dev/null 2> $out/exits-$arm-$w-$regs.txt"
		awk -v w="$w" -v arm="$arm" -v regs="$regs" -v got="$got" -v rss="$(KATYBUG_REGS=$regs rss "$(cmd "$out/run-$arm-$w" "$w")")" -v extra="$out/counts-extra.csv" -v epochs="$out/counts-epochs.csv" '/^katybug (count|aot):/ {
				for (i = 3; i < NF; i += 2) s[$i] += $(i + 1)
			} END {
				printf "%s,%s,%s,%s,%d,%.1f,%.1f,%.1f%%,%d,%s\n", w, arm, regs, got, s["insns"], s["rd"] * 1000 / s["insns"], s["wr"] * 1000 / s["insns"], 100 * s["lifted"] / s["insns"], s["entries"], rss
				printf "%s,%s,%s,%d,%d,%d,%d,%d,%d,%d,%d,%d,%d,%d\n", w, arm, regs, s["insns"], s["entries"], s["c9rd"], s["win_enter"], s["win_acc"], s["chk_acc"], s["grp_acc"], s["cont"], s["polls"], s["win_idx"], s["win_slow"] >> extra
				printf "%s,%s,%s,%d,%d,%d,%d\n", w, arm, regs, s["insns"], s["ep_in"], s["ep_slow"], s["ep_back"] >> epochs
			}' "$out/$w-$arm-$regs.count"
	done
done
