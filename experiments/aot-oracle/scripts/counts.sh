#!/usr/bin/env bash
# guest-state traffic and mapping checks per 1,000 guest instructions, interpreted and lifted: a
# -DKB_HOT build dumps each workload's blocks, lift.ts lifts 99% of them, and -DKB_COUNT builds of
# the interpreter (memory plan off and on) and the lifted code append a report at exit (KATYBUG_COUNT).
# usage: counts.sh <bin dir with busybox-amd64, coreutils, sqlite3> <out dir>
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
root=$(cd "$here/../../.." && pwd)
bin=$(cd "$1" && pwd)
mkdir -p "$2"
out=$(cd "$2" && pwd)
K=$root/src/gmux/katybug
build() { clang -std=c11 -D_DEFAULT_SOURCE -O2 "$@" -lm; }
build -o "$out/hot" -DKB_HOT "$K"/*.c
"$bin/busybox-amd64" seq 1 400000 > "$out/in"
cmd() {
	local p=$1
	case $2 in
		sha256) echo "$p $bin/coreutils --coreutils-prog=sha256sum $out/in" ;;
		factor) echo "$p $bin/busybox-amd64 seq 1000000000000 1000000020000 | $p $bin/coreutils --coreutils-prog=factor" ;;
		sqlite) echo "$p $bin/sqlite3 :memory: 'with recursive c(x) as (select 1 union all select x+1 from c where x<100000) select count(*), sum(x*x) % 1000003 from c;'" ;;
	esac
}
dumps=()
for w in sha256 factor sqlite; do
	mkdir -p "$out/hot-$w"
	KATYBUG_HOT=$out/hot-$w sh -c "$(cmd "$out/hot" "$w")" > /dev/null
	for d in "$out/hot-$w"/*.hot; do dumps+=("$d"); done
done
node --no-warnings --experimental-strip-types "$here/lift.ts" "$out/aot.c" 0.99 "${dumps[@]}"
build -o "$out/plain" -DKB_COUNT "$K"/*.c
build -o "$out/aot" -DKB_COUNT -DKB_AOT -I"$K" -I"$here/../src" "$K"/*.c "$out/aot.c"
build -o "$out/aot-uncounted" -DKB_AOT -I"$K" -I"$here/../src" "$K"/*.c "$out/aot.c"
echo "| workload | arm | output | per 1,000 guest instructions: cpu reads | writes | mapping checks | refills | checks per block | checks per mapping, in a block | lifted share | checks per region entry | mappings per region |"
echo "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |"
for w in sha256 factor sqlite; do
	want=$(sh -c "$(cmd "" "$w")" | md5sum | cut -c1-8)
	for arm in noplan plain aot aot-uncounted; do
		bin_arm=$arm plan=1
		[ "$arm" = noplan ] && bin_arm=plain plan=0
		got=$(KATYBUG_PLAN=$plan sh -c "$(cmd "$out/$bin_arm" "$w")" 2> /dev/null | md5sum | cut -c1-8)
		[ "$got" = "$want" ] && got="$got exact" || got="$got DIFFERS"
		[ "$arm" = aot-uncounted ] && { echo "| $w | $arm | $got | | | | | | | | | |"; continue; }
		: > "$out/$w-$arm.count"
		KATYBUG_PLAN=$plan KATYBUG_COUNT=$out/$w-$arm.count sh -c "$(cmd "$out/$bin_arm" "$w") > /dev/null"
		awk -v w="$w" -v arm="$arm" -v got="$got" '/^katybug count:/ {
				for (i = 3; i < NF; i += 2) s[$i] += $(i + 1)
			} END {
				k = 1000 / s["insns"]
				printf "| %s | %s | %s | %.0f | %.0f | %.0f | %.2f | %.2f | %.2f | %.1f%% | %.0f | %.1f |\n", w, arm, got,
					s["rd"] * k, s["wr"] * k, s["checks"] * k, s["refills"] * k, s["checks"] / s["blocks"],
					s["checks"] / s["blockmaps"], 100 * s["lifted"] / s["insns"],
					s["entries"] ? s["lchecks"] / s["entries"] : 0, s["regions"] ? s["regionmaps"] / s["regions"] : 0
			}' "$out/$w-$arm.count"
	done
done
