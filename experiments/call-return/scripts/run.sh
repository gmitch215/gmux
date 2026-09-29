#!/usr/bin/env bash
# the return stack is removed from katybug (it did not beat the noise); the on arm below needs a tree
# that still has it, so SRC must point at a copy from before the removal
# the return stack (KATYBUG_RAS=1): each workload's guests run through one katybug build per link order
# (LAYOUTS rotations of the sources) with the stack on (on), off (off) and off again (off2, the control:
# the spread between off and off2 is what a sample's noise is). Every sample is pinned to CPU and timed
# with the busy time of that core and of its SMT sibling and the load average beside it; a sample another
# process shared the core with runs again (TRIES), and one that stays shared is marked dirty. One TSV row
# per sample; calls.txt holds each workload's stack counters and block-cache lookups per arm.
# usage: run.sh <out dir>   (CPU required; LAYOUTS=3 ROUNDS=2 TRIES=3 ARCHES="x86_64 aarch64"
# WORKLOADS=<file>; GUESTS=<dir with x86_64/ and aarch64/> exports each arch's dir as G; NATIVE=1 adds a
# native arm for x86_64 and checks every output against it; LOCK=<dir> makes each sample hold that lock directory, waiting while another run
# has it; SRC builds from another copy of src/gmux/katybug)
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
layouts=${LAYOUTS:-3} rounds=${ROUNDS:-2} tries=${TRIES:-3}
wl=${WORKLOADS:-$here/../workloads.txt}
srcs=("${SRC:-$root/src/gmux/katybug}"/*.c)
arms=(off on off2)
knob() {
	case $1 in
		on) echo 1 ;;
		*) echo 0 ;;
	esac
}
for ((l = 0; l < layouts; l++)); do
	s=$((l * ${#srcs[@]} / layouts))
	cc -std=c11 -D_DEFAULT_SOURCE -O2 -o "$out/bin-$l" "${srcs[@]:$s}" "${srcs[@]:0:$s}" -lm || exit 1
	for a in "${arms[@]}"; do
		printf '#!/bin/sh\nKATYBUG_RAS=%s exec %s "$@"\n' "$(knob "$a")" "$out/bin-$l" > "$out/kb-$a-$l"
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
	until mkdir "$LOCK" 2> /dev/null; do sleep 0.2; done
	held=1
}
trap unlock EXIT
printf 'arch\tworkload\tarm\tlayout\tround\twall\tcpu\tcore_ms\tsibling_ms\tload_before\tload_after\ttries\tdirty\n' > "$out/samples.tsv"
: > "$out/calls.txt"
for arch in ${ARCHES:-x86_64 aarch64}; do
	sfx=
	[ "$arch" = aarch64 ] && sfx=-aarch64
	export T=$root/build/katybug/transcript$sfx
	export U=$T/ubin
	[ -n "${GUESTS:-}" ] && export G=$GUESTS/$arch
	sarms=("${arms[@]}")
	[ "$arch" = x86_64 ] && [ -n "${NATIVE:-}" ] && sarms+=(native)
	while IFS='|' read -r name cmd; do
		# outputs first: the stack on must print what it off does, and both what the x86-64 native run printed
		for a in off on; do
			sh -c "cd $out && ${cmd//@/$out/kb-$a-0}" > "$out/o-$a" 2> /dev/null
		done
		cmp -s "$out/o-off" "$out/o-on" || echo "# $arch $name: on output differs from off" >&2
		if [ "$arch" = x86_64 ] && [ -n "${NATIVE:-}" ]; then
			sh -c "cd $out && ${cmd//@ /}" > "$out/ref-$name" 2> /dev/null
		fi
		if [ -f "$out/ref-$name" ]; then
			cmp -s "$out/o-off" "$out/ref-$name" || echo "# $arch $name: off output differs from the native reference" >&2
			cmp -s "$out/o-on" "$out/ref-$name" || echo "# $arch $name: on output differs from the native reference" >&2
		fi
		for a in off on; do
			printf '%s %s %s: ' "$arch" "$name" "$a" >> "$out/calls.txt"
			KATYBUG_STATS=1 sh -c "cd $out && ${cmd//@/$out/kb-$a-0}" 2>&1 > /dev/null |
				grep -E 'lookups|ras ' | sed 's/.* \([0-9]* lookups\)/\1/' | paste -sd' ' >> "$out/calls.txt"
		done
		for ((r = 0; r < rounds; r++)); do
			for ((l = 0; l < layouts; l++)); do
				for a in "${sarms[@]}"; do
					printf '%s\t%s\t%s\t%s\t%s\t' "$arch" "$name" "$a" "$l" "$r"
					if [ "$a" = native ]; then sample "${cmd//@ /}"; else sample "${cmd//@/$out/kb-$a-$l}"; fi
				done
			done
		done >> "$out/samples.tsv"
	done < "$wl"
done
