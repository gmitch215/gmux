#!/usr/bin/env bash
# the native (x86-64) time of region.sh's builds: the binary, the interpreter alone and each arm in each
# form, rounds interleaved on one core, `r` against the binary. Take the host's timing lock around it.
# usage: [ARMS="binary interp fn:0 ..."] region-time.sh <bin dir> <out dir of region.sh> <workload> <core> [rounds, 7]
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
bin=$(cd "$1" && pwd)
out=$(cd "$2" && pwd)
w=$3
core=$4
rounds=${5:-7}
. "$here/workloads.sh"
read -ra arms <<< "${ARMS:-binary interp fn:0 fn:1 fn:2 fnc:0 fnc:1 fnc:2 all:0 all:1 all:2}"
prog() {
	case $1 in
		binary) echo "" ;;
		interp) echo "$out/interp" ;;
		*) echo "$out/run-${1%%:*}-$w" ;;
	esac
}
declare -A ms load
run() { # arm: time of one run in ms
	local arm=$1 regs=0
	[[ $arm == *:* ]] && regs=${arm##*:}
	local t0=${EPOCHREALTIME/./}
	KATYBUG_REGS=$regs taskset -c "$core" timeout "${RUN_TIMEOUT:-600}" sh -c "$(cmd "$(prog "$arm")" "$w")" > /dev/null 2>&1
	echo $(((${EPOCHREALTIME/./} - t0) / 1000))
}
for arm in "${arms[@]}"; do run "$arm" > /dev/null; done
for ((r = 0; r < rounds; r++)); do
	for arm in "${arms[@]}"; do
		ms[$arm]+="$(run "$arm") "
		load[$arm]+="$(cut -d' ' -f1 /proc/loadavg) "
	done
done
base=$(printf '%s\n' ${ms[binary]} | sort -n | awk '{ a[NR] = $1 } END { print a[int((NR + 1) / 2)] }')
echo "workload $w, core $core, $rounds rounds after one warm run"
echo "| arm | ms per run | median ms | spread | r | load1 per run |"
echo "| --- | --- | --- | --- | --- | --- |"
for arm in "${arms[@]}"; do
	printf '%s\n' ${ms[$arm]} | sort -n | awk -v arm="$arm" -v base="$base" -v all="${ms[$arm]% }" -v ld="${load[$arm]% }" \
		'{ a[NR] = $1 } END { m = a[int((NR + 1) / 2)]; printf "| %s | %s | %d | %.1f%% | %.2f | %s |\n", arm, all, m, 100 * (a[NR] - a[1]) / m, m / base, ld }'
done
