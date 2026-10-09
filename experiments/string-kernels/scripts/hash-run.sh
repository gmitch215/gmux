#!/usr/bin/env bash
# md5sum, sha1sum, sha256sum, sha512sum and cksum of 0 bytes, 1, 64 and 512 MiB under native Katybug with the kernel off and on,
# against the same static coreutils run natively; one sample is one run under LOCK on CPU, with quiet.sh read
# before and after (above 0.5 the sample is a smoke run) and its output compared with the native digest
# usage: CPU=13 LOCK=/tmp/paisley-timing.lock QUIET=<quiet.sh> COREUTILS=<static x86-64 coreutils> hash-run.sh <out dir>
# LAYOUTS (3) link orders of the katybug sources and REPS (5) samples each; LAYOUTS=1 REPS=1 is the smoke run;
# a sample waits up to WAITS (8) times 15 s for a quiet reading of 0.5 or less before it runs anyway;
# ONLY="tool:input:arm ..." keeps those cells; a failed check ends its cell, three in a row end the sweep;
# the sweep ends with <out dir>/done holding its status, the kernel arm's calls are in <out dir>/equal.txt
set -uo pipefail
here=$(cd "$(dirname "$0")" && pwd)
root=$(cd "$here/../../.." && pwd)
out=${1:?usage: hash-run.sh <out dir>}
cpu=${CPU:?set CPU}
cu=${COREUTILS:?set COREUTILS}
lock=${LOCK:?set LOCK}
quiet=${QUIET:?set QUIET to quiet.sh}
layouts=${LAYOUTS:-3} reps=${REPS:-5} waits=${WAITS:-8} tries=3 limit=120
mkdir -p "$out"
out=$(cd "$out" && pwd)
sib=$(tr ',-' '\n\n' < "/sys/devices/system/cpu/cpu$cpu/topology/thread_siblings_list" | grep -vx "$cpu" | head -1)
sib=${sib:-$cpu}
srcs=("$root"/src/gmux/katybug/*.c)
for ((l = 0; l < layouts; l++)); do
	s=$((l * ${#srcs[@]} / layouts))
	cc -std=c11 -D_DEFAULT_SOURCE -O2 -o "$out/bin-$l" "${srcs[@]:$s}" "${srcs[@]:0:$s}" -lm || exit 1
done
# the input is AES-128-CTR keystream, key and iv all zero
gen() { openssl enc -aes-128-ctr -K 00000000000000000000000000000000 -iv 00000000000000000000000000000000 < /dev/zero 2> /dev/null | head -c "$1"; }
[ -f "$out/in0" ] || : > "$out/in0"
[ -f "$out/in1" ] || gen 1048576 > "$out/in1"
[ -f "$out/in64" ] || gen 67108864 > "$out/in64"
[ -f "$out/in512" ] || gen 536870912 > "$out/in512"
held=
unlock() {
	[ -n "$held" ] && rmdir "$lock"
	held=
}
trap unlock EXIT
prim() { # the kernel's name for a tool: md5sum is md5, cksum is cksum
	[ "$1" = cksum ] && echo cksum || echo "${1%sum}"
}
cmd() { # tool arm layout input
	local pre=
	case $2 in
		native) ;;
		off) pre="env KATYBUG_PRIM=0 $out/bin-$3 " ;;
		kernel) pre="env KATYBUG_PRIM=$(prim "$1") $out/bin-$3 " ;;
	esac
	echo "$pre$cu --coreutils-prog=$1 $4"
}
# the native digest line of every input, and what the other arms print: equal, and the kernel really ran
: > "$out/equal.txt"
precheck() { # tool
	local t=$1 i a n
	for i in in0 in1 in64 in512; do
		(cd "$out" && $(cmd "$t" native 0 "$i")) > "$out/exp-$t-$i" 2> /dev/null
		for a in off kernel; do
			[ "$i" = in512 ] && [ "$a" = off ] && continue
			rm -f "$out/prim.log"
			(cd "$out" && KATYBUG_STATS=1 KATYBUG_PRIM_LOG="$out/prim.log" $(cmd "$t" $a 0 "$i")) > "$out/o-check" 2> /dev/null
			n=$(grep -o "$(prim "$t") [0-9]*" "$out/prim.log" 2> /dev/null | tail -1 | cut -d' ' -f2)
			if cmp -s "$out/exp-$t-$i" "$out/o-check"; then
				echo "equal $t $i $a $(cut -c1-16 "$out/o-check") kernel calls ${n:-none}" >> "$out/equal.txt"
			else
				echo "DIFFERENT $t $i $a" >> "$out/equal.txt"
			fi
		done
	done
}
fails=0
sample() { # tool input arm layout: sets row, retried when the pinned core was shared
	local n=0 w=0 shared q0 q1 ok
	while :; do
		until mkdir "$lock" 2> /dev/null; do sleep 20; done
		held=1
		q0=$(bash "$quiet" "$cpu" 1 | cut -d' ' -f2)
		if awk -v q="$q0" 'BEGIN { exit !(q > 0.5) }' && [ $w -lt $waits ]; then
			unlock
			w=$((w + 1))
			sleep 15
			continue
		fi
		row=$(taskset -c "$cpu" perl "$here/timeit.pl" "$cpu" "$sib" sh -c "cd $out && $(cmd "$1" "$3" "$4" "$2") > o-sample 2> /dev/null")
		q1=$(bash "$quiet" "$cpu" 1 | cut -d' ' -f2)
		unlock
		ok=0
		cmp -s "$out/o-sample" "$out/exp-$1-$2" && ok=1
		n=$((n + 1))
		shared=$(echo "$row" | cut -f7)
		if [ "$shared" = 0 ] || [ $n -ge $tries ]; then
			row=$(printf '%s\t%s\t%s\t%s\t%s' "$row" "$q0" "$q1" "$ok" "$n")
			return
		fi
	done
}
printf 'tool\tinput\tarm\tlayout\trep\twall\tcpu\tcore_ms\tsibling_ms\tload_before\tload_after\tdirty\tquiet_before\tquiet_after\tok\ttries\n' > "$out/samples.tsv"
cell() { # tool input arm layouts reps [stop after a first sample over this many seconds]
	local t=$1 i=$2 a=$3 nl=$4 nr=$5 l r
	[ -n "${ONLY:-}" ] && [[ " $ONLY " != *" $t:$i:$a "* ]] && return 0
	[ "$a" = native ] && nl=1
	for ((l = 0; l < nl; l++)); do
		for ((r = 0; r < nr; r++)); do
			sample "$t" "$i" "$a" "$l"
			printf '%s\t%s\t%s\t%s\t%s\t%s\n' "$t" "$i" "$a" "$l" "$r" "$row" >> "$out/samples.tsv"
			if [ "$(echo "$row" | cut -f10)" = 1 ]; then
				fails=0
			else
				fails=$((fails + 1))
				echo "failed check: $t $i $a layout $l rep $r" >&2
				[ $fails -ge 3 ] && return 1
				return 0
			fi
			[ -n "${6:-}" ] && [ "$(echo "$row" | cut -f1 | cut -d. -f1)" -ge "$6" ] && return 0
		done
	done
	return 0
}
status=0
for t in md5sum sha1sum sha256sum sha512sum cksum; do
	precheck $t
	grep -q "^DIFFERENT $t" "$out/equal.txt" && status=1 && break
	for i in in0 in1 in64; do
		for a in native off kernel; do cell $t $i $a "$layouts" "$reps" || status=1; done
	done
	cell $t in512 native "$layouts" "$reps" || status=1
	cell $t in512 kernel "$layouts" "$reps" || status=1
	# 512 MiB off stops after a sample that passes 120 s
	cell $t in512 off "$layouts" "$reps" $limit || status=1
	[ "$status" = 0 ] || break
done
echo $status > "$out/done"
exit $status
