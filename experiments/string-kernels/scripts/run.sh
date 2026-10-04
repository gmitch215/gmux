#!/usr/bin/env bash
# string kernels (KATYBUG_PRIM): each workload's guests run through one katybug build per link order
# (LAYOUTS rotations of the sources) with the kernels off, each alone and all on, and natively where
# the guest matches the host. Every sample is pinned to CPU and timed with the busy time of that core
# and of its SMT sibling and the load average beside it; a sample another process shared the core
# with runs again (TRIES), and one that stays shared is marked dirty. One TSV row per sample.
# usage: run.sh <out dir>   (CPU required; LAYOUTS=3 ROUNDS=2 TRIES=3 NATIVE_RUNS=15 ARCHES="x86_64
# aarch64" WORKLOADS=<file> ARMS="off strlen ..." (KATYBUG_PRIM names; all = the four string
# functions); LOCK=<dir> makes each sample hold that lock directory, waiting while
# another run has it; SRC builds from another copy of src/gmux/katybug)
# Needs build/katybug/transcript{,-aarch64} (tests/c/katybug/transcript.sh).
set -uo pipefail
here=$(cd "$(dirname "$0")" && pwd)
root=$(cd "$here/../../.." && pwd)
out=${1:?usage: run.sh <out dir>}
cpu=${CPU:?set CPU to the core the samples pin to}
mkdir -p "$out"
out=$(cd "$out" && pwd)
sib=$(tr ',-' '\n\n' < "/sys/devices/system/cpu/cpu$cpu/topology/thread_siblings_list" | grep -vx "$cpu" | head -1)
sib=${sib:-$cpu}
layouts=${LAYOUTS:-3} rounds=${ROUNDS:-2} tries=${TRIES:-3} native_runs=${NATIVE_RUNS:-15}
wl=${WORKLOADS:-$here/../workloads.txt}
srcs=("${SRC:-$root/src/gmux/katybug}"/*.c)
arms=(${ARMS:-off strlen memcmp strcmp memchr all})
knob() {
	case $1 in
		off) echo 0 ;;
		all) echo strlen,memcmp,strcmp,memchr ;;
		*) echo "$1" ;;
	esac
}
for ((l = 0; l < layouts; l++)); do
	s=$((l * ${#srcs[@]} / layouts))
	cc -std=c11 -D_DEFAULT_SOURCE -O2 -o "$out/bin-$l" "${srcs[@]:$s}" "${srcs[@]:0:$s}" -lm || exit 1
	for a in "${arms[@]}"; do
		printf '#!/bin/sh\nKATYBUG_PRIM=%s exec %s "$@"\n' "$(knob "$a")" "$out/bin-$l" > "$out/kb-$a-$l"
		chmod +x "$out/kb-$a-$l"
	done
done
[ -f "$out/in" ] || seq 1 200000 > "$out/in"
[ -f "$out/in30k" ] || seq 1 30000 > "$out/in30k"
# a sample's row: wall, cpu, core and sibling ms, load before and after, tries, dirty
sample() {
	local n=0 row shared
	while :; do
		lock
		row=$(taskset -c "$cpu" perl "$here/timeit.pl" "$cpu" "$sib" sh -c "cd $out && $1 > /dev/null 2>&1")
		unlock
		n=$((n + 1))
		shared=${row##*$'\t'}
		if [ "$shared" = 0 ] || [ $n -ge "$tries" ]; then
			printf '%s\t%s\t%s\n' "${row%$'\t'*}" "$n" "$shared"
			return
		fi
	done
}
unlock() {
	[ -n "${LOCK:-}" ] && [ -n "${held:-}" ] && rmdir "$LOCK" && held=
}
lock() {
	[ -z "${LOCK:-}" ] && return
	until mkdir "$LOCK" 2> /dev/null; do sleep 20; done
	held=1
}
trap unlock EXIT
printf 'arch\tworkload\tarm\tlayout\tround\twall\tcpu\tcore_ms\tsibling_ms\tload_before\tload_after\ttries\tdirty\n' > "$out/samples.tsv"
: > "$out/calls.txt"
host=$(uname -m)
for arch in ${ARCHES:-x86_64 aarch64}; do
	sfx=
	[ "$arch" = aarch64 ] && sfx=-aarch64
	export T=$root/build/katybug/transcript$sfx
	export U=$T/ubin
	while IFS='|' read -r name cmd; do
		# outputs first: every arm and the native run must print what off does
		for a in "${arms[@]}"; do
			sh -c "cd $out && ${cmd//@/$out/kb-$a-0}" > "$out/o-$a" 2> /dev/null
			cmp -s "$out/o-off" "$out/o-$a" || echo "# $arch $name: $a output differs from off" >&2
		done
		if [ "$arch" = "$host" ]; then
			sh -c "cd $out && ${cmd//@/}" > "$out/o-native" 2> /dev/null
			cmp -s "$out/o-off" "$out/o-native" || echo "# $arch $name: native output differs from off" >&2
		fi
		: > "$out/prim.log"
		KATYBUG_STATS=1 KATYBUG_PRIM_LOG=$out/prim.log sh -c "cd $out && ${cmd//@/$out/bin-0}" > /dev/null 2>&1
		printf '%s %s: %s\n' "$arch" "$name" "$(tail -1 "$out/prim.log" 2> /dev/null || echo none)" >> "$out/calls.txt"
		for ((r = 0; r < rounds; r++)); do
			for ((l = 0; l < layouts; l++)); do
				for a in "${arms[@]}"; do
					printf '%s\t%s\t%s\t%s\t%s\t' "$arch" "$name" "$a" "$l" "$r"
					sample "${cmd//@/$out/kb-$a-$l}"
				done
			done
		done >> "$out/samples.tsv"
		if [ "$arch" = "$host" ]; then
			for ((r = 0; r < native_runs; r++)); do
				printf '%s\t%s\tnative\t0\t%s\t' "$arch" "$name" "$r"
				sample "${cmd//@/}"
			done >> "$out/samples.tsv"
		fi
	done < "$wl"
done
