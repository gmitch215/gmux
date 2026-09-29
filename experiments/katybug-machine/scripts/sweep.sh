#!/usr/bin/env bash
# times each loop under each Katybug variant, the variants interleaved and their order rotated each round
# usage: LOCK=<dir> sweep.sh <bundle> <rounds> <variant,variant...> <loop,loop...>
# prints `round variant loop ms`; LOCK is taken (mkdir) around every timed run and waited for while another lane holds it
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
bundle=${1:?usage: LOCK=<dir> sweep.sh <bundle> <rounds> <variants> <loops>}
rounds=${2:?rounds}
IFS=, read -r -a variants <<< "${3:?variants}"
IFS=, read -r -a loops <<< "${4:?loops}"
lock=${LOCK:?LOCK names the directory taken around each timed run}
for round in $(seq "$rounds"); do
	for loop in "${loops[@]}"; do
		for i in "${!variants[@]}"; do
			v=${variants[$(((i + round - 1) % ${#variants[@]}))]}
			until mkdir "$lock" 2> /dev/null; do sleep 5; done
			rc=0
			line=$(node --no-warnings --experimental-strip-types "$here/machine.ts" run "$bundle" "$v" "$loop") || rc=$?
			rmdir "$lock"
			[ $rc = 0 ] || exit $rc
			echo "$round $line"
		done
	done
done
