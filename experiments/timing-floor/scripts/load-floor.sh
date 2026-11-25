#!/usr/bin/env bash
# paired A/B timing of two identical arms on cpu 13 under four background conditions.
# run from the rig copy on paisley-park; one lock per sample; writes out/samples.tsv.
# usage: bash load-floor.sh          (SMOKE=1: one round, one sample per arm, out/smoke.tsv)
set -u
R=${R:-$(cd "$(dirname "$0")" && pwd)}
cd "$R" || exit 1
LOCK=/tmp/paisley-timing.lock
IN=/dev/shm/load-floor
CPU=13
MEMREPS=32
ROUNDS=${ROUNDS:-25}
PER=${PER:-5}
OUT=$R/out
TSV=$OUT/samples.tsv
LP=$OUT/loops.pids
LOG=$OUT/driver.log
if [ "${SMOKE:-0}" = 1 ]; then
	ROUNDS=1
	PER=1
	TSV=$OUT/smoke.tsv
	LP=$OUT/smoke-loops.pids
fi
mkdir -p "$OUT"
[ -s "$TSV" ] || printf 'cond\tcell\tround\tk\tarm\tseconds\trc\tquiet\tload1\n' > "$TSV"
HOLD=0
fails=0

stop_loops() {
	local p
	if [ -s "$LP" ]; then
		for p in $(cat "$LP"); do kill "$p" 2> /dev/null; done
		sleep 1
		echo "loops left after stop: $(ps -o pid= -p "$(paste -sd, "$LP")" 2> /dev/null | wc -l)" >> "$LOG"
	fi
	: > "$LP"
}

cleanup() {
	stop_loops
	if [ "$HOLD" = 1 ]; then rmdir "$LOCK" 2> /dev/null; HOLD=0; fi
}
trap cleanup EXIT

start_loops() {
	: > "$LP"
	local c
	case "$1" in
	base) ;;
	same)
		for c in 2 3 4; do taskset -c "$c" sha256sum < /dev/zero > /dev/null & echo $! >> "$LP"; done
		for c in 0 5 17; do taskset -c "$c" dd if=/dev/zero bs=64M of=/dev/null 2> /dev/null & echo $! >> "$LP"; done
		;;
	other)
		for c in 6 7 8; do taskset -c "$c" sha256sum < /dev/zero > /dev/null & echo $! >> "$LP"; done
		for c in 9 10 11; do taskset -c "$c" dd if=/dev/zero bs=64M of=/dev/null 2> /dev/null & echo $! >> "$LP"; done
		;;
	sib)
		taskset -c 1 sha256sum < /dev/zero > /dev/null & echo $! >> "$LP"
		;;
	esac
	sleep 2
}

loops_running() {
	[ -s "$LP" ] || { echo 0; return; }
	ps -o pid= -p "$(paste -sd, "$LP")" | wc -l
}

run_sample() {
	local cell=$1 a=$2 s e rc=0 k
	s=$EPOCHREALTIME
	if [ "$cell" = comp ]; then
		taskset -c "$CPU" "$R/$a/gzip" -1 -c "$IN/comp-$a.bin" > /dev/null || rc=$?
	else
		for k in $(seq "$MEMREPS"); do
			taskset -c "$CPU" "$R/$a/dd" bs=1M if="$IN/mem-$a.bin" of=/dev/null 2> /dev/null || rc=$?
		done
	fi
	e=$EPOCHREALTIME
	echo "$s $e $rc"
}

sample() {
	local cond=$1 cell=$2 r=$3 k=$4 a=$5 q load t rc secs
	until mkdir "$LOCK" 2> /dev/null; do sleep 5; done
	HOLD=1
	q=$(bash "$R/quiet.sh" "$CPU" | awk '{print $2}')
	load=$(cut -d' ' -f1 /proc/loadavg)
	t=$(run_sample "$cell" "$a")
	rmdir "$LOCK" 2> /dev/null
	HOLD=0
	secs=$(echo "$t" | awk '{printf "%.6f", $2 - $1}')
	rc=$(echo "$t" | awk '{print $3}')
	printf '%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\n' "$cond" "$cell" "$r" "$k" "$a" "$secs" "$rc" "$q" "$load" >> "$TSV"
	if [ "$rc" = 0 ]; then fails=0; else fails=$((fails + 1)); fi
	[ "$fails" -lt 3 ]
}

for cond in base same other sib; do
	start_loops "$cond"
	n=$(wc -l < "$LP")
	for r in $(seq "$ROUNDS"); do
		if [ "$(loops_running)" != "$n" ]; then
			echo "loops down before round $r of $cond; condition cut short" >> "$LOG"
			break
		fi
		for cell in comp mem; do
			if [ $((r % 2)) = 1 ]; then order="A B"; else order="B A"; fi
			for k in $(seq "$PER"); do
				for a in $order; do
					sample "$cond" "$cell" "$r" "$k" "$a" || { echo "three failed samples in a row; stopping" >> "$LOG"; exit 1; }
				done
			done
		done
	done
	stop_loops
done
echo "sweep done" >> "$LOG"
