#!/usr/bin/env bash
# one more lifted-region arm for a workload, next to region.sh's: the ranges (fn and fnc as region.sh wrote
# them, rank:N for function N with the callees that run 1% of ops, - for the dump's own cover), the cover
# (share of executed ops, with no ranges) and lift.ts's flags. rank:"0 1 2" lifts those functions together. Builds it natively, checks stdout against the
# binary's in each form it can run, and prints region.sh's columns plus regs.sh's counters per 1,000 guest
# instructions, one csv row per form. Reuses the dumps in the out dir and makes them when they are not there.
# CLANG_TIMEOUT (seconds, 600) per clang run; past it at -O2 the arm is built at -O1 (same limit) and the row says so.
# usage: region-arms.sh <bin dir with busybox-amd64, coreutils, sqlite3, bash, curl> <out dir> <workload> <arm> <ranges> <cover> <forms> [lift flags...]
# e.g. region-arms.sh bin k9/r gzip fnc0 fnc 1 0 --temps --windows
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
root=$(cd "$here/../../.." && pwd)
bin=$(cd "$1" && pwd)
mkdir -p "$2"
out=$(cd "$2" && pwd)
w=$3
arm=$4
ranges=$5
cover=$6
forms=$7
shift 7
node=${NODE:-node}
K=$root/src/gmux/katybug
. "$here/workloads.sh"
fn() { "$node" --no-warnings --experimental-strip-types "$here/functions.ts" "$@"; }
md() { md5sum | cut -c1-8; }
[ -e "$out/in" ] || "$bin/busybox-amd64" seq 1 400000 > "$out/in"
[ -d "$out/fine-$w" ] || bash "$here/fine-dumps.sh" "$bin" "$out" "$w" > /dev/null
fine=$(ls -S "$out/fine-$w"/*.hot | head -1)
if [ ! -d "$out/hot-$w" ]; then
	mkdir -p "$out/hot-$w"
	[ -x "$out/hot" ] || clang -std=c11 -D_DEFAULT_SOURCE -O2 -DKB_HOT -o "$out/hot" "$K"/*.c -lm
	KATYBUG_SEGMENTS=1 KATYBUG_HOT=$out/hot-$w sh -c "$(cmd "$out/hot" "$w")" > /dev/null 2>&1
fi
hot=$(ls -S "$out/hot-$w"/*.hot | head -1)
case $ranges in
	- ) range=() ;;
	fn) range=(--ranges="$(fn --emit=0 "$fine")") ;;
	fnc) range=(--ranges="$(fn --emit=0+callees "$fine")") ;;
	rank:*)
		list=
		for n in ${ranges#rank:}; do list+=${list:+,}$(fn --emit="$n+callees" "$fine"); done
		range=(--ranges="$list")
		;;
esac
"$node" --no-warnings --experimental-strip-types "$here/lift.ts" "$@" "${range[@]}" "$out/aot-$arm-$w.c" "$cover" "$hot" 2> "$out/lift-$arm-$w.log"
inc=(-I"$K" -I"$here/../src")
opt=-O2
compile() { # output, extra flags
	local o=$1
	shift
	if ! timeout "${CLANG_TIMEOUT:-600}" clang -std=c11 -D_DEFAULT_SOURCE $opt "$@" "${inc[@]}" -DKB_AOT "$K"/*.c "$out/aot-$arm-$w.c" -o "$o" -lm; then
		opt=-O1
		timeout "${CLANG_TIMEOUT:-600}" clang -std=c11 -D_DEFAULT_SOURCE $opt "$@" "${inc[@]}" -DKB_AOT "$K"/*.c "$out/aot-$arm-$w.c" -o "$o" -lm
	fi
}
compile "$out/aot-$arm-$w" -DKB_COUNT
[ "$opt" = -O1 ] && echo "# $arm: clang -O2 passed ${CLANG_TIMEOUT:-600} s, built at -O1" >&2
compile "$out/run-$arm-$w"
want=$(sh -c "$(cmd "" "$w")" | md)
echo "workload,arm,form,output,insns,rd,wr,lifted,c0rd,c0wr,c1rd,c1wr,c2rd,c2wr,c3rd,c3wr,c4rd,c4wr,c5rd,c5wr,slot_ld,slot_st,fix_edge,fix_alias,mem_ld,mem_st,entries,opt"
for f in $forms; do
	got=$(KATYBUG_REGS=$f sh -c "$(cmd "$out/aot-$arm-$w" "$w")" 2> /dev/null | md)
	[ "$got" = "$want" ] && got=exact || got="$got DIFFERS from $want"
	: > "$out/$w-$arm-$f.count"
	KATYBUG_REGS=$f KATYBUG_COUNT=$out/$w-$arm-$f.count sh -c "$(cmd "$out/aot-$arm-$w" "$w") > /dev/null 2>&1"
	awk -v w="$w" -v arm="$arm" -v f="$f" -v got="$got" -v opt="${opt#-}" '/^katybug count:/ {
			for (i = 3; i < NF; i += 2) s[$i] += $(i + 1)
		} END {
			k = 1000 / s["insns"]
			printf "%s,%s,%s,%s,%d,%.1f,%.1f,%.1f%%", w, arm, f, got, s["insns"], s["rd"] * k, s["wr"] * k, 100 * s["lifted"] / s["insns"]
			for (c = 0; c < 9; c++) printf ",%.1f,%.1f", s["c" c "rd"] * k, s["c" c "wr"] * k
			printf ",%d,%s\n", s["entries"], opt
		}' "$out/$w-$arm-$f.count"
done
