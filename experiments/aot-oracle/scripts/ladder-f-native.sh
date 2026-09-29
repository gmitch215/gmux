#!/usr/bin/env bash
# the ladder's native algorithm at x86-64: the shipped binaries against the same sources built by the
# host's clang (ladder-f.sh's native-*), interleaved on one pinned core; seconds per run and their ratio.
# usage: ladder-f-native.sh <bin dir with busybox-amd64, coreutils, sqlite3> <ladder-f out dir> <ladder out dir with in-<scale>> [rounds] [cpu] [scale]
set -euo pipefail
bin=$(cd "$1" && pwd)
f=$(cd "$2" && pwd)
out=$(cd "$3" && pwd)
rounds=${4:-9}
cpu=${5:-5}
scale=${6:-10}
cmd() { # arm (shipped or clang), workload
	case $2 in
		sha256) if [ "$1" = shipped ]; then echo "$bin/coreutils --coreutils-prog=sha256sum $out/in-$scale"; else echo "$f/native-sha256 $out/in-$scale"; fi ;;
		factor) if [ "$1" = shipped ]; then echo "$bin/busybox-amd64 seq 1000000000000 $((1000000020000 + 20000 * (scale - 1))) | $bin/coreutils --coreutils-prog=factor"; else echo "$bin/busybox-amd64 seq 1000000000000 $((1000000020000 + 20000 * (scale - 1))) | $f/native-factor"; fi ;;
		sqlite) if [ "$1" = shipped ]; then p=$bin/sqlite3; else p=$f/native-sqlite; fi; echo "$p :memory: 'with recursive c(x) as (select 1 union all select x+1 from c where x<$((100000 * scale))) select count(*), sum(x*x) % 1000003 from c;'" ;;
	esac
}
echo "| workload | arm | seconds per run, one per round | median | spread |"
echo "| --- | --- | --- | --- | --- |"
declare -A times
for w in sha256 factor sqlite; do
	[ "$(sh -c "$(cmd shipped "$w")" | md5sum | cut -c1-8)" = "$(sh -c "$(cmd clang "$w")" | md5sum | cut -c1-8)" ] || echo "OUTPUT DIFFERS: $w" >&2
	for _ in $(seq "$rounds"); do
		for arm in shipped clang; do
			a=$EPOCHREALTIME
			taskset -c "$cpu" sh -c "$(cmd "$arm" "$w") > /dev/null 2>&1" || true
			b=$EPOCHREALTIME
			times[$w,$arm]+="$(awk -v a="$a" -v b="$b" 'BEGIN { printf "%.4f", b - a }') "
		done
	done
	for arm in shipped clang; do
		echo "$w $arm ${times[$w,$arm]}" | awk '{ n = NF - 2; for (i = 3; i <= NF; i++) v[i - 2] = $i; asort(v); printf "| %s | %s | %s | %.4f | %.1f%% |\n", $1, $2, substr($0, length($1 $2) + 3), v[int((n + 1) / 2)], 100 * (v[n] - v[1]) / v[int((n + 1) / 2)] }'
	done
done
