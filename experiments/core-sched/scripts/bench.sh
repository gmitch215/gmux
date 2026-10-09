#!/usr/bin/env bash
# times the three schedulers against each other, interleaved and rotated each round, one process
# per sample, pinned to CPUS, the host's timing lock taken around each sample (LOCK, default
# /tmp/paisley-timing.lock). Prints one JSON line per sample with the load average before it, and
# HUNG for a sample that passed LIMIT seconds (a hung run is counted, not retried).
# OLD and NEW are two copies of the machine (before and after the change); the arms are OLD, NEW
# on its TypeScript tables, and NEW on the C core.
# KERNELS="<name>=<GMUX_BUILD dir>..." times kernels instead: each arm runs NEW's machine on that build,
# OLD and CORE are not used; QUIET=<quiet.sh> records the outside-cpuset busy reading per sample.
# usage: OLD=<machine.ts> NEW=<machine.ts> CORE=<gmux-core.wasm> CPUS=<list or none> bench.sh <rounds> <steps> <kind:tasks>...
set -o pipefail
here=$(cd "$(dirname "$0")" && pwd)
rounds=${1:?usage: bench.sh <rounds> <steps> <kind:tasks>...}
steps=${2:?steps}
shift 2
: "${NEW:?}" "${CPUS:?}"
if [ -n "${KERNELS:-}" ]; then
	arms=()
	for kv in $KERNELS; do arms+=("${kv%%=*}"); done
	kernel_dir() { for kv in $KERNELS; do [ "${kv%%=*}" = "$1" ] && echo "${kv#*=}"; done; }
else
	: "${OLD:?}" "${CORE:?}"
	arms=(old ts core)
fi
lock=${LOCK:-/tmp/paisley-timing.lock}
limit=${LIMIT:-240}
pin=()
[ "$CPUS" = none ] || pin=(taskset -c "$CPUS")
loadavg() { cut -d' ' -f1-3 /proc/loadavg 2> /dev/null || uptime | sed 's/.*: //'; }
declare -A dead
fails=0
for round in $(seq "$rounds"); do
	for load in "$@"; do
		kind=${load%%:*} tasks=${load##*:}
		for i in "${!arms[@]}"; do
			[ -n "${dead[$load]:-}" ] && break
			arm=${arms[$(((i + round - 1) % ${#arms[@]}))]}
			case $arm in
				old) e=("MACHINE=$OLD") ;;
				ts) e=("MACHINE=$NEW") ;;
				core) e=("MACHINE=$NEW" "CORE=$CORE") ;;
				*) e=("MACHINE=$NEW" "GMUX_BUILD=$(kernel_dir "$arm")") ;;
			esac
			until mkdir "$lock" 2> /dev/null; do sleep 5; done
			avg=$(loadavg)
			q=""
			[ -n "${QUIET:-}" ] && q=$(bash "$QUIET" "$CPUS")
			out=$(env -u CORE "${e[@]}" "${pin[@]}" timeout -s KILL "$limit" node --no-warnings --experimental-strip-types "$here/load.ts" "$kind" "$tasks" "$steps" 2> /dev/null | tail -1)
			rc=$?
			rmdir "$lock"
			qf=""
			[ -n "$q" ] && qf=",\"quiet\":\"$q\""
			if [ -z "$out" ]; then
				echo "{\"arm\":\"$arm\",\"round\":$round,\"load\":\"$load\",\"loadavg\":\"$avg\"$qf,\"rc\":$rc,\"HUNG\":true}"
			else
				echo "${out%\}},\"arm\":\"$arm\",\"round\":$round,\"loadavg\":\"$avg\"$qf,\"rc\":$rc}"
			fi
			# STOP_ON_FAIL: a failed sample ends its load's cell; three failures in a row end the sweep
			if [ -n "${STOP_ON_FAIL:-}" ]; then
				if [ "$rc" -ne 0 ] || [ -z "$out" ]; then
					fails=$((fails + 1))
					dead[$load]=1
				else
					fails=0
				fi
				[ "$fails" -lt 3 ] || exit 1
			fi
		done
	done
done
