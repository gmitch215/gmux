#!/usr/bin/env bash
# one hot function lifted as a region, three ways, from a katybug-profile workload's own dump: fn is
# the function alone (a call out of it leaves the region and comes back to the return site), fnc is the function and
# the callees that run 1% of all ops, all is the 99% of the executed blocks (the earlier arms' form). Per
# arm, on a Linux x86-64 host: the lifted C (aot-<arm>-<workload>.c, where ladder-wasm.sh finds it), a
# native Katybug build, its output against the binary's, the counters per 1,000 guest instructions (entries
# are region entries), peak RSS, and the byte sizes.
# usage: region.sh <bin dir with busybox-amd64, coreutils, sqlite3, bash> <out dir> <workload> [rank of the function, 0]
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
fn=$("$node" --no-warnings --experimental-strip-types "$here/functions.ts" --emit="$rank" "$fine")
fnc=$("$node" --no-warnings --experimental-strip-types "$here/functions.ts" --emit="$rank+callees" "$fine")
echo "fn   $fn" | tee "$out/ranges-$w.txt"
echo "fnc  $fnc" | tee -a "$out/ranges-$w.txt"
lifts=(--temps --windows --regs --slots)
lift "${lifts[@]}" --ranges="$fn" "$out/aot-fn-$w.c" 1 "$hot" 2> "$out/lift-fn-$w.log"
lift "${lifts[@]}" --ranges="$fnc" "$out/aot-fnc-$w.c" 1 "$hot" 2> "$out/lift-fnc-$w.log"
lift "${lifts[@]}" "$out/aot-all-$w.c" 0.99 "$hot" 2> "$out/lift-all-$w.log"
want=$(sh -c "$(cmd "" "$w")" | md)
echo "workload,arm,regs,output,insns,rd,wr,lifted,entries,peak_rss_kib"
rss() { /usr/bin/time -f %M sh -c "$1" 2>&1 > /dev/null | tail -n 1; }
echo "$w,interp,-,-,-,-,-,-,-,$(rss "$(cmd "$out/interp" "$w")")"
echo "$w,binary,-,-,-,-,-,-,-,$(rss "$(cmd "" "$w")")"
for arm in fn fnc all; do
	build -o "$out/aot-$arm-$w" -DKB_COUNT -DKB_AOT -I"$K" -I"$here/../src" "$K"/*.c "$out/aot-$arm-$w.c"
	build -o "$out/run-$arm-$w" -DKB_AOT -I"$K" -I"$here/../src" "$K"/*.c "$out/aot-$arm-$w.c"
	for regs in 0 1 2; do
		got=$(KATYBUG_REGS=$regs sh -c "$(cmd "$out/aot-$arm-$w" "$w")" 2> /dev/null | md)
		[ "$got" = "$want" ] && got=exact || got="$got DIFFERS from $want"
		: > "$out/$w-$arm-$regs.count"
		KATYBUG_REGS=$regs KATYBUG_COUNT=$out/$w-$arm-$regs.count sh -c "$(cmd "$out/aot-$arm-$w" "$w") > /dev/null 2>&1"
		awk -v w="$w" -v arm="$arm" -v regs="$regs" -v got="$got" -v rss="$(KATYBUG_REGS=$regs rss "$(cmd "$out/run-$arm-$w" "$w")")" '/^katybug count:/ {
				for (i = 3; i < NF; i += 2) s[$i] += $(i + 1)
			} END {
				printf "%s,%s,%s,%s,%d,%.1f,%.1f,%.1f%%,%d,%s\n", w, arm, regs, got, s["insns"], s["rd"] * 1000 / s["insns"], s["wr"] * 1000 / s["insns"], 100 * s["lifted"] / s["insns"], s["entries"], rss
			}' "$out/$w-$arm-$regs.count"
	done
done
