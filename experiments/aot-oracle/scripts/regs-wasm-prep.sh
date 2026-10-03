#!/usr/bin/env bash
# the lifted C regs-wasm.ts needs, from scale-1 runs on a Linux x86-64 host: aot-regs<layout>-<workload>.c
# (lift.ts --temps --windows --regs --slots, all three forms) and aot-old<layout>-<workload>.c (the same
# without --regs), for ladder-wasm.sh to build; the layouts differ only in the link order that build uses.
# WORKLOADS picks from sha256 factor sqlite gzip bzip2 bash (the first three by default).
# usage: regs-wasm-prep.sh <bin dir with busybox-amd64, coreutils, sqlite3, bash> <out dir> [layouts]
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
root=$(cd "$here/../../.." && pwd)
bin=$(cd "$1" && pwd)
mkdir -p "$2"
out=$(cd "$2" && pwd)
layouts=${3:-0 1 2}
node=${NODE:-node}
K=$root/src/gmux/katybug
"$bin/busybox-amd64" seq 1 400000 > "$out/in"
cmd() {
	local p=$1
	case $2 in
		sha256) echo "$p $bin/coreutils --coreutils-prog=sha256sum $out/in" ;;
		factor) echo "$p $bin/busybox-amd64 seq 1000000000000 1000000020000 | $p $bin/coreutils --coreutils-prog=factor" ;;
		sqlite) echo "$p $bin/sqlite3 :memory: 'with recursive c(x) as (select 1 union all select x+1 from c where x<100000) select count(*), sum(x*x) % 1000003 from c;'" ;;
		gzip) echo "$p $bin/busybox-amd64 gzip -9 -c $out/in" ;;
		bzip2) echo "$p $bin/busybox-amd64 bzip2 -9 -c $out/in" ;;
		bash) echo "$p $bin/bash -c 'i=0; s=0; while [ \$i -lt 20000 ]; do s=\$((s+i*i%7)); i=\$((i+1)); done; echo \$s'" ;;
	esac
}
clang -std=c11 -D_DEFAULT_SOURCE -O2 -DKB_HOT -o "$out/hot" "$K"/*.c -lm
for w in ${WORKLOADS:-sha256 factor sqlite}; do
	mkdir -p "$out/hot-$w"
	KATYBUG_HOT=$out/hot-$w sh -c "$(cmd "$out/hot" "$w")" > /dev/null 2>&1
	"$node" --no-warnings --experimental-strip-types "$here/lift.ts" --temps --windows --regs --slots "$out/aot-regs.$w.c" 0.99 "$out/hot-$w"/*.hot 2> "$out/lift-regs-$w.log"
	"$node" --no-warnings --experimental-strip-types "$here/lift.ts" --temps --windows "$out/aot-old.$w.c" 0.99 "$out/hot-$w"/*.hot 2> "$out/lift-old-$w.log"
	for l in $layouts; do
		cp "$out/aot-regs.$w.c" "$out/aot-regs$l-$w.c"
		cp "$out/aot-old.$w.c" "$out/aot-old$l-$w.c"
	done
done
ls "$out"/aot-*.c
