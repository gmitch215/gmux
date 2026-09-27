#!/usr/bin/env bash
# how often real programs ask for the time: static amd64 programs run under a -DKB_COUNT katybug (no
# vDSO, so every clock read is a syscall katybug counts), each workload's clock syscalls against its
# native run time, priced at a measured gmux syscall cost. Linux x86-64 host, clang.
# usage: callers.sh <bin dir with busybox-amd64, coreutils, sqlite3, bash, curl> <out dir> [ns per call]
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
root=$(cd "$here/../../.." && pwd)
bin=$(cd "$1" && pwd)
mkdir -p "$2"
out=$(cd "$2" && pwd)
ns=${3:-159}
clang -std=c11 -D_DEFAULT_SOURCE -O2 -DKB_COUNT -o "$out/katybug" "$root"/src/gmux/katybug/*.c -lm
"$bin/busybox-amd64" seq 1 400000 > "$out/in"
declare -A work=(
	[factor]="\$B/busybox-amd64 seq 1000000000000 1000000020000 | \$B/coreutils --coreutils-prog=factor > /dev/null"
	[gzip]="\$B/busybox-amd64 gzip -9 -c $out/in > $out/in.gz"
	[bzip2]="\$B/busybox-amd64 bzip2 -9 -c $out/in > $out/in.bz2"
	[sqlite]="\$B/sqlite3 :memory: 'with recursive c(x) as (select 1 union all select x+1 from c where x<100000) select count(*), sum(x*x) % 1000003 from c;' > /dev/null"
	[bash]="\$B/bash -c 'i=0; s=0; while [ \$i -lt 20000 ]; do s=\$((s+i*i%7)); i=\$((i+1)); done; echo \$s' > /dev/null"
	[curl]="\$B/curl -s file://$out/in -o $out/in.copy"
	[sha256]="\$B/coreutils --coreutils-prog=sha256sum $out/in > /dev/null"
)
TIMEFORMAT=%R
echo "| workload | native s | syscalls | clock_gettime | gettimeofday | time | clock share at ${ns} ns, of native time |"
echo "| --- | --- | --- | --- | --- | --- | --- |"
for w in factor gzip bzip2 sqlite bash curl sha256; do
	native=$({ time sh -c "B=$bin; ${work[$w]}"; } 2>&1)
	: > "$out/$w.count"
	KATYBUG_COUNT=$out/$w.count sh -c "B='$out/katybug $bin'; ${work[$w]}"
	awk -v w="$w" -v t="$native" -v ns="$ns" '/^katybug syscalls:/ {
			for (i = 3; i <= NF; i++) { split($i, kv, "="); s[kv[1]] += kv[2]; all += kv[2] }
		} END {
			c = s[228] + s[96] + s[201]
			printf "| %s | %.3f | %d | %d | %d | %d | %.4f%% |\n", w, t, all, s[228], s[96], s[201], 100 * c * ns / 1e9 / t
		}' "$out/$w.count"
done
