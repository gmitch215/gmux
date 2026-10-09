#!/usr/bin/env bash
# the crossing counts of the five workloads with the ring off and on, RUNS runs each (default 3), one JSON
# line per run in $OUT/counts.jsonl with the load average (and, with QUIET, the quiet.sh reading) before it.
# With CPUS set each run is pinned to them and takes the host's timing lock (LOCK, default
# /tmp/paisley-timing.lock) around itself, so the per-second figures are the pinned host's.
# usage: GMUX_BUILD=<build dir> OUT=<dir> [CPUS=<list> QUIET=<quiet.sh>] counts.sh
set -o pipefail
here=$(cd "$(dirname "$0")" && pwd)
: "${GMUX_BUILD:?}" "${OUT:?}"
mkdir -p "$OUT"
: > "$OUT/counts.jsonl"
lock=${LOCK:-/tmp/paisley-timing.lock}
pin=()
[ -n "${CPUS:-}" ] && pin=(taskset -c "$CPUS")
loadavg() { cut -d' ' -f1-3 /proc/loadavg 2> /dev/null || uptime | sed 's/.*: //'; }
for run in $(seq "${RUNS:-3}"); do
	for w in seq cat idle fork forkout; do
		for ring in off on; do
			[ -z "${CPUS:-}" ] || until mkdir "$lock" 2> /dev/null; do sleep 5; done
			avg=$(loadavg)
			q=""
			[ -n "${QUIET:-}" ] && q=$(bash "$QUIET" "$CPUS")
			text=$(RING=$ring WORK="$OUT/work" "${pin[@]}" node --no-warnings --experimental-strip-types "$here/crossings.ts" "$w" 2> /dev/null | tail -1)
			[ -z "${CPUS:-}" ] || rmdir "$lock"
			echo "{\"run\":$run,\"loadavg\":\"$avg\",\"quiet\":\"$q\",\"out\":${text:-null}}" >> "$OUT/counts.jsonl"
		done
	done
done
