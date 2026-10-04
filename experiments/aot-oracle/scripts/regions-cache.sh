#!/usr/bin/env bash
# lifted regions with the block cache (KATYBUG_CACHE) on, native x86-64 on a Linux host (gawk, readelf). Needs
# region.sh's output for gzip (its fnc arm: aot-fnc-gzip, the counting build, and run-fnc-gzip, the one to time; interp,
# the build with no regions), in region.sh's own out dir. Every row: decoded, blocks from the cache, lookups, traces,
# guest instructions, the lifted share, region entries, user and sys CPU, wall, and the output md5 against the
# reference's (the share and entries are counted only by the counting build; BUILD=run-fnc-gzip is the timing build and
# prints "-"). The exit status is 1 when a check fails.
# cold: runs 1 to 3 on one empty cache dir, with the default plan and with KATYBUG_SEGMENTS=1, and one run with no cache
# as the control. A warm run must enter the region as often and lift as large a share as the cold one.
# patch: a copy of the binary with one byte of a promoted block changed (PATCH_VA, default the shift count of the hash
# update in busybox's deflate). Reference: the patched copy run natively. The cache of the unpatched binary is run
# against it under its own name (a file for another ELF), renamed to the patched copy's name with the ELF hash in its
# header rewritten too (a stale file the first check accepts, so only the per-block code hash stands in the way), and
# no cache. Every output must be the patched copy's, and the region must hold fewer blocks (a lower lifted share).
# startup: wall per run of a tiny input, cold against warm, which is what decoding and attaching the blocks cost
# (run it under the host's timing lock, on a pinned core, with BUILD=run-fnc-gzip).
# usage: [BUILD=aot-fnc-gzip] regions-cache.sh <bin dir with busybox-amd64> <region.sh out dir> <out dir> [cold|patch|startup]
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
bin=$(cd "$1" && pwd)
out=$(cd "$2" && pwd)
mkdir -p "$3"
res=$(cd "$3" && pwd)
mode=${4:-cold}
build=${BUILD:-aot-fnc-gzip}
elf=$bin/busybox-amd64
md() { md5sum | cut -c1-8; }
reference() { "$@" gzip -9 -c "$out/in" | md; }
header="seq,run,decoded,cache,lookups,traces,insns,lifted,entries,user,sys,wall,output"
echo "$header"
echo "$header" > "$res/rows.csv"

# one row: a label, a run number, the expected output md5, the ELF, then env assignments for katybug
run() {
	local seq=$1 n=$2 want=$3 prog=$4
	shift 4
	local cnt=$res/$seq-$n.count err=$res/$seq-$n.err tm=$res/$seq-$n.time got st dec
	: > "$cnt"
	got=$(env "$@" KATYBUG_STATS=1 KATYBUG_COUNT="$cnt" /usr/bin/time -f '%U %S %e' -o "$tm" \
		"$out/$build" "$prog" gzip -9 -c "$out/in" 2> "$err" | md)
	[ "$got" = "$want" ] && got=exact || got="$got DIFFERS from $want"
	st=$(grep -o '[0-9]* traces' "$err" | cut -d' ' -f1)
	dec=$(grep -o '[0-9]* decoded, [0-9]* from the cache; [0-9]* lookups' "$err" | tr -d ',;' | awk '{print $1 "," $3 "," $7}')
	awk -v seq="$seq" -v n="$n" -v st="$st" -v dec="$dec" -v got="$got" -v tm="$tm" '/^katybug (count|aot):/ {
			for (i = 3; i < NF; i += 2) s[$i] += $(i + 1)
		} END {
			getline t < tm
			split(t, f, " ")
			lifted = s["insns"] ? sprintf("%.1f%%", 100 * s["lifted"] / s["insns"]) : "-"
			printf "%s,%s,%s,%s,%d,%s,%d,%s,%s,%s,%s\n", seq, n, dec, st, s["insns"], lifted, s["entries"], f[1], f[2], f[3], got
		}' "$cnt" | tee -a "$res/rows.csv"
}

# column c of the row for seq (and run n)
cell() { awk -F, -v s="$1" -v n="$2" -v c="$3" '$1 == s && $2 == n { print $c }' "$res/rows.csv"; }
failed=0
verdict() {
	if [ "$2" = ok ]; then echo "# PASS $1"; else echo "# FAIL $1"; failed=1; fi
}
ok() { if "$@"; then echo ok; else echo no; fi; }

want=$(reference "$elf")

if [ "$mode" = cold ]; then
	for seq in default segments1; do
		dir=$res/cache-$seq
		mkdir -p "$dir"
		extra=()
		[ "$seq" = segments1 ] && extra=(KATYBUG_SEGMENTS=1)
		for n in 1 2 3; do run "$seq" "$n" "$want" "$elf" KATYBUG_CACHE="$dir" "${extra[@]}" > /dev/null; done
		for n in 2 3; do
			same=no
			[ "$(cell $seq $n 9)" = "$(cell $seq 1 9)" ] && [ "$(cell $seq $n 8)" = "$(cell $seq 1 8)" ] && [ "$(cell $seq $n 4)" -gt 0 ] && same=ok
			verdict "$seq run $n: lifted share and region entries equal run 1, blocks from the cache" "$same"
		done
	done
	grep '^\(default\|segments1\)' "$res/rows.csv"
	run control 1 "$want" "$elf"
	run control-segments1 1 "$want" "$elf" KATYBUG_SEGMENTS=1
	[ -z "$(grep DIFFERS "$res/rows.csv")" ] || failed=1
fi

if [ "$mode" = patch ]; then
	va=${PATCH_VA:-0x54b86d}
	byte=${PATCH_BYTE:-04}
	patched=$res/busybox-patched
	cp "$elf" "$patched"
	off=$(readelf -lW "$elf" | awk -v va="$va" '$1 == "LOAD" { lo = strtonum($3); if (strtonum(va) >= lo && strtonum(va) < lo + strtonum($5)) print strtonum($2) + strtonum(va) - lo }')
	printf "\\x$byte" | dd of="$patched" bs=1 seek="$off" conv=notrunc 2> /dev/null
	echo "# patched $va (file offset $off): $(xxd -s "$off" -l 1 -p "$elf") -> $(xxd -s "$off" -l 1 -p "$patched")"
	pwant=$(reference "$patched")
	echo "# output md5: unpatched $want, patched natively $pwant, patched interpreted $(reference "$out/interp" "$patched")"
	[ "$want" != "$pwant" ] || verdict "the patch changes the output" no
	warm=$res/cache-warm
	mkdir -p "$warm"
	run unpatched-warm 1 "$want" "$elf" KATYBUG_CACHE="$warm" > /dev/null
	run unpatched-warm 2 "$want" "$elf" KATYBUG_CACHE="$warm" > /dev/null
	hu=$(basename "$(ls "$warm"/*.kbc)" .kbc)
	run patched-other-file 1 "$pwant" "$patched" KATYBUG_CACHE="$warm" > /dev/null
	hp=$(basename "$(ls "$warm"/*.kbc | grep -v "$hu")" .kbc)
	# the unpatched copy's file under the patched copy's name, its header's ELF hash rewritten to match
	stale=$res/cache-stale
	mkdir -p "$stale"
	cp "$warm/$hu.kbc" "$stale/$hp.kbc"
	printf "$(for i in 7 6 5 4 3 2 1 0; do printf '\\x%s' "${hp:$((2 * i)):2}"; done)" | dd of="$stale/$hp.kbc" bs=1 seek=16 conv=notrunc 2> /dev/null
	run patched-stale-file 1 "$pwant" "$patched" KATYBUG_CACHE="$stale" > /dev/null
	run patched-control 1 "$pwant" "$patched" > /dev/null
	sed 1d "$res/rows.csv"
	[ -z "$(grep DIFFERS "$res/rows.csv")" ] && verdict "every patched run prints the patched copy's output" ok || verdict "every patched run prints the patched copy's output" no
	for s in patched-other-file patched-stale-file patched-control; do
		verdict "$s: a lower lifted share than the unpatched run" "$(ok awk -v a="$(cell $s 1 8)" -v b="$(cell unpatched-warm 2 8)" 'BEGIN { exit !(a + 0 < b + 0) }')"
	done
	verdict "the stale file's blocks come from the cache" "$(ok test "$(cell patched-stale-file 1 4)" -gt 0)"
fi
if [ "$mode" = startup ]; then
	# a tiny input, so the run is the decode and attach of the blocks: wall per run, cold (no cache) against warm
	# (the file a first run left), with the binary itself for the process cost; REPS runs per sample, ROUNDS samples
	reps=${REPS:-50}
	rounds=${ROUNDS:-7}
	echo 1 > "$res/tiny"
	warm=$res/cache-startup
	mkdir -p "$warm"
	for n in 1 2; do KATYBUG_CACHE="$warm" "$out/$build" "$elf" gzip -9 -c "$res/tiny" > /dev/null 2>&1; done
	for arm in cold warm; do
		extra=()
		[ "$arm" = warm ] && extra=(KATYBUG_CACHE="$warm")
		env "${extra[@]}" KATYBUG_STATS=1 "$out/$build" "$elf" gzip -9 -c "$res/tiny" 2>&1 > /dev/null | grep -o '[0-9]* decoded, [0-9]* from the cache' | sed "s/^/# $arm: /"
	done
	echo "round,arm,ms per run,load1"
	sample() {
		local arm=$1 t0 t1
		shift
		t0=$(date +%s%N)
		for ((i = 0; i < reps; i++)); do "$@" > /dev/null 2>&1; done
		t1=$(date +%s%N)
		echo "$round,$arm,$(awk -v a="$t0" -v b="$t1" -v n="$reps" 'BEGIN { printf "%.2f", (b - a) / 1e6 / n }'),$(cut -d' ' -f1 /proc/loadavg)"
	}
	for ((round = 1; round <= rounds; round++)); do
		sample binary "$elf" gzip -9 -c "$res/tiny"
		sample cold "$out/$build" "$elf" gzip -9 -c "$res/tiny"
		sample warm env KATYBUG_CACHE="$warm" "$out/$build" "$elf" gzip -9 -c "$res/tiny"
	done | tee "$res/startup.csv"
	for arm in binary cold warm; do
		echo "# $arm median $(awk -F, -v a="$arm" '$2 == a { print $3 }' "$res/startup.csv" | sort -n | awk '{ v[NR] = $1 } END { print v[int((NR + 1) / 2)] }') ms, min $(awk -F, -v a="$arm" '$2 == a { print $3 }' "$res/startup.csv" | sort -n | head -1), max $(awk -F, -v a="$arm" '$2 == a { print $3 }' "$res/startup.csv" | sort -n | tail -1)"
	done
fi
exit $failed
