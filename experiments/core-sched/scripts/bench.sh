#!/usr/bin/env bash
# times the three schedulers against each other, interleaved and rotated each round, one process
# per sample, pinned to CPUS, the host's timing lock taken around each sample (LOCK, default
# /tmp/paisley-timing.lock). Prints one JSON line per sample with the load average before it, and
# HUNG for a sample that passed LIMIT seconds (a hung run is counted, not retried).
# OLD and NEW are two copies of the machine (before and after the change); the arms are OLD, NEW
# on its TypeScript tables, and NEW on the C core.
# usage: OLD=<machine.ts> NEW=<machine.ts> CORE=<gmux-core.wasm> CPUS=<list or none> bench.sh <rounds> <steps> <kind:tasks>...
set -o pipefail
here=$(cd "$(dirname "$0")" && pwd)
rounds=${1:?usage: bench.sh <rounds> <steps> <kind:tasks>...}
steps=${2:?steps}
shift 2
: "${OLD:?}" "${NEW:?}" "${CORE:?}" "${CPUS:?}"
lock=${LOCK:-/tmp/paisley-timing.lock}
limit=${LIMIT:-240}
arms=(old ts core)
pin=()
[ "$CPUS" = none ] || pin=(taskset -c "$CPUS")
loadavg() { cut -d' ' -f1-3 /proc/loadavg 2> /dev/null || uptime | sed 's/.*: //'; }
for round in $(seq "$rounds"); do
	for load in "$@"; do
		kind=${load%%:*} tasks=${load##*:}
		for i in "${!arms[@]}"; do
			arm=${arms[$(((i + round - 1) % ${#arms[@]}))]}
			case $arm in
				old) e=("MACHINE=$OLD") ;;
				ts) e=("MACHINE=$NEW") ;;
				core) e=("MACHINE=$NEW" "CORE=$CORE") ;;
			esac
			until mkdir "$lock" 2> /dev/null; do sleep 5; done
			avg=$(loadavg)
			out=$(env -u CORE "${e[@]}" "${pin[@]}" timeout -s KILL "$limit" node --no-warnings --experimental-strip-types "$here/load.ts" "$kind" "$tasks" "$steps" 2> /dev/null | tail -1)
			rmdir "$lock"
			if [ -z "$out" ]; then
				echo "{\"arm\":\"$arm\",\"round\":$round,\"load\":\"$load\",\"loadavg\":\"$avg\",\"HUNG\":true}"
			else
				echo "${out%\}},\"arm\":\"$arm\",\"round\":$round,\"loadavg\":\"$avg\"}"
			fi
		done
	done
done
