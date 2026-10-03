#!/usr/bin/env bash
# library thunks (KATYBUG_PRIM memcpy, memmove, memset on a dynamic glibc guest): bench.c at each
# op and size runs through one katybug build per link order (LAYOUTS rotations of the sources) with
# the thunks off and on, and natively. Samples are pinned to CPU and timed as string-kernels does
# (its timeit.pl: busy time of the core and its SMT sibling, load beside it, a shared core runs
# again up to TRIES then counts as dirty). One TSV row per sample, for string-kernels' report.ts.
# usage: run.sh <out dir>   (CPU required; LAYOUTS=3 ROUNDS=2 TRIES=3 NATIVE_RUNS=7
# OPS="c m s" SIZES="8 16 ..." BYTES=33554432 (the
# bytes each sample moves, within ITERS_MIN..ITERS_MAX calls); LOCK=<dir> makes each sample hold that
# lock directory, waiting while another run has it; SRC builds from another copy of
# src/gmux/katybug)
set -uo pipefail
here=$(cd "$(dirname "$0")" && pwd)
root=$(cd "$here/../../.." && pwd)
out=${1:?usage: run.sh <out dir>}
cpu=${CPU:?set CPU to the core the samples pin to}
mkdir -p "$out"
out=$(cd "$out" && pwd)
sib=$(tr ',-' '\n\n' < "/sys/devices/system/cpu/cpu$cpu/topology/thread_siblings_list" | grep -vx "$cpu" | head -1)
sib=${sib:-$cpu}
layouts=${LAYOUTS:-3} rounds=${ROUNDS:-2} tries=${TRIES:-3} native_runs=${NATIVE_RUNS:-7}
timeit=$here/../../string-kernels/scripts/timeit.pl
srcs=("${SRC:-$root/src/gmux/katybug}"/*.c)
arms=(off thunk)
gcc -O1 -fno-builtin -o "$out/bench" "$here/../bench.c" || exit 1
for ((l = 0; l < layouts; l++)); do
	s=$((l * ${#srcs[@]} / layouts))
	cc -std=c11 -D_DEFAULT_SOURCE -O2 -o "$out/bin-$l" "${srcs[@]:$s}" "${srcs[@]:0:$s}" -lm || exit 1
	printf '#!/bin/sh\nKATYBUG_PRIM=0 exec %s "$@"\n' "$out/bin-$l" > "$out/kb-off-$l"
	printf '#!/bin/sh\nKATYBUG_PRIM=memcpy,memmove,memset exec %s "$@"\n' "$out/bin-$l" > "$out/kb-thunk-$l"
	chmod +x "$out/kb-off-$l" "$out/kb-thunk-$l"
done
sample() {
	local n=0 row shared
	while :; do
		lock
		row=$(taskset -c "$cpu" perl "$timeit" "$cpu" "$sib" sh -c "cd $out && $1 > /dev/null 2>&1")
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
bytes=${BYTES:-33554432} imin=${ITERS_MIN:-20000} imax=${ITERS_MAX:-2000000}
for op in ${OPS:-c m s}; do
	for n in ${SIZES:-8 16 32 64 128 256 1024 4096 65536}; do
		it=$((bytes / n))
		[ $it -lt "$imin" ] && it=$imin
		[ $it -gt "$imax" ] && it=$imax
		name=$op-$n
		cmd="@ ./bench $op $n $it"
		for a in "${arms[@]}"; do
			sh -c "cd $out && ${cmd//@/$out/kb-$a-0}" > "$out/o-$a" 2> /dev/null
		done
		sh -c "cd $out && ${cmd//@/}" > "$out/o-native" 2> /dev/null
		cmp -s "$out/o-off" "$out/o-thunk" || echo "# $name: thunk output differs from off" >&2
		cmp -s "$out/o-off" "$out/o-native" || echo "# $name: native output differs from off" >&2
		: > "$out/prim.log"
		KATYBUG_STATS=1 KATYBUG_PRIM_LOG=$out/prim.log KATYBUG_PRIM=memcpy,memmove,memset \
			sh -c "cd $out && ${cmd//@/$out/bin-0}" > /dev/null 2>&1
		printf '%s: %s\n' "$name" "$(tail -1 "$out/prim.log" 2> /dev/null || echo none)" >> "$out/calls.txt"
		for ((r = 0; r < rounds; r++)); do
			for ((l = 0; l < layouts; l++)); do
				for a in "${arms[@]}"; do
					printf '%s\t%s\t%s\t%s\t%s\t' x86_64 "$name" "$a" "$l" "$r"
					sample "${cmd//@/$out/kb-$a-$l}"
				done
			done
		done >> "$out/samples.tsv"
		for ((r = 0; r < native_runs; r++)); do
			printf '%s\t%s\tnative\t0\t%s\t' x86_64 "$name" "$r"
			sample "${cmd//@/}"
		done >> "$out/samples.tsv"
	done
done
