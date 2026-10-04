#!/usr/bin/env bash
# the return counts of every workload on both arches: a katybug built from a copy of the sources with
# ret-count.patch (-DKB_COUNT) prints, per return block, how often a return went where the block's
# last one did and how often one target took more than 95% of its returns
# usage: ret-counts.sh <out dir>   (SRC=<katybug sources> WORKLOADS=<file>; writes <out dir>/counts.txt)
set -uo pipefail
here=$(cd "$(dirname "$0")" && pwd)
root=$(cd "$here/../../.." && pwd)
out=${1:?usage: ret-counts.sh <out dir>}
mkdir -p "$out/src"
out=$(cd "$out" && pwd)
src=${SRC:-$root/src/gmux/katybug}
wl=${WORKLOADS:-$here/../workloads.txt}
cp "$src"/*.c "$src"/*.h "$out/src/"
patch -s -p1 -d "$out/src" < "$here/../ret-count.patch" || exit 1
cc -std=c11 -D_DEFAULT_SOURCE -D_DARWIN_C_SOURCE -O2 -DKB_COUNT -o "$out/katybug" "$out"/src/*.c -lm || exit 1
[ -f "$out/in" ] || seq 1 200000 > "$out/in"
[ -f "$out/in30k" ] || seq 1 30000 > "$out/in30k"
: > "$out/counts.txt"
cd "$out" || exit 1
for arch in x86_64 aarch64; do
	sfx=
	[ "$arch" = aarch64 ] && sfx=-aarch64
	export T=$root/build/katybug/transcript$sfx
	export U=$T/ubin
	while IFS='|' read -r name cmd; do
		line=$(KATYBUG_RET=1 KATYBUG_STATS=1 sh -c "${cmd//@/$out/katybug}" 2>&1 > /dev/null | grep -E 'ret: ' | tr -d '\n')
		printf '%s %s: %s\n' "$arch" "$name" "$line" >> "$out/counts.txt"
	done < "$wl"
done
