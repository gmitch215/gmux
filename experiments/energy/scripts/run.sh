#!/usr/bin/env bash
# one energy run on paisley-park under the timing lock, released on exit; the rig and workerd are
# pinned to the same two idle logical cpus. WORKERD and WORKERD_PORT add the workerd arm
# usage: WORK=<dir> [NODE=<node>] [WORKERD=<binary> WORKERD_PORT=<port>] run.sh [rounds]
set -uo pipefail
: "${WORK:?usage: WORK=<dir> [WORKERD=<binary> WORKERD_PORT=<port>] run.sh [rounds]}"
node=${NODE:-node}
here=$(cd "$(dirname "$0")" && pwd)
lock=${LOCK:-/tmp/paisley-timing.lock}
mkdir "$lock" || {
	echo "timing lock held: $lock"
	exit 3
}
wpid=
cleanup() {
	[ -n "$wpid" ] && kill "$wpid" 2> /dev/null
	rmdir "$lock"
}
trap cleanup EXIT
run() { "$node" --no-warnings --experimental-strip-types "$here/energy.ts" "$@"; }
cpus=$(WORK=$WORK run pick)
echo "cpus $cpus; node $("$node" -v); governor $(cat /sys/devices/system/cpu/cpu0/cpufreq/scaling_governor); load $(cut -d' ' -f1-3 /proc/loadavg); $(date -u +%FT%TZ)"
export ARMS=${ARMS:-native,node,async,katybug}
if [ -n "${WORKERD:-}" ]; then
	: "${WORKERD_PORT:?set WORKERD_PORT with WORKERD}"
	taskset -c "$cpus" "$WORKERD" serve --socket-addr "http=127.0.0.1:$WORKERD_PORT" "$WORK/worker/config.capnp" > "$WORK/workerd.log" 2>&1 &
	wpid=$!
	sleep 2
	export WORKER_URL=http://127.0.0.1:$WORKERD_PORT WORKERD_PID=$wpid
	ARMS=$ARMS,workerd
fi
echo "arms $ARMS"
WORK=$WORK taskset -c "$cpus" "$node" --no-warnings --experimental-strip-types "$here/energy.ts" run "${1:-3}" &
rig=$!
sleep 5
echo "affinity: rig $(taskset -cp $rig | sed 's/.*: //')${wpid:+, workerd $(taskset -cp $wpid | sed 's/.*: //')}"
wait $rig
