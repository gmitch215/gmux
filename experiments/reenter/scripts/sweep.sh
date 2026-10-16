#!/usr/bin/env bash
# the timed sweep for the re-entry item: whole-workload tax of the rebased module (part0.ts), the crossing per direction
# without JavaScript (rt.ts), and the ladder's open and closed rungs on zlib (mixed.ts); lock and quiet reading per sample
# usage: sweep.sh <out dir>   (run from the repo root or a rig copy of it that holds build/batch/run4/B22)
# env: HOST (paisley-park | mac, default paisley-park), CPUS (taskset list, default 18,19), LOCK (default per host),
#      QUIET (quiet.sh path), P0_SAMPLES (9), RT_SAMPLES (12), C_SAMPLES (3), WAITS (2), LOCK_WAIT (seconds, 3600),
#      SMOKE=1 (one sample per cell, rounds 1, no lock), CELLS (default "p0 rt c")
# the done marker is <out dir>/done, written whatever the exit status
set -u
root=$(cd "$(dirname "$0")/../../.." && pwd)
cd "$root"
out=${1:?usage: sweep.sh <out dir>}
mkdir -p "$out"
host=${HOST:-paisley-park}
cpus=${CPUS:-18,19}
smoke=${SMOKE:-0}
if [ "$host" = mac ]; then lock=${LOCK:-$root/build/batch/mac-bench.lock}; else lock=${LOCK:-/tmp/paisley-timing.lock}; fi
quiet=${QUIET:-$root/build/batch/quiet.sh}
waits=${WAITS:-2}
lock_wait=${LOCK_WAIT:-3600}
cells=${CELLS:-"p0 rt c"}
b=${B22:-build/batch/run4/B22}
r5=${R5:-build/batch/run5/B22-2-a}
re=${WASM3_RE:-$b/out-reenter/wasm3.wasm}
gm=${WASM3_GM:-$r5/out-gm-reenter/wasm3.wasm}
native=${NATIVE_DIR:-$r5/native}
node="node --no-warnings --experimental-strip-types"
if [ "$host" != mac ]; then
	export NVM_DIR=$HOME/.nvm
	. "$NVM_DIR/nvm.sh" > /dev/null
	nvm use 26.10.0 > /dev/null
	pin="taskset -c $cpus"
else
	pin=
fi
scripts=experiments/reenter/scripts
log=$out/samples.tsv
[ -s "$log" ] || printf 'name\tcell\tquiet_before\tquiet_after\tload\trc\trows\n' > "$log"

reading() {
	if [ "$host" = mac ]; then
		echo "load $(sysctl -n vm.loadavg | awk '{print $2}')"
	else
		bash "$quiet" "$cpus" 1 | awk '{print $2}'
	fi
}

# sample <name> <cell> <expected rows> <row marker> <command...>
sample() {
	local name=$1 cell=$2 want=$3 marker=$4
	shift 4
	local n q0 q1 rc rows tries=0
	until [ "$smoke" = 1 ] || mkdir "$lock" 2> /dev/null; do
		sleep 20
		tries=$((tries + 1))
		[ $((tries * 20)) -gt "$lock_wait" ] && { echo "$name: lock not free in ${lock_wait}s" >> "$out/log"; return 2; }
	done
	q0=$(reading)
	if [ "$host" != mac ]; then
		for n in $(seq "$waits"); do
			awk -v q="$q0" 'BEGIN { exit !(q > 0.5) }' || break
			[ "$smoke" = 1 ] || rmdir "$lock"
			sleep 15
			until [ "$smoke" = 1 ] || mkdir "$lock" 2> /dev/null; do sleep 5; done
			q0=$(reading)
		done
	fi
	"$@" > "$out/$name.log" 2> "$out/$name.err"
	rc=$?
	q1=$(reading)
	[ "$smoke" = 1 ] || rmdir "$lock"
	rows=$(grep -c "$marker" "$out/$name.json" 2> /dev/null || true)
	[ "$rc" = 0 ] && [ "$rows" = "$want" ] || rc=${rc/#0/9}
	[ -s "$out/$name.json" ] || rc=9
	printf '%s\t%s\t%s\t%s\t%s\t%s\t%s\n' "$name" "$cell" "$q0" "$q1" "$(uptime | sed 's/.*load average[s]*: //' | cut -d, -f1)" "$rc" "$rows" >> "$log"
	echo "$(date -u +%FT%TZ) $name rc $rc rows $rows quiet $q0 -> $q1" >> "$out/log"
	return "$rc"
}

fails=0
cell() {
	if sample "$@"; then fails=0; else fails=$((fails + 1)); fi
	if [ "$fails" -ge 3 ]; then
		echo "three failed samples in a row" >> "$out/log"
		echo 2 > "$out/done"
		exit 2
	fi
}

p0n=${P0_SAMPLES:-9}
rtn=${RT_SAMPLES:-12}
cn=${C_SAMPLES:-3}
en=${E_SAMPLES:-9}
on=${O_SAMPLES:-3}
isn=${I_SAMPLES:-3}
mn=${M_SAMPLES:-3}
rounds=5
[ "$smoke" = 1 ] && { p0n=1; rtn=1; cn=1; en=1; on=1; isn=1; mn=1; rounds=1; }
echo "# sweep start $(date -u +%FT%TZ) host $host cpus $cpus node $(node --version) cells $cells" >> "$out/log"
# the guest memory item's cells: e (endpoint arms over the guest memory build, with mem0 and mem0-shared), en (native controls),
# o (open zlib rungs, old base form on the re-entry build against mem0 on the guest memory build), i (the all-interpreted rung,
# re-entry build against guest memory build), m (memory per arm, one fresh process each), x (x86-64 code counts, untimed work)
wantx() { [[ " $cells " == *" $1 "* ]]; }
cells_r5() {
	local i=$1 g how a v idx
	if wantx e && [ "$i" -le "$en" ]; then
		for g in zlib zstd; do
			cell "e-$g-$i" "e-$g" 9 '"variant"' $pin env PART0_WASM3="$gm" $node $scripts/part0.ts sample $r5/p0/$g/asm $rounds "$out/e-$g-$i.json"
		done
	fi
	if wantx en && [ "$i" -le "$en" ]; then
		for g in zlib zstd; do
			[ -x "$native/$g-O2" ] || { echo "no $native/$g-O2" >> "$out/log"; continue; }
			cell "en-$g-$i" "en-$g" 2 '"variant"' bash -c "$pin $native/$g-O2 O2 $rounds 2 > $out/en-$g-$i.json && $pin $native/$g-O3native O3native $rounds 2 >> $out/en-$g-$i.json"
		done
	fi
	if wantx o && [ "$i" -le "$on" ]; then
		for how in base mem0; do
			[ $((i % 2)) = 0 ] && how=$([ "$how" = base ] && echo mem0 || echo base)
			if [ "$how" = base ]; then
				cell "o-base-$i" o-base 7 '"rung"' $pin $node $scripts/mixed.ts run $r5/c/zlib-open $re $rounds direct "$out/o-base-$i.json"
			else
				cell "o-mem0-$i" o-mem0 7 '"rung"' $pin $node $scripts/mixed.ts run $r5/m0/zlib-open $gm $rounds direct "$out/o-mem0-$i.json"
			fi
		done
	fi
	if wantx i && [ "$i" -le "$isn" ]; then
		for g in zlib zstd; do
			for how in re gm; do
				[ $((i % 2)) = 0 ] && how=$([ "$how" = re ] && echo gm || echo re)
				if [ "$how" = re ]; then
					cell "i-$g-re-$i" "i-$g-re" 2 '"rung"' $pin $node $scripts/mixed.ts run $r5/p0/$g $re $rounds glued "$out/i-$g-re-$i.json"
				else
					cell "i-$g-gm-$i" "i-$g-gm" 2 '"rung"' $pin $node $scripts/mixed.ts run $r5/p0m/$g $gm $rounds glued "$out/i-$g-gm-$i.json"
				fi
			done
		done
	fi
	if wantx m && [ "$i" -le "$mn" ]; then
		for g in zlib zstd; do
			cell "m-$g-orig-$i" "m-$g-orig" 1 '"arm"' $pin $node $scripts/mem.ts $r5/p0/$g orig - "$out/m-$g-orig-$i.json"
			cell "m-$g-base-form-$i" "m-$g-base-form" 1 '"arm"' $pin $node $scripts/mem.ts $r5/p0/$g base-form $re "$out/m-$g-base-form-$i.json"
			cell "m-$g-shared-$i" "m-$g-shared" 1 '"arm"' $pin $node $scripts/mem.ts $r5/p0m/$g shared $gm "$out/m-$g-shared-$i.json"
		done
	fi
	if wantx x && [ "$i" = 1 ]; then
		for a in "zlib:12:longest_match" "zstd:114:ZSTD_RowFindBestMatch_noDict_5_4"; do
			g=${a%%:*}
			idx=${a#*:}
			idx=${idx%%:*}
			for v in orig rebased const0 mem0; do
				cell "x-$g-$v" "x-$g" 1 '"variant"' bash -c "$pin $node $scripts/part0.ts code $r5/p0/$g/asm $v $idx ${a##*:} > $out/x-$g-$v.json"
			done
		done
	fi
}
(
	max=$p0n
	[ "$rtn" -gt "$max" ] && max=$rtn
	[ "$cn" -gt "$max" ] && max=$cn
	[ "$en" -gt "$max" ] && max=$en
	[ "$on" -gt "$max" ] && max=$on
	for i in $(seq "$max"); do
		cells_r5 "$i"
		if [[ " $cells " == *" p0 "* ]] && [ "$i" -le "$p0n" ]; then
			for g in zlib zstd; do
				cell "p0-$g-$i" "p0-$g" 7 '"variant"' $pin $node $scripts/part0.ts sample $b/p0/$g/asm $rounds "$out/p0-$g-$i.json"
			done
		fi
		if [[ " $cells " == *" rt "* ]] && [ "$i" -le "$rtn" ]; then
			cell "rt-$i" rt 20 '"impl"' $pin $node $scripts/rt.ts sample $b/rt/wasm $b/out-reenter/wasm3.wasm $b/out-default1/wasm3.wasm "$i" "$out/rt-$i.json"
		fi
		if [[ " $cells " == *" c "* ]] && [ "$i" -le "$cn" ]; then
			for d in zlib-open:7 zlib-closed:12; do
				for how in glued direct; do
					cell "c-${d%%:*}-$how-$i" "c-${d%%:*}-$how" "${d##*:}" '"rung"' $pin $node $scripts/mixed.ts run $b/c/${d%%:*} $b/out-reenter/wasm3.wasm $rounds $how "$out/c-${d%%:*}-$how-$i.json"
				done
			done
		fi
	done
)
rc=$?
echo "# sweep end $(date -u +%FT%TZ)" >> "$out/log"
echo "$rc" > "$out/done"
