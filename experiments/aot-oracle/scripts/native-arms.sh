#!/usr/bin/env bash
# the oracle's native attribution arms on a Linux x86-64 host: the same lifted C built natively, with
# and without the per-transition signal check and the per-access range check, against Katybug's
# interpreter and the binaries themselves; milliseconds per run (bash's time) and peak RSS (GNU time).
# usage: native-arms.sh <lifted.c> <bin dir with busybox-amd64, coreutils, sqlite3> [runs]; needs clang
set -uo pipefail
here=$(cd "$(dirname "$0")" && pwd)
root=$(cd "$here/../../.." && pwd)
aot=$1
bin=$2
runs=${3:-5}
K=$root/src/gmux/katybug
work=$(mktemp -d)
build() { clang -std=c11 -D_DEFAULT_SOURCE -O2 "$@" -lm; }
build -o "$work/plain" "$K"/*.c
aotflags=(-DKB_AOT -I"$K" -I"$here/../src")
build -o "$work/aot" "${aotflags[@]}" "$K"/*.c "$aot"
build -o "$work/aot-nosignal" "${aotflags[@]}" -DAOT_NO_SIGNAL_CHECK "$K"/*.c "$aot"
build -o "$work/aot-norange" "${aotflags[@]}" -DAOT_NO_RANGE_CHECK "$K"/*.c "$aot"
build -o "$work/aot-neither" "${aotflags[@]}" -DAOT_NO_SIGNAL_CHECK -DAOT_NO_RANGE_CHECK "$K"/*.c "$aot"
"$bin/busybox-amd64" seq 1 400000 > "$work/in"
cmd() {
	local p=$1
	case $2 in
		sha256) echo "$p $bin/coreutils --coreutils-prog=sha256sum $work/in" ;;
		factor) echo "$p $bin/busybox-amd64 seq 1000000000000 1000000020000 | $p $bin/coreutils --coreutils-prog=factor" ;;
		sqlite) echo "$p $bin/sqlite3 :memory: 'with recursive c(x) as (select 1 union all select x+1 from c where x<100000) select count(*), sum(x*x) % 1000003 from c;'" ;;
	esac
}
TIMEFORMAT=%3R
echo "| workload | arm | ms per run | output | peak RSS KiB |"
echo "| --- | --- | --- | --- | --- |"
for w in sha256 factor sqlite; do
	for arm in native plain aot aot-nosignal aot-norange aot-neither; do
		p=
		[ "$arm" = native ] || p="$work/$arm"
		c=$(cmd "$p" "$w")
		out=$(sh -c "$c" 2> /dev/null | md5sum | cut -c1-8) || out=crash
		times=$(for _ in $(seq "$runs"); do { time sh -c "$c > /dev/null"; } 2>&1; done | sort -n | tr '\n' ' ')
		rss=$( { /usr/bin/time -f %M sh -c "$c > /dev/null"; } 2>&1 | tail -1)
		echo "| $w | $arm | $times | $out | $rss |"
	done
done
