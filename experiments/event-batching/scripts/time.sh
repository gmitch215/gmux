#!/usr/bin/env bash
# CPU of the console workloads with the ring on and off, one process per sample (boot, then the
# workload alone), arms alternated each round, pinned to CPUS, the host's timing lock taken around each
# sample only, a quiet.sh reading (QUIET) or the load average before each. One JSON line per sample in
# $OUT/<workload>.jsonl. A sample whose output hash differs from EXPECT_<workload> or that exits non-zero
# fails its cell; three failures in a row end the sweep. The done marker (DONE) is written whatever the
# exit status.
# usage: GMUX_BUILD=<build dir> CPUS=<list or none> OUT=<dir> DONE=<marker> EXPECT_seq=<sha> EXPECT_cat=<sha> time.sh [workload...]
# RUNS (default 3) and ROUNDS (default 25) set the sample count per arm and workload: RUNS x ROUNDS.
set -o pipefail
here=$(cd "$(dirname "$0")" && pwd)
: "${GMUX_BUILD:?}" "${CPUS:?}" "${OUT:?}" "${DONE:?}"
trap 'echo $? > "$DONE"' EXIT
workloads=("$@")
[ ${#workloads[@]} -gt 0 ] || workloads=(seq cat)
runs=${RUNS:-3}
rounds=${ROUNDS:-25}
lock=${LOCK:-/tmp/paisley-timing.lock}
limit=${LIMIT:-300}
pin=()
[ "$CPUS" = none ] || pin=(taskset -c "$CPUS")
mkdir -p "$OUT"
loadavg() { cut -d' ' -f1-3 /proc/loadavg 2> /dev/null || uptime | sed 's/.*: //'; }
declare -A dead
fails=0
arms=(off on)
for w in "${workloads[@]}"; do : > "$OUT/$w.jsonl"; done
for run in $(seq "$runs"); do
	for round in $(seq "$rounds"); do
		for w in "${workloads[@]}"; do
			[ -z "${dead[$w]:-}" ] || continue
			expect_var=EXPECT_$w
			for i in 0 1; do
				arm=${arms[$(((i + round - 1) % 2))]}
				until mkdir "$lock" 2> /dev/null; do sleep 5; done
				avg=$(loadavg)
				q=""
				[ -n "${QUIET:-}" ] && q=$(bash "$QUIET" "$CPUS")
				text=$(env MODE=time RING="$arm" WORK="${WORK:-$OUT/work}" "${pin[@]}" timeout -s KILL "$limit" \
					node --no-warnings --experimental-strip-types "$here/crossings.ts" "$w" 2> /dev/null | tail -1)
				rc=$?
				rmdir "$lock"
				ok=0
				[ "$rc" -eq 0 ] && [[ "$text" == *"\"outputSha\":\"${!expect_var}\""* ]] && [[ "$text" == *'"crashed":"null"'* ]] && ok=1
				json=${text:-null}
				echo "{\"workload\":\"$w\",\"arm\":\"$arm\",\"run\":$run,\"round\":$round,\"loadavg\":\"$avg\",\"quiet\":\"$q\",\"rc\":$rc,\"ok\":$ok,\"out\":$json}" >> "$OUT/$w.jsonl"
				if [ "$ok" -eq 1 ]; then
					fails=0
				else
					fails=$((fails + 1))
					dead[$w]=1
				fi
				[ "$fails" -lt 3 ] || { echo "STOP three failed samples in a row" >> "$OUT/$w.jsonl"; exit 1; }
				[ -z "${dead[$w]:-}" ] || break
			done
		done
	done
done
exit 0
