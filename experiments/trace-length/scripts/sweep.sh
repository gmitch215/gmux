#!/usr/bin/env bash
# katybug builds as arms (fusion, chaining, trace length), each workload's x86-64 and AArch64
# guests run natively on this host through each: blocks dispatched, side exits, ops executed,
# block-cache lookups and ops held from KATYBUG_STATS, then wall and CPU time. Link order moves a
# build's time by a few percent on its own, so every build links in LAYOUTS orders (the sources
# rotated); a layout's time is the minimum of ROUNDS runs, with arms and layouts interleaved, and
# an arm's time is the mean over its layouts, with spread = (slowest - fastest layout) / mean.
# Outputs must match across arms. One TSV row per arch, workload and arm.
# usage: sweep.sh <out dir> [name=cflags[|ENV=value ...]]...  (ROUNDS=2, LAYOUTS=3,
# ARCHES="x86_64 aarch64"; the default arms are the trace-length sweep, the traces one build with
# KATYBUG_SEGMENTS). Needs build/katybug/transcript{,-aarch64} (tests/c/katybug/transcript.sh).
# KATYBUG_SRC builds from another copy of src/gmux/katybug; WORKLOADS replaces the four programs.
set -uo pipefail
here=$(cd "$(dirname "$0")" && pwd)
root=$(cd "$here/../../.." && pwd)
out=${1:?usage: sweep.sh <out dir> [name=cflags]...}
shift
[ $# -gt 0 ] || set -- "base=-DKB_FUSE=0 -DKB_CHAIN=0 -DKB_TRACE=1" "chain=-DKB_FUSE=0 -DKB_TRACE=1" \
	"fuse=-DKB_TRACE=1" "t2=|KATYBUG_SEGMENTS=2" "t4=|KATYBUG_SEGMENTS=4" "t8=|KATYBUG_SEGMENTS=8" \
	"t16=|KATYBUG_SEGMENTS=16" "t32=|KATYBUG_SEGMENTS=32" "t64=|KATYBUG_SEGMENTS=64"
layouts=${LAYOUTS:-3}
mkdir -p "$out"
out=$(cd "$out" && pwd)
srcs=("${KATYBUG_SRC:-$root/src/gmux/katybug}"/*.c)
names=() builds=()
for spec in "$@"; do
	n=${spec%%=*} flags=${spec#*=} env=
	case $flags in *"|"*) env=${flags#*|} flags=${flags%%|*} ;; esac
	names+=("$n")
	k=0
	while [ $k -lt ${#builds[@]} ] && [ "${builds[$k]}" != "$flags" ]; do k=$((k + 1)); done
	for ((l = 0; l < layouts; l++)); do
		if [ $k -eq ${#builds[@]} ]; then
			s=$((l * ${#srcs[@]} / layouts))
			# shellcheck disable=SC2086
			cc -std=c11 -D_DEFAULT_SOURCE -D_DARWIN_C_SOURCE -O2 $flags -o "$out/bin-$k-$l" \
				"${srcs[@]:$s}" "${srcs[@]:0:$s}" -lm || exit 1
		fi
		printf '#!/bin/sh\n%s exec %s "$@"\n' "$env" "$out/bin-$k-$l" > "$out/kb-$n-$l"
		chmod +x "$out/kb-$n-$l"
	done
	[ $k -eq ${#builds[@]} ] && builds+=("$flags")
done
[ -f "$out/in" ] || seq 1 200000 > "$out/in"
# WORKLOADS=<file> of name|@ command lines replaces the four (an {arch} in a line becomes x86_64 or aarch64)
workloads() {
	if [ -n "${WORKLOADS:-}" ]; then
		sed "s/{arch}/$arch/g" "$WORKLOADS"
		return
	fi
	cat << EOF
sqlite|@ $U/sqlite3 :memory: 'with recursive c(x) as (select 1 union all select x+1 from c where x<200000) select count(*), sum(x*x) % 1000003 from c;'
bash|@ $U/bash -c 'i=0; s=0; while [ \$i -lt 20000 ]; do s=\$((s+i*i%7)); i=\$((i+1)); done; echo \$s'
awk|@ $T/busybox awk '{s += \$1 * 3} END {print s}' in
sort|@ $U/coreutils --coreutils-prog=sort -r in
EOF
}
stat() { (grep -ho "$1" "$2" || true) | awk -v f="$3" '{s += $f} END {print s + 0}'; }
printf 'arch\tworkload\tarm\tblocks\texits\tops\tlookups\theld\tseconds\tcpu\tspread\n'
for arch in ${ARCHES:-x86_64 aarch64}; do
	sfx=
	[ "$arch" = aarch64 ] && sfx=-aarch64
	T=$root/build/katybug/transcript$sfx
	U=$T/ubin
	while IFS='|' read -r wl cmd; do
		ref=
		for n in "${names[@]}"; do
			e=$out/e-$n
			KATYBUG_STATS=1 sh -c "cd $out && ${cmd//@/$out/kb-$n-0}" > "$out/o-$n" 2> "$e"
			[ -z "$ref" ] && ref=$n
			cmp -s "$out/o-$ref" "$out/o-$n" || echo "# $arch $wl: $n output differs from $ref" >&2
			printf '%s\t%s\t%s\t%s\t%s' "$(stat '[0-9]* blocks;' "$e" 1)" "$(stat '[0-9]* side exits' "$e" 1)" \
				"$(stat 'of [0-9]* ops run' "$e" 2)" "$(stat '[0-9]* lookups' "$e" 1)" \
				"$(stat 'and [0-9]* ops held' "$e" 2)" > "$out/row-$n"
			for ((l = 0; l < layouts; l++)); do echo 999 999 > "$out/best-$n-$l"; done
		done
		for ((r = 0; r < ${ROUNDS:-2}; r++)); do
			for ((l = 0; l < layouts; l++)); do
				for n in "${names[@]}"; do
					[ -n "${LOADLOG:-}" ] && echo "$arch $wl $n $l $r $(sysctl -n vm.loadavg)" >> "$LOADLOG"
					# wall, then user + sys of the run's processes (another job on the host moves the first)
					t=$(perl -MTime::HiRes=time -e '$s = time; system(@ARGV);
						@c = times; printf "%.3f %.3f", time - $s, $c[2] + $c[3]' \
						sh -c "cd $out && ${cmd//@/$out/kb-$n-$l} > /dev/null 2>&1")
					echo "$t $(cat "$out/best-$n-$l")" |
						awk '{print ($1 < $3 ? $1 : $3), ($2 < $4 ? $2 : $4)}' > "$out/best-$n-$l.new"
					mv "$out/best-$n-$l.new" "$out/best-$n-$l"
				done
			done
		done
		for n in "${names[@]}"; do
			printf '%s\t%s\t%s\t%s\t' "$arch" "$wl" "$n" "$(cat "$out/row-$n")"
			for ((l = 0; l < layouts; l++)); do cat "$out/best-$n-$l"; done | awk '
				{w += $1; c += $2; if (NR == 1 || $2 < lo) lo = $2; if ($2 > hi) hi = $2}
				END {printf "%.3f\t%.3f\t%.4f\n", w / NR, c / NR, c ? (hi - lo) / (c / NR) : 0}'
		done
	done < <(workloads)
done
