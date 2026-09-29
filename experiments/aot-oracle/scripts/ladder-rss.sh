#!/usr/bin/env bash
# peak resident KiB (GNU time) of the ladder's arms, the interpreter alone and the binary itself, on the
# builds ladder.sh left in <out dir> (scale-1 workloads; for factor, the factor process, not seq)
# usage: ladder-rss.sh <bin dir with busybox-amd64, coreutils, sqlite3> <out dir>
set -euo pipefail
bin=$(cd "$1" && pwd)
out=$(cd "$2" && pwd)
run() { # program, workload
	local p=$1
	case $2 in
		sha256) /usr/bin/time -f %M $p "$bin/coreutils" --coreutils-prog=sha256sum "$out/in-1" 2>&1 > /dev/null ;;
		factor) "$bin/busybox-amd64" seq 1000000000000 1000000020000 | /usr/bin/time -f %M $p "$bin/coreutils" --coreutils-prog=factor 2>&1 > /dev/null ;;
		sqlite) /usr/bin/time -f %M $p "$bin/sqlite3" :memory: 'with recursive c(x) as (select 1 union all select x+1 from c where x<100000) select count(*), sum(x*x) % 1000003 from c;' 2>&1 > /dev/null ;;
	esac
}
echo "| workload | arm | peak RSS KiB of the timed process |"
echo "| --- | --- | --- |"
for w in sha256 factor sqlite; do
	echo "| $w | native | $(run '' "$w" | tail -n 1) |"
	echo "| $w | plain | $(run "$out/plain" "$w" | tail -n 1) |"
	for a in A B B0 C C0 D E; do
		echo "| $w | $a | $(run "$out/$a-$w" "$w" | tail -n 1) |"
	done
done
