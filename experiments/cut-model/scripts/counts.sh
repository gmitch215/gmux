#!/usr/bin/env bash
# the mapping refills (inline-cache misses that take the slow path) each workload takes under each
# sweep arm, from katybug's KB_COUNT build: one untimed run a workload and arm.
# usage: counts.sh <out dir> <workloads file> [arm spec]...  (same arm specs and workload lines as
# trace-length/scripts/sweep.sh, whose defaults apply; prints TSV: arch workload arm refills)
set -uo pipefail
here=$(cd "$(dirname "$0")" && pwd)
root=$(cd "$here/../../.." && pwd)
out=${1:?usage: counts.sh <out dir> <workloads file> [arm spec]...}
wl=${2:?usage: counts.sh <out dir> <workloads file> [arm spec]...}
shift 2
[ $# -gt 0 ] || set -- "base=-DKB_FUSE=0 -DKB_CHAIN=0 -DKB_TRACE=1" "chain=-DKB_FUSE=0 -DKB_TRACE=1" \
	"fuse=-DKB_TRACE=1" "t2=|KATYBUG_SEGMENTS=2" "t4=|KATYBUG_SEGMENTS=4" "t8=|KATYBUG_SEGMENTS=8" \
	"t16=|KATYBUG_SEGMENTS=16" "t32=|KATYBUG_SEGMENTS=32" "t64=|KATYBUG_SEGMENTS=64"
mkdir -p "$out"
out=$(cd "$out" && pwd)
srcs=("${KATYBUG_SRC:-$root/src/gmux/katybug}"/*.c)
[ -f "$out/in" ] || seq 1 200000 > "$out/in"
printf 'arch\tworkload\tarm\trefills\n'
for spec in "$@"; do
	n=${spec%%=*} flags=${spec#*=} env=
	case $flags in *"|"*) env=${flags#*|} flags=${flags%%|*} ;; esac
	# shellcheck disable=SC2086
	cc -std=c11 -D_DEFAULT_SOURCE -D_DARWIN_C_SOURCE -O2 -DKB_COUNT $flags -o "$out/kc-$n" "${srcs[@]}" -lm || exit 1
	for arch in ${ARCHES:-x86_64 aarch64}; do
		sfx=
		[ "$arch" = aarch64 ] && sfx=-aarch64
		T=$root/build/katybug/transcript$sfx
		U=$T/ubin
		while IFS='|' read -r w cmd; do
			rm -f "$out/count.txt"
			sh -c "cd $out && $env KATYBUG_COUNT=$out/count.txt ${cmd//@/$out/kc-$n}" > /dev/null 2>&1
			printf '%s\t%s\t%s\t%s\n' "$arch" "$w" "$n" "$(grep -o 'refills [0-9]*' "$out/count.txt" | awk '{print $2}')"
		done < <(sed "s/{arch}/$arch/g; s|{T}|$T|g; s|{U}|$U|g" "$wl")
	done
done
