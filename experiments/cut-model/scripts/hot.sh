#!/usr/bin/env bash
# how many blocks the dispatches of each workload and sweep arm spread over, from katybug's KB_HOT
# build (one untimed run a workload and arm): the blocks held, and the fewest blocks that make up
# 50, 90, 99 and 99.9% of the dispatches, and the perplexity of the dispatch counts (e to the
# entropy: the number of equally busy blocks that would spread the dispatches as evenly).
# usage: hot.sh <out dir> <workloads file> [arm spec]...  (same arm specs and workload lines as
# counts.sh; prints TSV: arch workload arm held dispatches hot50 hot90 hot99 hot999 perp)
set -uo pipefail
here=$(cd "$(dirname "$0")" && pwd)
root=$(cd "$here/../../.." && pwd)
out=${1:?usage: hot.sh <out dir> <workloads file> [arm spec]...}
wl=${2:?usage: hot.sh <out dir> <workloads file> [arm spec]...}
shift 2
[ $# -gt 0 ] || set -- "base=-DKB_FUSE=0 -DKB_CHAIN=0 -DKB_TRACE=1" "chain=-DKB_FUSE=0 -DKB_TRACE=1" \
	"fuse=-DKB_TRACE=1" "t2=|KATYBUG_SEGMENTS=2" "t4=|KATYBUG_SEGMENTS=4" "t8=|KATYBUG_SEGMENTS=8" \
	"t16=|KATYBUG_SEGMENTS=16" "t32=|KATYBUG_SEGMENTS=32" "t64=|KATYBUG_SEGMENTS=64"
mkdir -p "$out"
out=$(cd "$out" && pwd)
srcs=("${KATYBUG_SRC:-$root/src/gmux/katybug}"/*.c)
[ -f "$out/in" ] || seq 1 200000 > "$out/in"
printf 'arch\tworkload\tarm\theld\tdispatches\thot50\thot90\thot99\thot999\tperp\n'
for spec in "$@"; do
	n=${spec%%=*} flags=${spec#*=} env=
	case $flags in *"|"*) env=${flags#*|} flags=${flags%%|*} ;; esac
	# shellcheck disable=SC2086
	cc -std=c11 -D_DEFAULT_SOURCE -D_DARWIN_C_SOURCE -O2 -DKB_HOT $flags -o "$out/kh-$n" "${srcs[@]}" -lm || exit 1
	for arch in ${ARCHES:-x86_64 aarch64}; do
		sfx=
		[ "$arch" = aarch64 ] && sfx=-aarch64
		T=$root/build/katybug/transcript$sfx
		U=$T/ubin
		while IFS='|' read -r w cmd; do
			d=$out/hot-$arch-$w-$n
			mkdir -p "$d"
			sh -c "cd $out && $env KATYBUG_HOT=$d ${cmd//@/$out/kh-$n}" > /dev/null 2>&1
			printf '%s\t%s\t%s\t' "$arch" "$w" "$n"
			cat "$d"/*.hot | grep '^block ' | sort -k6,6nr -s | awk '
				{ r[NR] = $6; t += $6 }
				END {
					split("0.5 0.9 0.99 0.999", p, " ")
					printf "%d\t%d", NR, t
					for (k = 1; k <= 4; k++) {
						c = 0
						for (i = 1; i <= NR && c < p[k] * t; i++) c += r[i]
						printf "\t%d", i - 1
					}
					for (i = 1; i <= NR; i++) e -= r[i] / t * log(r[i] / t)
					printf "\t%d\n", exp(e) + 0.5
				}'
		done < <(sed "s/{arch}/$arch/g; s|{T}|$T|g; s|{U}|$U|g" "$wl")
	done
done
