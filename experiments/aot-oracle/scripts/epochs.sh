#!/usr/bin/env bash
# what the interpreter checks while it runs, and how many of those checks one epoch compare per block
# replaces: -DKB_COUNT builds with the epoch guard (-DKB_EPOCH=1) and without it (default) run each
# workload, and the counters (per guest instruction) are tabled beside each other. The product builds
# of both arms must print what the native binary prints.
# usage: epochs.sh <bin dir with busybox-amd64, coreutils, sqlite3> <out dir>
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
root=$(cd "$here/../../.." && pwd)
bin=$(cd "$1" && pwd)
mkdir -p "$2"
out=$(cd "$2" && pwd)
K=$root/src/gmux/katybug
build() { clang -std=c11 -D_DEFAULT_SOURCE -O2 "$@" -lm; }
build -o "$out/plain-after" -DKB_EPOCH=1 "$K"/*.c
build -o "$out/plain-before" -DKB_EPOCH=0 "$K"/*.c
build -o "$out/count-after" -DKB_COUNT -DKB_EPOCH=1 "$K"/*.c
build -o "$out/count-before" -DKB_COUNT -DKB_EPOCH=0 "$K"/*.c
"$bin/busybox-amd64" seq 1 400000 > "$out/in"
cmd() {
	local p=$1
	case $2 in
		sha256) echo "$p $bin/coreutils --coreutils-prog=sha256sum $out/in" ;;
		factor) echo "$p $bin/busybox-amd64 seq 1000000000000 1000000020000 | $p $bin/coreutils --coreutils-prog=factor" ;;
		gzip) echo "$p $bin/busybox-amd64 gzip -9 -c $out/in" ;;
		bzip2) echo "$p $bin/busybox-amd64 bzip2 -9 -c $out/in" ;;
		sqlite) echo "$p $bin/sqlite3 :memory: 'with recursive c(x) as (select 1 union all select x+1 from c where x<100000) select count(*), sum(x*x) % 1000003 from c;'" ;;
		bash) echo "$p $bin/bash -c 'i=0; s=0; while [ \$i -lt 20000 ]; do s=\$((s+i*i%7)); i=\$((i+1)); done; echo \$s'" ;;
	esac
}
md() { md5sum | cut -c1-8; }
workloads="factor gzip bzip2 sqlite sha256 bash"
echo "| workload | native | product, epochs | product, no epochs |"
echo "| --- | --- | --- | --- |"
for w in $workloads; do
	native=$(sh -c "$(cmd "" "$w")" | md)
	after=$(sh -c "$(cmd "$out/plain-after" "$w")" | md)
	before=$(sh -c "$(cmd "$out/plain-before" "$w")" | md)
	echo "| $w | $native | $after | $before |"
	for arm in before after; do
		: > "$out/$w-$arm.count"
		KATYBUG_COUNT=$out/$w-$arm.count sh -c "$(cmd "$out/count-$arm" "$w") > /dev/null"
	done
done
echo
# every process's line of a run is summed; k = counts per 1,000 guest instructions
sum() {
	awk -v arm="$2" -v w="$1" '/^katybug count:/ { for (i = 3; i < NF; i += 2) s[$i] += $(i + 1) }
		/^katybug syscalls:/ { for (i = 3; i <= NF; i++) { split($i, kv, "="); sys[kv[1]] += kv[2] } }
		END { k = 1000 / s["insns"]; m = 1e6 / s["blocks"]
			printf "%s %s insns=%d blocks=%d", w, arm, s["insns"], s["blocks"]
			for (key in s) printf " %s=%d", key, s[key]
			n = 0; for (nr in sys) n += sys[nr]
			printf " sys=%d", n
			cred = sys[102] + sys[104] + sys[107] + sys[108] + sys[105] + sys[106] + sys[113] + sys[114] + sys[117] + sys[118] + sys[119] + sys[120]
			fd = sys[3] + sys[32] + sys[33] + sys[292] + sys[72] + sys[2] + sys[257] + sys[293] + sys[22]
			sock = 0; for (nr = 41; nr <= 55; nr++) sock += sys[nr]
			sock += sys[288] + sys[299] + sys[307]
			printf " cred=%d fd=%d sock=%d\n", cred, fd, sock }' "$out/$1-$2.count"
}
for w in $workloads; do
	for arm in before after; do sum "$w" "$arm"; done
done > "$out/sums.txt"
node --no-warnings --experimental-strip-types "$here/epochs.ts" "$out/sums.txt"
