#!/usr/bin/env bash
# the representation ladder on a Linux x86-64 host, natively: each rung's lifted regions for sha256, factor
# and sqlite built into Katybug (regions from a scale-1 run), outputs compared with the binaries' at the
# timing scale, seconds per run interleaved across the arms on one pinned core, with the load average at
# each round and the code bytes of the regions.
# usage: ladder.sh <bin dir with busybox-amd64, coreutils, sqlite3> <out dir> [rounds] [cpu] [scale]
# arms (see lift.ts and aot.h): A blocks, every transition polls; B + only architectural registers across
# blocks; C + lifted traces (the plan's groups span a trace); D + polls at back edges; E + windows for
# provable accesses. B0 and C0 are B and C with the plan's groups ignored (what a group is worth). The
# interpreter alone (plain) is timed in the first three rounds only.
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
root=$(cd "$here/../../.." && pwd)
bin=$(cd "$1" && pwd)
mkdir -p "$2"
out=$(cd "$2" && pwd)
rounds=${3:-9}
cpu=${4:-5}
scale=${5:-1}
node=${NODE:-node}
K=$root/src/gmux/katybug
build() { clang -std=c11 -D_DEFAULT_SOURCE -O2 "$@" -lm; }
lift() { "$node" --no-warnings --experimental-strip-types "$here/lift.ts" "$@" 2> /dev/null; }
"$bin/busybox-amd64" seq 1 400000 > "$out/in-1"
"$bin/busybox-amd64" seq 1 $((400000 * scale)) > "$out/in-$scale"
cmd() { # program, workload, scale
	local p=$1 s=$3
	case $2 in
		sha256) echo "$p $bin/coreutils --coreutils-prog=sha256sum $out/in-$s" ;;
		factor) echo "$p $bin/busybox-amd64 seq 1000000000000 $((1000000020000 + 20000 * (s - 1))) | $p $bin/coreutils --coreutils-prog=factor" ;;
		sqlite) echo "$p $bin/sqlite3 :memory: 'with recursive c(x) as (select 1 union all select x+1 from c where x<$((100000 * s))) select count(*), sum(x*x) % 1000003 from c;'" ;;
	esac
}
md() { md5sum | cut -c1-8; }

build -o "$out/hot-blocks" -DKB_HOT -DKB_TRACE=1 "$K"/*.c
build -o "$out/hot-traces" -DKB_HOT "$K"/*.c
build -o "$out/plain" "$K"/*.c
# arm: dump kind, lifter flags, build flags
arms=(
	"A blocks -- -DKB_TRACE=1 -DAOT_POLL=0"
	"B blocks --temps -DKB_TRACE=1 -DAOT_POLL=0"
	"B0 blocks --temps,--nogroups -DKB_TRACE=1 -DAOT_POLL=0"
	"C traces --temps -DAOT_POLL=0"
	"C0 traces --temps,--nogroups -DAOT_POLL=0"
	"D traces --temps"
	"E traces --temps,--windows"
)
for w in sha256 factor sqlite; do
	for kind in blocks traces; do
		d=$out/dump-$kind-$w
		mkdir -p "$d"
		KATYBUG_HOT=$d sh -c "$(cmd "$out/hot-$kind" "$w" 1)" > /dev/null 2>&1
	done
	for spec in "${arms[@]}"; do
		read -r name kind lflags bflags <<< "$spec"
		[ "$lflags" = -- ] && lflags=
		lift ${lflags//,/ } "$out/aot-$name-$w.c" 0.99 "$out/dump-$kind-$w"/*.hot
		build -o "$out/$name-$w" -DKB_AOT -I"$K" -I"$here/../src" $bflags "$K"/*.c "$out/aot-$name-$w.c"
	done
done

echo "| workload | arm | output at scale $scale | text bytes of the regions | IR and table bytes |"
echo "| --- | --- | --- | --- | --- |"
for w in sha256 factor sqlite; do
	want=$(sh -c "$(cmd "" "$w" "$scale")" | md)
	for spec in "${arms[@]}"; do
		read -r name _ <<< "$spec"
		got=$(sh -c "$(cmd "$out/$name-$w" "$w" "$scale")" 2> /dev/null | md || true)
		[ "$got" = "$want" ] && got=exact || got="$got DIFFERS from $want"
		text=$(nm -S "$out/$name-$w" | awk '$4 ~ /^r[0-9]+_run$/ { s += strtonum("0x" $2) } END { print s + 0 }')
		meta=$(nm -S "$out/$name-$w" | awk '$4 ~ /^(r[0-9]+_i[0-9]+|aot_table)$/ { s += strtonum("0x" $2) } END { print s + 0 }')
		echo "| $w | $name | $got | $text | $meta |"
	done
done
echo
echo "| workload | arm | seconds per run, one per round | median | spread |"
echo "| --- | --- | --- | --- | --- |"
declare -A times
names=(native plain)
for spec in "${arms[@]}"; do
	read -r name _ <<< "$spec"
	names+=("$name")
done
for w in sha256 factor sqlite; do
	for round in $(seq "$rounds"); do
		for n in "${names[@]}"; do
			[ "$n" = plain ] && [ "$round" -gt 3 ] && continue
			p=
			case $n in native) ;; plain) p=$out/plain ;; *) p=$out/$n-$w ;; esac
			c=$(cmd "$p" "$w" "$scale")
			a=$EPOCHREALTIME
			taskset -c "$cpu" sh -c "$c > /dev/null 2>&1" || true
			b=$EPOCHREALTIME
			times[$w,$n]+="$(awk -v a="$a" -v b="$b" 'BEGIN { printf "%.4f", b - a }') "
		done
		echo "$w round $round load $(cut -d' ' -f1 /proc/loadavg)" >&2
	done
	for n in "${names[@]}"; do
		echo "$w $n ${times[$w,$n]}" | awk '{ n = NF - 2; for (i = 3; i <= NF; i++) v[i - 2] = $i; asort(v); printf "| %s | %s | %s | %.4f | %.1f%% |\n", $1, $2, substr($0, length($1 $2) + 3), v[int((n + 1) / 2)], 100 * (v[n] - v[1]) / v[int((n + 1) / 2)] }'
	done
done
