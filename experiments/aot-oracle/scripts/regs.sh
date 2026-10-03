#!/usr/bin/env bash
# guest-state traffic of lifted regions, the form every earlier arm used (KATYBUG_REGS=0) against the
# precise form (KATYBUG_REGS=1, lift.ts --regs) and the slots form (KATYBUG_REGS=2, --slots: slot_ld
# loads served by a local, slot_st stores that updated one, fix_edge loads at a stub or edge, fix_alias
# re-reads after an unknown store, mem_ld and mem_st guest accesses that went to memory), per 1,000 guest
# instructions and by where the words
# are moved; outputs of both compared with the binary's. One build of Katybug per workload holds both.
# usage: regs.sh <bin dir with busybox-amd64, coreutils, sqlite3, bash, curl> <out dir> [workloads]
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
root=$(cd "$here/../../.." && pwd)
bin=$(cd "$1" && pwd)
mkdir -p "$2"
out=$(cd "$2" && pwd)
workloads=${3:-factor gzip bzip2 sqlite bash sha256 curl}
node=${NODE:-node}
K=$root/src/gmux/katybug
build() { clang -std=c11 -D_DEFAULT_SOURCE -O2 "$@" -lm; }
"$bin/busybox-amd64" seq 1 400000 > "$out/in"
cmd() { # program, workload
	local p=$1
	case $2 in
		sha256) echo "$p $bin/coreutils --coreutils-prog=sha256sum $out/in" ;;
		factor) echo "$p $bin/busybox-amd64 seq 1000000000000 1000000020000 | $p $bin/coreutils --coreutils-prog=factor" ;;
		gzip) echo "$p $bin/busybox-amd64 gzip -9 -c $out/in" ;;
		bzip2) echo "$p $bin/busybox-amd64 bzip2 -9 -c $out/in" ;;
		sqlite) echo "$p $bin/sqlite3 :memory: 'with recursive c(x) as (select 1 union all select x+1 from c where x<100000) select count(*), sum(x*x) % 1000003 from c;'" ;;
		bash) echo "$p $bin/bash -c 'i=0; s=0; while [ \$i -lt 20000 ]; do s=\$((s+i*i%7)); i=\$((i+1)); done; echo \$s'" ;;
		curl) echo "$p $bin/curl -s file://$out/in" ;;
	esac
}
md() { md5sum | cut -c1-8; }
build -o "$out/hot" -DKB_HOT "$K"/*.c
build -o "$out/plain" -DKB_COUNT "$K"/*.c
echo "workload,arm,output,insns,rd,wr,lifted,c0rd,c0wr,c1rd,c1wr,c2rd,c2wr,c3rd,c3wr,c4rd,c4wr,c5rd,c5wr,slot_ld,slot_st,fix_edge,fix_alias,mem_ld,mem_st,entries"
for w in $workloads; do
	d=$out/hot-$w
	mkdir -p "$d"
	KATYBUG_HOT=$d sh -c "$(cmd "$out/hot" "$w")" > /dev/null 2>&1
	node_dumps=("$d"/*.hot)
	"$node" --no-warnings --experimental-strip-types "$here/lift.ts" --temps --windows --regs --slots "$out/aot-$w.c" 0.99 "${node_dumps[@]}" 2> "$out/lift-$w.log"
	build -o "$out/aot-$w" -DKB_COUNT -DKB_AOT -I"$K" -I"$here/../src" "$K"/*.c "$out/aot-$w.c"
	want=$(sh -c "$(cmd "" "$w")" | md)
	for arm in plain aot0 aot1 aot2; do
		prog=$out/aot-$w regs=0
		[ "$arm" = plain ] && prog=$out/plain
		[ "$arm" = aot1 ] && regs=1
		[ "$arm" = aot2 ] && regs=2
		got=$(KATYBUG_REGS=$regs sh -c "$(cmd "$prog" "$w")" 2> /dev/null | md)
		[ "$got" = "$want" ] && got=exact || got="$got DIFFERS from $want"
		: > "$out/$w-$arm.count"
		KATYBUG_REGS=$regs KATYBUG_COUNT=$out/$w-$arm.count sh -c "$(cmd "$prog" "$w") > /dev/null 2>&1"
		awk -v w="$w" -v arm="$arm" -v got="$got" '/^katybug count:/ {
				for (i = 3; i < NF; i += 2) s[$i] += $(i + 1)
			} END {
				k = 1000 / s["insns"]
				printf "%s,%s,%s,%d,%.1f,%.1f,%.1f%%", w, arm, got, s["insns"], s["rd"] * k, s["wr"] * k, 100 * s["lifted"] / s["insns"]
				for (c = 0; c < 6; c++) printf ",%.1f,%.1f", s["c" c "rd"] * k, s["c" c "wr"] * k
				for (c = 6; c < 9; c++) printf ",%.1f,%.1f", s["c" c "rd"] * k, s["c" c "wr"] * k
				printf ",%d\n", s["entries"]
			}' "$out/$w-$arm.count"
	done
done
