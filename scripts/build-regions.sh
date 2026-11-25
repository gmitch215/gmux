#!/usr/bin/env bash
# lifts the hot blocks of the pinned userland programs into one region table for katybug's -DKB_AOT build
# usage: scripts/build-regions.sh <new directory> <directory with the programs>; JOBS=<n> sets the native builds' parallelism
# writes <directory>/aot.c, and nothing but SKIPPED when no program matches its pin in src/regions.json
set -euo pipefail
root=$(cd "$(dirname "$0")/.." && pwd)
out=${1:?usage: scripts/build-regions.sh <new directory> <directory with the programs>}
if [ -e "$out" ]; then
	echo "$out exists; the pipeline only builds into a new directory" >&2
	exit 1
fi
mkdir -p "$out"
out=$(cd "$out" && pwd)
cc=${CC:-clang}
cap=1048576
K=$root/src/gmux/katybug
F=$root/experiments/aot-oracle/scripts
ts() { "$root/scripts/ts" "$@"; }
sha() { if command -v sha256sum > /dev/null; then sha256sum; else shasum -a 256; fi; }
md() { sha | cut -c1-16; }
# GNU time reports a stage's largest process; elsewhere only the wall time is kept
gnu=
if /usr/bin/time -f %M true > /dev/null 2>&1; then gnu=1; fi
tm() { if [ -n "$gnu" ]; then /usr/bin/time -f %M -a -o "$out/.rss" "$@"; else "$@"; fi; }
stage() {
	local name=$1 t=$SECONDS
	: > "$out/.rss"
	"stage_$name"
	echo "$name: $((SECONDS - t)) s, peak $(sort -n "$out/.rss" | tail -1 | grep . || echo n/a) KiB" | tee -a "$out/stages.txt"
}
form() { case $1 in gzip) echo 2 ;; bzip2) echo 0 ;; *) echo 1 ;; esac }
program() { case $1 in gzip | bzip2) echo busybox-amd64 ;; sqlite) echo sqlite3 ;; bash) echo bash ;; esac }

if [ ! -d "${2:-}" ]; then
	echo "regions skipped: no program directory ${2:-}" | tee "$out/SKIPPED"
	exit 0
fi
bin=$(cd "$2" && pwd)
export bin out
# workloads.sh: cmd <command prefix> <workload> prints the workload's command line over $bin and $out
. "$F/workloads.sh"

works=()
: > "$out/programs.txt"
for w in gzip bzip2 sqlite bash; do
	p=$(program "$w")
	want=$(ts "$root/scripts/pin.ts" "$p" sha256)
	if [ ! -f "$bin/$p" ]; then
		echo "regions: $p is missing, the regions of $w are skipped" | tee -a "$out/SKIPPED"
	elif [ "$(sha < "$bin/$p" | cut -d' ' -f1)" != "$want" ]; then
		echo "regions: $p differs from its pin in src/regions.json, the regions of $w are skipped" | tee -a "$out/SKIPPED"
	else
		works+=("$w")
		echo "$p $want" >> "$out/programs.txt"
	fi
done
if [ "${#works[@]}" = 0 ]; then
	echo "regions: no program matches its pin, no table" | tee -a "$out/SKIPPED"
	exit 0
fi
has() {
	local w
	for w in "${works[@]}"; do [ "$w" = "$1" ] && return 0; done
	return 1
}
export SQLITE_ROWS=1000000
seq 1 400000 > "$out/in"
nat="-std=c11 -D_DEFAULT_SOURCE -O2"
lift="--temps --windows --regs --slots --calls --noinline --bounds=two --loop-guards --epochs"

# the interpreter's own output is the reference; two dumps of each workload under env -i are compared and the first is lifted
stage_dumps() {
	local w r a b
	tm $cc $nat -DKB_HOT -o "$out/hot" "$K"/*.c -lm &
	tm $cc $nat -o "$out/interp" "$K"/*.c -lm &
	if has bash; then tm $cc $nat -DKB_HOT -DKB_FUSE=0 -DKB_TRACE=1 -o "$out/fine" "$K"/*.c -lm & fi
	wait
	: > "$out/dumps.txt"
	: > "$out/want.txt"
	for w in "${works[@]}"; do
		for r in 1 2; do
			mkdir -p "$out/d$r/hot-$w"
			sh -c "$(cmd "env -i KATYBUG_SEGMENTS=1 KATYBUG_HOT=$out/d$r/hot-$w $out/hot" "$w")" > /dev/null
		done
		a=$(ls -S "$out/d1/hot-$w"/*.hot | head -1)
		b=$(ls -S "$out/d2/hot-$w"/*.hot | head -1)
		if cmp -s "$a" "$b"; then
			echo "$w: two dumps are byte-equal ($(wc -c < "$a") bytes)" >> "$out/dumps.txt"
		else
			echo "$w: two dumps differ ($(wc -c < "$a") and $(wc -c < "$b") bytes), the first is lifted" >> "$out/dumps.txt"
		fi
		echo "$w $(sh -c "$(cmd "env -i $out/interp" "$w")" | md)" >> "$out/want.txt"
	done
	if has bash; then
		mkdir -p "$out/d1/fine-bash"
		sh -c "$(cmd "env -i KATYBUG_HOT=$out/d1/fine-bash $out/fine" bash)" > /dev/null
	fi
}

stage_ranks() {
	local w hot r
	specs=()
	for w in "${works[@]}"; do
		hot=$(ls -S "$out/d1/hot-$w"/*.hot | head -1)
		if [ "$w" = bash ]; then
			while IFS= read -r r; do specs+=("$hot#1@$r"); done < <(tm "$root/scripts/ts" "$F/functions.ts" --emit-top=371 "$(ls -S "$out/d1/fine-bash"/*.hot | head -1)")
		else
			specs+=("$hot#$(form "$w")")
		fi
	done
	echo "${#specs[@]} regions" >> "$out/ranks.txt"
}

# a counting run of the census lift gives each checked access its mapping, and the final lift binds the table to them
stage_lift() {
	local w
	tm "$root/scripts/ts" "$F/lift.ts" $lift --classes "$out/aot-census.c" 0.999 "${specs[@]}" 2> "$out/lift-census.log"
	tm $cc $nat -I"$K" -DKB_AOT -DKB_COUNT -DKB_EPOCH=1 -DKB_FLAT=$cap -DAOT_CLASS -o "$out/census" "$K"/*.c "$out/aot-census.c" -lm
	: > "$out/census.count"
	for w in "${works[@]}"; do sh -c "$(cmd "env -i KATYBUG_COUNT=$out/census.count $out/census" "$w")" > /dev/null; done
	tm "$root/scripts/ts" "$F/lift.ts" $lift --flat="$out/census.count" "$out/aot.c" 0.999 "${specs[@]}" 2> "$out/lift.log"
	grep '^--flat:\|^wrote ' "$out/lift.log" > "$out/lift.txt"
	cat "$out/lift.txt"
}

# the table as it ships and once with counters: every workload prints what the interpreter prints, and the counts give the share
stage_check() {
	local w want got fail=0 insns lifted entries
	tm $cc $nat -I"$K" -DKB_AOT -DKB_EPOCH=1 -DKB_FLAT=$cap -o "$out/shipped" "$K"/*.c "$out/aot.c" -lm &
	tm $cc $nat -I"$K" -DKB_AOT -DKB_COUNT -DKB_EPOCH=1 -DKB_FLAT=$cap -o "$out/counted" "$K"/*.c "$out/aot.c" -lm &
	wait
	: > "$out/check.txt"
	for w in "${works[@]}"; do
		want=$(awk -v w="$w" '$1 == w { print $2 }' "$out/want.txt")
		got=$(sh -c "$(cmd "env -i $out/shipped" "$w")" | md)
		: > "$out/$w.count"
		sh -c "$(cmd "env -i KATYBUG_COUNT=$out/$w.count $out/counted" "$w")" > /dev/null
		insns=$(awk '/^katybug count:/ { for (i = 3; i < NF; i += 2) if ($i == "insns") n += $(i + 1) } END { print n + 0 }' "$out/$w.count")
		lifted=$(awk '/^katybug count:/ { for (i = 3; i < NF; i += 2) if ($i == "lifted") n += $(i + 1) } END { print n + 0 }' "$out/$w.count")
		entries=$(awk '/^katybug count:/ { for (i = 3; i < NF; i += 2) if ($i == "entries") n += $(i + 1) } END { print n + 0 }' "$out/$w.count")
		echo "$w exact $([ "$got" = "$want" ] && echo yes || echo NO) insns $insns lifted $lifted entries $entries" >> "$out/check.txt"
		[ "$got" = "$want" ] || fail=1
	done
	cat "$out/check.txt"
	[ "$fail" = 0 ] || {
		echo "regions: a lifted workload printed something else than the interpreter" >&2
		exit 1
	}
}

stage dumps
stage ranks
stage lift
stage check
echo "regions: $(wc -c < "$out/aot.c") bytes of C for ${works[*]} (programs.txt, dumps.txt, check.txt and stages.txt hold the record)"
