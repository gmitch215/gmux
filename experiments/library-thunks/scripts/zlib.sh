#!/usr/bin/env bash
# zlib thunks (katybug -DKB_ZLIB; crc32, adler32, compress2, uncompress on a dynamic glibc guest): zbench.c at
# each op through one katybug build per link order (LAYOUTS rotations of the sources) with the zlib kernels
# off (the memory kernels stay on: glibc's memcpy stops at an SSE store katybug lacks without them) and on,
# and natively. Samples are pinned to CPU and timed as run.sh does (string-kernels' timeit.pl, a shared core
# runs again up to TRIES then counts as dirty; LOCK=<dir> makes each sample hold that lock directory). One
# TSV row per sample, for string-kernels' report.ts.
# usage: zlib.sh <out dir>   (CPU required; LAYOUTS=3 ROUNDS=2 TRIES=3 NATIVE_RUNS=7; ITERS_crc, ITERS_adl,
# ITERS_def, ITERS_inf set each op's calls per sample)
set -uo pipefail
here=$(cd "$(dirname "$0")" && pwd)
root=$(cd "$here/../../.." && pwd)
out=${1:?usage: zlib.sh <out dir>}
cpu=${CPU:?set CPU to the core the samples pin to}
mkdir -p "$out"
out=$(cd "$out" && pwd)
sib=$(tr ',-' '\n\n' < "/sys/devices/system/cpu/cpu$cpu/topology/thread_siblings_list" | grep -vx "$cpu" | head -1)
sib=${sib:-$cpu}
layouts=${LAYOUTS:-3} rounds=${ROUNDS:-2} tries=${TRIES:-3} native_runs=${NATIVE_RUNS:-7}
timeit=$here/../../string-kernels/scripts/timeit.pl
srcs=("${SRC:-$root/src/gmux/katybug}"/*.c)
keep=memcpy,memmove,memset,exp,log,pow
gcc -O1 -fno-builtin -o "$out/zbench" "$here/../zbench.c" -lz || exit 1
"$out/zbench" corpus "$out/corpus.bin" || exit 1
for ((l = 0; l < layouts; l++)); do
	s=$((l * ${#srcs[@]} / layouts))
	cc -std=c11 -D_DEFAULT_SOURCE -DKB_ZLIB -O2 -o "$out/bin-$l" "${srcs[@]:$s}" "${srcs[@]:0:$s}" -lm -lz || exit 1
	printf '#!/bin/sh\nKATYBUG_PRIM=%s exec %s "$@"\n' "$keep" "$out/bin-$l" > "$out/kb-off-$l"
	printf '#!/bin/sh\nexec %s "$@"\n' "$out/bin-$l" > "$out/kb-thunk-$l"
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
for op in ${OPS:-crc adl def inf}; do
	var=ITERS_$op
	it=${!var:-}
	if [ -z "$it" ]; then
		case $op in crc | adl) it=100 ;; def) it=3 ;; inf) it=30 ;; esac
	fi
	cmd="@ ./zbench run $op $it corpus.bin"
	for a in off thunk; do
		sh -c "cd $out && ${cmd//@/$out/kb-$a-0}" > "$out/o-$a" 2> /dev/null
	done
	sh -c "cd $out && ${cmd//@/}" > "$out/o-native" 2> /dev/null
	cmp -s "$out/o-off" "$out/o-thunk" || echo "# $op: thunk output differs from off" >&2
	cmp -s "$out/o-off" "$out/o-native" || echo "# $op: native output differs from off" >&2
	: > "$out/prim.log"
	KATYBUG_STATS=1 KATYBUG_PRIM_LOG=$out/prim.log sh -c "cd $out && ${cmd//@/$out/bin-0}" > /dev/null 2>&1
	printf '%s: %s\n' "$op" "$(tail -1 "$out/prim.log" 2> /dev/null || echo none)" >> "$out/calls.txt"
	for ((r = 0; r < rounds; r++)); do
		for ((l = 0; l < layouts; l++)); do
			for a in off thunk; do
				printf '%s\t%s\t%s\t%s\t%s\t' x86_64 "$op-$it" "$a" "$l" "$r"
				sample "${cmd//@/$out/kb-$a-$l}"
			done
		done
	done >> "$out/samples.tsv"
	for ((r = 0; r < native_runs; r++)); do
		printf '%s\t%s\tnative\t0\t%s\t' x86_64 "$op-$it" "$r"
		sample "${cmd//@/}"
	done >> "$out/samples.tsv"
done
