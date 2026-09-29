#!/usr/bin/env bash
# what share of a workload's hot memory accesses can keep one validated direct host offset, and why
# the rest cannot: a -DKB_HOT build dumps each workload's blocks and traces with run counts,
# provenance.ts follows every address through them, and a -DKB_COUNT build gives the mapping-changing
# syscalls against the block runs. Each workload's output is compared between the product build and
# the dumping build with the dump on.
# usage: provenance.sh <bin dir with busybox-amd64, coreutils, sqlite3> <out dir> [node]
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
root=$(cd "$here/../../.." && pwd)
bin=$(cd "$1" && pwd)
mkdir -p "$2"
out=$(cd "$2" && pwd)
node=${3:-node}
K=$root/src/gmux/katybug
build() { clang -std=c11 -D_DEFAULT_SOURCE -O2 "$@" -lm; }
build -o "$out/plain" "$K"/*.c
build -o "$out/hot" -DKB_HOT "$K"/*.c
build -o "$out/count" -DKB_COUNT "$K"/*.c
"$bin/busybox-amd64" seq 1 400000 > "$out/in"
cmd() {
	local p=$1
	case $2 in
		sha256) echo "$p $bin/coreutils --coreutils-prog=sha256sum $out/in" ;;
		factor) echo "$p $bin/busybox-amd64 seq 1000000000000 1000000020000 | $p $bin/coreutils --coreutils-prog=factor" ;;
		gzip) echo "$p $bin/busybox-amd64 gzip -9 -c $out/in" ;;
		bzip2) echo "$p $bin/busybox-amd64 bzip2 -9 -c $out/in" ;;
		sqlite) echo "$p $bin/sqlite3 :memory: 'with recursive c(x) as (select 1 union all select x+1 from c where x<100000) select count(*), sum(x*x) % 1000003 from c;'" ;;
	esac
}
dirs=()
echo "| workload | native | product build | dump build, dump off | dump build, dump on |"
echo "| --- | --- | --- | --- | --- |"
for w in factor gzip bzip2 sqlite sha256; do
	rm -rf "$out/hot-$w"
	mkdir -p "$out/hot-$w"
	md() { md5sum | cut -c1-8; }
	native=$(sh -c "$(cmd "" "$w")" | md)
	prod=$(sh -c "$(cmd "$out/plain" "$w")" | md)
	off=$(sh -c "$(cmd "$out/hot" "$w")" | md)
	on=$(KATYBUG_HOT=$out/hot-$w sh -c "$(cmd "$out/hot" "$w")" | md)
	echo "| $w | $native | $prod | $off | $on |"
	dirs+=("$out/hot-$w")
	: > "$out/$w.count"
	KATYBUG_COUNT=$out/$w.count sh -c "$(cmd "$out/count" "$w") > /dev/null"
done
echo
echo "| workload | guest instructions | block runs | mmap | munmap | mprotect | mremap | brk | mapping changes per million block runs |"
echo "| --- | --- | --- | --- | --- | --- | --- | --- | --- |"
for w in factor gzip bzip2 sqlite sha256; do
	awk -v w="$w" '/^katybug count:/ { for (i = 3; i < NF; i += 2) s[$i] += $(i + 1) }
		/^katybug syscalls:/ { for (i = 3; i <= NF; i++) { split($i, kv, "="); sys[kv[1]] += kv[2] } }
		END { n = sys[9] + sys[11] + sys[10] + sys[25] + sys[12]
			printf "| %s | %d | %d | %d | %d | %d | %d | %d | %.2f |\n", w, s["insns"], s["blocks"], sys[9], sys[11], sys[10], sys[25], sys[12], 1e6 * n / s["blocks"] }' "$out/$w.count"
done
echo
"$node" --no-warnings --experimental-strip-types "$here/provenance.ts" "${dirs[@]}"
