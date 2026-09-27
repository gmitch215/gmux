#!/usr/bin/env bash
# where pending signals are polled: every block, back-edges, back-edges and syscalls, every 64 blocks
# (-DKB_POLL), for the interpreter and 99% lifted code. Seconds per run of sha256, factor and sqlite;
# poll latency (host signal to the poll that sees it, -DKB_COUNT) under a SIGUSR1 about every
# millisecond into a bash loop with a trap. Linux x86-64 host, clang, node.
# usage: poll.sh <bin dir with busybox-amd64, coreutils, sqlite3, bash> <out dir> [runs]
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
root=$(cd "$here/../../.." && pwd)
bin=$(cd "$1" && pwd)
mkdir -p "$2"
out=$(cd "$2" && pwd)
runs=${3:-5}
K=$root/src/gmux/katybug
build() { clang -std=c11 -D_DEFAULT_SOURCE -O2 "$@" -lm; }
"$bin/busybox-amd64" seq 1 400000 > "$out/in"
loop='trap "n=\$((n+1))" USR1; echo ready >&2; i=0; while [ $i -lt 20000 ]; do i=$((i+1)); done; echo $n'
cmd() {
	local p=$1
	case $2 in
		sha256) echo "$p $bin/coreutils --coreutils-prog=sha256sum $out/in" ;;
		factor) echo "$p $bin/busybox-amd64 seq 1000000000000 1000000020000 | $p $bin/coreutils --coreutils-prog=factor" ;;
		sqlite) echo "$p $bin/sqlite3 :memory: 'with recursive c(x) as (select 1 union all select x+1 from c where x<100000) select count(*), sum(x*x) % 1000003 from c;'" ;;
		bash) echo "$p $bin/bash -c '$loop'" ;;
	esac
}
build -o "$out/hot" -DKB_HOT "$K"/*.c
dumps=()
for w in sha256 factor sqlite bash; do
	mkdir -p "$out/hot-$w"
	KATYBUG_HOT=$out/hot-$w sh -c "$(cmd "$out/hot" "$w")" > /dev/null 2>&1
	for d in "$out/hot-$w"/*.hot; do dumps+=("$d"); done
done
node --no-warnings --experimental-strip-types "$here/lift.ts" "$out/aot.c" 0.99 "${dumps[@]}" 2> /dev/null
aot=(-DKB_AOT -I"$K" -I"$here/../src" "$out/aot.c")
policies=(every:0 backedge:1 syscall:2 fuel:3)
for p in "${policies[@]}"; do
	name=${p%%:*}
	flag=-DKB_POLL=${p#*:}
	build -o "$out/interp-$name" "$flag" "$K"/*.c
	build -o "$out/aot-$name" "$flag" "${aot[@]}" "$K"/*.c
	build -o "$out/interp-$name-count" "$flag" -DKB_COUNT "$K"/*.c
	build -o "$out/aot-$name-count" "$flag" -DKB_COUNT "${aot[@]}" "$K"/*.c
done
TIMEFORMAT=%3R
echo "| workload | tier | policy | seconds per run | output |"
echo "| --- | --- | --- | --- | --- |"
for w in sha256 factor sqlite; do
	want=$(sh -c "$(cmd "" "$w")" | md5sum | cut -c1-8)
	for tier in interp aot; do
		for p in "${policies[@]}"; do
			name=${p%%:*}
			c=$(cmd "$out/$tier-$name" "$w")
			got=$(sh -c "$c" 2> /dev/null | md5sum | cut -c1-8)
			[ "$got" = "$want" ] && got=exact || got="$got DIFFERS"
			times=$(for _ in $(seq "$runs"); do { time sh -c "$c > /dev/null"; } 2>&1; done | sort -n | tr '\n' ' ')
			echo "| $w | $tier | $name | $times | $got |"
		done
	done
done
echo
echo "| tier | policy | signals seen | mean latency us | max latency us | trap count | seconds |"
echo "| --- | --- | --- | --- | --- | --- | --- |"
for tier in interp aot; do
	for p in "${policies[@]}"; do
		name=${p%%:*}
		f=$out/lat-$tier-$name
		: > "$f.count"
		: > "$f.err"
		start=$(date +%s.%N)
		KATYBUG_COUNT=$f.count sh -c "$(cmd "$out/$tier-$name-count" bash)" > "$f.out" 2> "$f.err" &
		pid=$!
		until grep -q ready "$f.err" 2> /dev/null || ! kill -0 "$pid" 2> /dev/null; do sleep 0.01; done
		kb=$(pgrep -P "$pid" || echo "$pid")
		while kill -USR1 "$kb" 2> /dev/null; do sleep 0.001; done
		wait "$pid" || true
		end=$(date +%s.%N)
		awk -v tier="$tier" -v name="$name" -v traps="$(cat "$f.out")" -v s="$start" -v e="$end" '/^katybug count:/ {
				for (i = 3; i < NF; i += 2) c[$i] += $(i + 1)
			} END {
				printf "| %s | %s | %d | %.1f | %.1f | %s | %.2f |\n", tier, name, c["signals"],
					c["signals"] ? c["latsum"] / c["signals"] / 1000 : 0, c["latmax"] / 1000, traps, e - s
			}' "$f.count"
	done
done
