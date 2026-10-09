#!/usr/bin/env bash
# CPU per transfer of the tests/c/sendfile probe built natively: a run with no transfers (fork, the source
# file, the connection) and a run with CALLS, and the difference per transfer. One JSON line.
# usage: sendfile-native.sh <probe binary> <sendfile|splice|rw> <bytes per transfer> <transfers>
set -uo pipefail
bin=${1:?usage: sendfile-native.sh <probe binary> <sendfile|splice|rw> <bytes> <transfers>}
kind=${2:?}
size=${3:?}
calls=${4:?}
TIMEFORMAT='%3U %3S'
run() { { time "$bin" cpu "$kind" "$size" "$1" > /dev/null; } 2>&1; }
run 1 > /dev/null
base=$(run 0)
rc0=$?
main=$(run "$calls")
rc=$?
ok=false
[ "$rc" -eq 0 ] && [ "$rc0" -eq 0 ] && ok=true
awk -v base="$base" -v main="$main" -v kind="$kind" -v size="$size" -v calls="$calls" -v ok="$ok" 'BEGIN {
	split(base, b, " "); split(main, m, " ")
	bc = (b[1] + b[2]) * 1000; mc = (m[1] + m[2]) * 1000
	printf "{\"host\":\"native\",\"kind\":\"%s\",\"size\":%d,\"calls\":%d,\"ok\":%s,\"baseCpuMs\":%.3f,\"cpuMs\":%.3f,\"cpuUsPerCall\":%.3f}\n", kind, size, calls, ok, bc, mc, (mc - bc) * 1000 / calls
}'
