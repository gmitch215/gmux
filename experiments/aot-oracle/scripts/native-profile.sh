#!/usr/bin/env bash
# hardware counters and call-stack samples of the lifted C built natively (non-PIE, frame pointers),
# with and without the signal check, on workloads long enough for perf; digests must match per arm.
# usage: native-profile.sh <lifted.c> <bin dir with busybox-amd64, coreutils, sqlite3> <out dir> [scale]
set -euo pipefail

here=$(cd "$(dirname "$0")" && pwd)
root=$(cd "$here/../../.." && pwd)
aot=$1
bin=$2
out=$3
scale=${4:-10}
work=$(mktemp -d /tmp/gmux-aot-profile.XXXXXX)
K=$root/src/gmux/katybug

mkdir -p "$out"
: > "$out/outputs.sha256"
clang -g -fno-omit-frame-pointer -fno-pie -no-pie -std=c11 -D_DEFAULT_SOURCE -O2 -DKB_AOT -I"$K" -I"$here/../src" \
	-o "$work/aot" "$K"/*.c "$aot" -lm
clang -g -fno-omit-frame-pointer -fno-pie -no-pie -std=c11 -D_DEFAULT_SOURCE -O2 -DKB_AOT -DAOT_NO_SIGNAL_CHECK -I"$K" -I"$here/../src" \
	-o "$work/aot-nosignal" "$K"/*.c "$aot" -lm
dd if=/dev/zero of="$work/in" bs=4M count="$scale" status=none

run() {
	local arm=$1
	local workload=$2
	case $workload in
		sha256) "$work/$arm" "$bin/coreutils" --coreutils-prog=sha256sum "$work/in" > /dev/null ;;
		factor) "$work/$arm" "$bin/busybox-amd64" seq 1000000000000 "$((1000000020000 + 20000 * scale))" | "$work/$arm" "$bin/coreutils" --coreutils-prog=factor > /dev/null ;;
		sqlite) "$work/$arm" "$bin/sqlite3" :memory: "with recursive c(x) as (select 1 union all select x+1 from c where x<$((100000 * scale))) select count(*), sum(x*x) % 1000003 from c;" > /dev/null ;;
	esac
}

output() {
	local arm=$1
	local workload=$2
	case $workload in
		sha256) "$work/$arm" "$bin/coreutils" --coreutils-prog=sha256sum "$work/in" ;;
		factor) "$work/$arm" "$bin/busybox-amd64" seq 1000000000000 "$((1000000020000 + 20000 * scale))" | "$work/$arm" "$bin/coreutils" --coreutils-prog=factor ;;
		sqlite) "$work/$arm" "$bin/sqlite3" :memory: "with recursive c(x) as (select 1 union all select x+1 from c where x<$((100000 * scale))) select count(*), sum(x*x) % 1000003 from c;" ;;
	esac
}

export -f run
export work bin scale

for workload in sha256 factor sqlite; do
	for arm in aot aot-nosignal; do
		perf stat -x, -o "$out/$workload-$arm-core.csv" -e instructions,cycles,branches,branch-misses \
			bash -c 'run "$@"' -- "$arm" "$workload"
		perf stat -x, -o "$out/$workload-$arm-cache.csv" -e cache-references,cache-misses \
			bash -c 'run "$@"' -- "$arm" "$workload"
	done
	perf record -q -g -F 999 -o "$out/$workload.data" -- bash -c 'run "$@"' -- aot "$workload"
	perf report --stdio --no-children --sort symbol --percent-limit 0.5 -i "$out/$workload.data" > "$out/$workload-symbols.txt"
	digest=$(output aot "$workload" | sha256sum | cut -d' ' -f1)
	[ "$digest" = "$(output aot-nosignal "$workload" | sha256sum | cut -d' ' -f1)" ]
	printf '%s %s\n' "$workload" "$digest" >> "$out/outputs.sha256"
done
