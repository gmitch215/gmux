#!/usr/bin/env bash
# the native (x86-64) time of region.sh's builds: the binary, the interpreter alone and each arm in each
# form, rounds interleaved on one core, `r` against the binary. Take the host's timing lock around it, or set
# LOCK=<dir> to take it around each sample (never across samples, waiting at most LOCK_WAIT seconds, 1800). With
# QUIET_CPUS=<cpus the sample is pinned to> each sample also reads build/batch/quiet.sh over its first 2 seconds; above
# QUIET_LIMIT (0.5) it is noisy, taken once more, and left out of the table if the second is noisy too (QUIET_PREWAIT=<s> first waits
# up to that long for a quiet reading before taking the lock). SAMPLES=<file> appends one
# tab-separated line per sample (host, workload, arm, process, round, attempt, ms, quiet, load1, rc). WANT=<md5 prefix of
# the binary's stdout> checks every arm's output after each sample, untimed. An arm whose
# run fails stops; three failed samples in a row end the script.
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
lock=${LOCK:-}
qcpus=${QUIET_CPUS:-}
samples=${SAMPLES:-}
quiet=$here/../../../build/batch/quiet.sh
prog() {
	case $1 in
		binary) echo "" ;;
		interp) echo "$out/interp" ;;
		*) echo "$out/run-${1%%:*}-$w" ;;
	esac
}
held=0
release() { if [ "$held" = 1 ]; then rmdir "$lock"; held=0; fi; }
trap release EXIT
acquire() {
	[ -n "$lock" ] || return 0
	local waited=0
	until mkdir "$lock" 2> /dev/null; do
		sleep 2
		waited=$((waited + 2))
		[ "$waited" -le "${LOCK_WAIT:-1800}" ] || { echo "no timing lock at $lock after $waited s" >&2; exit 3; }
	done
	held=1
}
declare -A ms load noisy skip
fails=0
qf=$(mktemp)
# one sample of an arm under the lock: sets t (ms), q (quiet reading or -), rc
sample() {
	local arm=$1 regs=0 qp='' waited=0 pre
	[[ $arm == *:* ]] && regs=${arm##*:}
	# QUIET_PREWAIT=<s>: wait that long for a quiet reading before taking the lock
	while [ -n "$qcpus" ] && [ "$waited" -lt "${QUIET_PREWAIT:-0}" ]; do
		pre=$(bash "$quiet" "$qcpus" 2 2> /dev/null | awk '{ print $2 }')
		awk -v q="${pre:-9}" -v lim="${QUIET_LIMIT:-0.5}" 'BEGIN { exit !(q <= lim) }' && break
		waited=$((waited + 3))
	done
	acquire
	q=-
	if [ -n "$qcpus" ]; then
		bash "$quiet" "$qcpus" 2 > "$qf" 2> /dev/null &
		qp=$!
	fi
	local t0=${EPOCHREALTIME/./}
	rc=0
	KATYBUG_REGS=$regs taskset -c "$core" timeout "${RUN_TIMEOUT:-600}" sh -c "$(cmd "$(prog "$arm")" "$w")" > /dev/null 2>&1 || rc=$?
	t=$(((${EPOCHREALTIME/./} - t0) / 1000))
	if [ -n "$qp" ]; then
		wait "$qp" || true
		q=$(awk '{ print $2 }' "$qf")
		[ -n "$q" ] || q=-
	fi
	release
	# WANT=<md5 prefix>: the run is repeated outside the timing and its stdout must hash to it (rc 9 when not)
	if [ -n "${WANT:-}" ] && [ "$rc" = 0 ] && [ "$arm" != interp ]; then
		got=$(KATYBUG_REGS=$regs taskset -c "$core" sh -c "$(cmd "$(prog "$arm")" "$w")" 2> /dev/null | md5sum | cut -c1-8)
		[ "$got" = "$WANT" ] || rc=9
	fi
}
# sample an arm for one round (at most twice if noisy), keeping the first quiet one: sets kept (0 or 1), t
take() {
	local arm=$1 round=$2 attempt
	kept=0
	for attempt in 1 2; do
		sample "$arm"
		l=$(cut -d' ' -f1 /proc/loadavg)
		[ -z "$samples" ] || printf 'x86\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\n' "$w" "$arm" "${PROCESS:-1}" "$round" "$attempt" "$t" "$q" "$l" "$rc" >> "$samples"
		if [ "$rc" != 0 ]; then
			skip[$arm]=1
			fails=$((fails + 1))
			[ "$fails" -lt 3 ] || { echo "three failed samples in a row" >&2; exit 4; }
			return 0
		fi
		fails=0
		if [ "$q" = - ] || awk -v q="$q" -v lim="${QUIET_LIMIT:-0.5}" 'BEGIN { exit !(q <= lim) }'; then
			kept=1
			return 0
		fi
		noisy[$arm]=$((${noisy[$arm]:-0} + 1))
		[ -n "$qcpus" ] || return 0
	done
}
for arm in "${arms[@]}"; do take "$arm" warm; done
for ((r = 0; r < rounds; r++)); do
	for arm in "${arms[@]}"; do
		[ -z "${skip[$arm]:-}" ] || continue
		take "$arm" "$((r + 1))"
		if [ "$kept" = 1 ]; then
			ms[$arm]+="$t "
			load[$arm]+="$l "
		fi
	done
done
base=$(printf '%s\n' ${ms[binary]:-} | sort -n | awk '{ a[NR] = $1 } END { print a[int((NR + 1) / 2)] }')
echo "workload $w, core $core, $rounds rounds after one warm run"
echo "| arm | ms per run | median ms | spread | r | load1 per run |"
echo "| --- | --- | --- | --- | --- | --- |"
for arm in "${arms[@]}"; do
	[ -n "${ms[$arm]:-}" ] || continue
	printf '%s\n' ${ms[$arm]} | sort -n | awk -v arm="$arm" -v base="${base:-0}" -v all="${ms[$arm]% }" -v ld="${load[$arm]% }" \
		'{ a[NR] = $1 } END { m = a[int((NR + 1) / 2)]; printf "| %s | %s | %d | %.1f%% | %.2f | %s |\n", arm, all, m, 100 * (a[NR] - a[1]) / m, (base > 0 ? m / base : 0), ld }'
done
for arm in "${arms[@]}"; do
	[ -z "${noisy[$arm]:-}" ] && [ -z "${skip[$arm]:-}" ] || echo "# $arm: ${noisy[$arm]:-0} noisy samples${skip[$arm]:+, stopped after a failed run}"
done
