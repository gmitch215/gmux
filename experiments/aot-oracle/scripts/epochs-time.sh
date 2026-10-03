#!/usr/bin/env bash
# native x86-64 time of the product builds epochs.sh made, with and without the epoch guard: each
# workload runs ROUNDS times per arm on one pinned core, the arm that goes first alternating, and the
# load average is printed beside every sample. Native Linux, not the wasm build under V8.
# usage: CORE=<cpu> ROUNDS=<n> epochs-time.sh <bin dir with busybox-amd64, coreutils, sqlite3, bash> <out dir of epochs.sh>
set -euo pipefail
bin=$(cd "$1" && pwd)
out=$(cd "$2" && pwd)
core=${CORE:?set CORE to an idle cpu}
rounds=${ROUNDS:-5}
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
ms() {
	local from=${EPOCHREALTIME/./}
	sh -c "$1" > /dev/null 2>&1
	echo $(((${EPOCHREALTIME/./} - from) / 1000))
}
for w in factor gzip bzip2 sqlite sha256 bash; do
	for ((r = 0; r < rounds; r++)); do
		arms="before after"
		((r % 2)) && arms="after before"
		for arm in $arms; do
			load=$(cut -d' ' -f1 /proc/loadavg)
			echo "$w $arm $(ms "$(cmd "taskset -c $core $out/plain-$arm" "$w")") load=$load"
		done
	done
done
