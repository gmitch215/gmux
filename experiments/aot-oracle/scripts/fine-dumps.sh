#!/usr/bin/env bash
# the katybug-profile workloads' block dumps from an unfused, untraced Katybug (every block ends at its first
# branch, call or return), for functions.ts to rank functions by
# usage: fine-dumps.sh <bin dir with busybox-amd64, coreutils, sqlite3, bash> <out dir> [workloads]
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
root=$(cd "$here/../../.." && pwd)
bin=$(cd "$1" && pwd)
mkdir -p "$2"
out=$(cd "$2" && pwd)
workloads=${3:-sha256 factor sqlite gzip bzip2 bash}
K=$root/src/gmux/katybug
. "$here/workloads.sh"
"$bin/busybox-amd64" seq 1 400000 > "$out/in"
clang -std=c11 -D_DEFAULT_SOURCE -O2 -DKB_HOT -DKB_FUSE=0 -DKB_TRACE=1 -o "$out/fine" "$K"/*.c -lm
for w in $workloads; do
	mkdir -p "$out/fine-$w"
	KATYBUG_HOT=$out/fine-$w sh -c "$(cmd "$out/fine" "$w")" > /dev/null 2>&1
done
ls "$out"/fine-*/*.hot
