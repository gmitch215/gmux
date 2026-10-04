#!/usr/bin/env bash
# the three schedulers must pick the same runner at every step: runs each load under a frozen host
# clock with the machine's trace on, once per arm (OLD, the machine from before the change; NEW on its
# TypeScript tables; NEW on the C core), and compares the `resume` lines, with addresses renamed by
# first appearance. A second run of OLD checks the trace is deterministic.
# usage: OLD=<machine.ts> NEW=<machine.ts> CORE=<gmux-core.wasm> OUT=<directory> exact.sh <steps> <kind:tasks>...
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
steps=${1:?usage: exact.sh <steps> <kind:tasks>...}
shift
: "${OLD:?OLD names the older machine.ts}" "${NEW:?NEW names the newer machine.ts}" "${CORE:?CORE names gmux-core.wasm}" "${OUT:?OUT names a directory}"
mkdir -p "$OUT"
run() {
	local arm=$1 kind=$2 tasks=$3
	local e=(FROZEN=1 "TRACE=$OUT/$kind$tasks-$arm.txt")
	case $arm in
		old | old2) e+=("MACHINE=$OLD") ;;
		ts) e+=("MACHINE=$NEW") ;;
		core) e+=("MACHINE=$NEW" "CORE=$CORE") ;;
	esac
	env -u CORE "${e[@]}" node --no-warnings --experimental-strip-types "$here/load.ts" "$kind" "$tasks" "$steps" > /dev/null
}
status=0
for load in "$@"; do
	kind=${load%%:*} tasks=${load##*:}
	for arm in old old2 ts core; do run "$arm" "$kind" "$tasks"; done
	for arm in old2 ts core; do
		if result=$(node --no-warnings --experimental-strip-types "$here/compare.ts" "$OUT/$kind$tasks-old.txt" "$OUT/$kind$tasks-$arm.txt"); then
			echo "SAME $kind$tasks $arm $result"
		else
			echo "DIFF $kind$tasks $arm $result"
			status=1
		fi
	done
done
exit $status
