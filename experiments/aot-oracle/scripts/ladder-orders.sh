#!/usr/bin/env bash
# the ladder's arms linked in three source orders (forward, reversed, rotated) from the sources and lifted
# C ladder.sh left in <out dir>, timed interleaved on one pinned core: link order alone moved one arm 28%
# (bench-link-order), so an arm is the mean of its three orders' medians and the spread between orders is
# printed beside it. Builds run BUILD_CPUS-wide on BUILD_CPUSET (default 4 cpus, unpinned).
# usage: ladder-orders.sh <bin dir with busybox-amd64, coreutils, sqlite3> <out dir> [rounds] [cpu] [scale]
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
root=$(cd "$here/../../.." && pwd)
bin=$(cd "$1" && pwd)
out=$(cd "$2" && pwd)
rounds=${3:-5}
cpu=${4:-5}
scale=${5:-10}
K=$root/src/gmux/katybug
ls "$K"/*.c > "$out/order.txt"
tac "$out/order.txt" > "$out/order-rev.txt"
{ tail -n +10 "$out/order.txt"; head -n 9 "$out/order.txt"; } > "$out/order-rot.txt"
cp "$out/order.txt" "$out/order-fwd.txt"
flags() {
	local f="-DKB_AOT -I$K -I$here/../src"
	case $1 in
		A | B | B0) f="$f -DKB_TRACE=1 -DAOT_POLL=0" ;;
		C | C0) f="$f -DAOT_POLL=0" ;;
	esac
	echo "$f"
}
arms=(A B B0 C C0 D E)
orders=(fwd rev rot)
jobs=()
workloads=${WORKLOADS:-sha256 factor sqlite}
for w in $workloads; do
	for a in "${arms[@]}"; do
		for o in "${orders[@]}"; do [ -x "$out/$a-$o-$w" ] && [ -z "${REBUILD:-}" ] || jobs+=("$a $w $o"); done
	done
done
export K out here
build() {
	local a=$1 w=$2 o=$3 f
	f=$(flags "$a")
	# shellcheck disable=SC2046,SC2086
	clang -std=c11 -D_DEFAULT_SOURCE -O2 $f -o "$out/$a-$o-$w" $(cat "$out/order-$o.txt") "$out/aot-$a-$w.c" -lm
}
export -f build flags
[ "${#jobs[@]}" -eq 0 ] || printf '%s\n' "${jobs[@]}" | ${BUILD_CPUSET:+taskset -c "$BUILD_CPUSET"} xargs -P "${BUILD_CPUS:-4}" -L 1 bash -c 'build $0 $1 $2'
cmd() { # program, workload
	case $2 in
		sha256) echo "$1 $bin/coreutils --coreutils-prog=sha256sum $out/in-$scale" ;;
		factor) echo "$1 $bin/busybox-amd64 seq 1000000000000 $((1000000020000 + 20000 * (scale - 1))) | $1 $bin/coreutils --coreutils-prog=factor" ;;
		sqlite) echo "$1 $bin/sqlite3 :memory: 'with recursive c(x) as (select 1 union all select x+1 from c where x<$((100000 * scale))) select count(*), sum(x*x) % 1000003 from c;'" ;;
	esac
}
echo "| workload | arm | median seconds, forward / reversed / rotated | mean of the three | spread between orders |"
echo "| --- | --- | --- | --- | --- |"
declare -A times
for w in $workloads; do
	# the first run of each build reads cold pages
	for a in "${arms[@]}"; do for o in "${orders[@]}"; do taskset -c "$cpu" sh -c "$(cmd "$out/$a-$o-$w" "$w") > /dev/null 2>&1" || true; done; done
	for _ in $(seq "$rounds"); do
		for a in "${arms[@]}"; do
			for o in "${orders[@]}"; do
				s=$EPOCHREALTIME
				taskset -c "$cpu" sh -c "$(cmd "$out/$a-$o-$w" "$w") > /dev/null 2>&1" || true
				e=$EPOCHREALTIME
				times[$w,$a,$o]+="$(awk -v a="$s" -v b="$e" 'BEGIN { printf "%.4f", b - a }') "
			done
		done
		echo "$w load $(cut -d' ' -f1 /proc/loadavg)" >&2
	done
	for a in "${arms[@]}"; do
		med=()
		for o in "${orders[@]}"; do
			med+=("$(echo "${times[$w,$a,$o]}" | tr ' ' '\n' | grep . | sort -n | awk '{ v[NR] = $1 } END { printf "%.4f", v[int((NR + 1) / 2)] }')")
		done
		echo "| $w | $a | ${med[0]} / ${med[1]} / ${med[2]} | $(printf '%s\n' "${med[@]}" | awk '{ s += $1 } END { printf "%.4f", s / NR }') | $(printf '%s\n' "${med[@]}" | awk 'NR == 1 { lo = hi = $1 } { if ($1 < lo) lo = $1; if ($1 > hi) hi = $1; s += $1 } END { printf "%.1f%%", 100 * (hi - lo) / (s / NR) }') |"
	done
done
