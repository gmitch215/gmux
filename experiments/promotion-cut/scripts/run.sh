#!/usr/bin/env bash
# one guest end to end: graph, the ladder's two ends, the plan, the planned sets measured
# usage: BURROW_DIST=<burrow dist dir> run.sh <name> <guest.wasm> <out dir> <tau ns> "<budget fractions>" [rounds] [repeats]
# timed runs take build/batch/mac-bench.lock (two lanes time benchmarks on this Mac); needs wasm-tools and node
set -euo pipefail
: "${BURROW_DIST:?set BURROW_DIST to the burrow dist directory}"
[ $# -ge 5 ] || { echo "usage: BURROW_DIST=<dir> run.sh <name> <guest.wasm> <out dir> <tau ns> \"<budget fractions>\" [rounds] [repeats]" >&2; exit 2; }
name=$1 guest=$2 out=$3 tau=$4 budgets=$5 rounds=${6:-5} repeats=${7:-3}
here=$(cd "$(dirname "$0")" && pwd)
root=$(cd "$here/../../.." && pwd)
lock=$root/build/batch/mac-bench.lock
node="node --no-warnings --experimental-strip-types"
ladder=$root/experiments/promotion-ladder/scripts/ladder.ts
mkdir -p "$out"

# wasm-tools parse over a pipe hung once for 10 minutes at 0% cpu, so a prepare gets a deadline and two retries
prepare() {
	for try in 1 2 3; do
		timeout 180 $node "$ladder" prepare "$@" > /dev/null && return 0
	done
	return 1
}

timed() { # $1 log; rest: the command
	local log=$1
	shift
	until mkdir "$lock" 2> /dev/null; do sleep 20; done
	"$@" > "$log" 2>&1 && rc=0 || rc=$?
	rmdir "$lock"
	return $rc
}

$node "$here/graph.ts" "$guest" "$out/$name.graph.json"
echo '{}' > "$out/empty.json"
prepare "$guest" "$out/ends" "$out/empty.json"
LADDER_JSON=$out/$name.ends.json timed "$out/$name.ends.log" $node "$ladder" run "$out/ends" "$BURROW_DIST" "$rounds"
$node "$here/plan.ts" "$out/$name.graph.json" "$out/$name.ends.json" "$out/plan" "$tau" $budgets | tee "$out/$name.plan.log"
prepare "$guest" "$out/rungs" "$out/plan/sets.json"
for k in $(seq "$repeats"); do
	LADDER_JSON=$out/$name.run$k.json timed "$out/$name.run$k.log" $node "$ladder" run "$out/rungs" "$BURROW_DIST" "$rounds"
done
$node "$here/report.ts" "$out/plan/plan.json" "$out"/$name.run*.json | tee "$out/$name.report.md"
