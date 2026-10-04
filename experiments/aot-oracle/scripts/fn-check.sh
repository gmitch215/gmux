#!/usr/bin/env bash
# the functions of the x86-64 guests of tests/c/katybug lifted (lift.ts, each function's symbol range), the rest
# interpreted, run with KATYBUG_REGS=0, 1 and 2: stdout and exit status must equal the interpreter's. Calls,
# returns, faults, signals and syscalls then cross the region boundary in both directions in every guest.
# REGIONS picks what is lifted: `each` (default) one function alone per build; `all` every function as its own
# region in one build, with direct calls between them (--calls); `holes` one build per function with every other
# function a region and that one interpreted, so a call enters and leaves the interpreter at every edge.
# AOT_OPT=-O0 builds the lifted C unoptimized (a build of every region is minutes at -O1).
# LIFT_FLAGS adds lift.ts flags (--noinline). KB_EPOCH=1 builds the runtime with the epoch guard
# (-DKB_EPOCH=1) and lifts with --epochs; EPOCHS=0 lifts without it.
# usage: [REGIONS=each|all|holes] [AOT_OPT=-O0] [LIFT_FLAGS=--noinline] [KB_EPOCH=1] fn-check.sh <out dir> [guest...]
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
root=$(cd "$here/../../.." && pwd)
mkdir -p "$1"
out=$(cd "$1" && pwd)
shift
llvm=${LLVM:-/opt/homebrew/opt/llvm/bin}
node=${NODE:-node}
mode=${REGIONS:-each}
T=$root/tests/c/katybug
K=$root/src/gmux/katybug
cc="cc -std=c11 -D_DEFAULT_SOURCE -D_DARWIN_C_SOURCE -O1"
flags=(--target=x86_64-linux-gnu -nostdlib -static -fuse-ld=lld -O2 -ffreestanding -fno-stack-protector -fno-builtin)
source_of() {
	case $1 in faults) echo x86-faults.c ;; prim) echo prim-faults.c ;; regs) echo x86-regs.c ;; slots) echo x86-slots.c ;; calls) echo x86-calls.c ;; index) echo x86-index.c ;; *) echo "$1.c" ;; esac
}
flags_of() {
	case $1 in regs) echo "" ;; slots | calls | index) echo "-mno-sse -mno-mmx -mno-red-zone" ;; prim) echo "-I$T -mno-sse -mno-mmx -mno-red-zone" ;; *) echo "-mno-sse -mno-mmx" ;; esac
}
epoch_cc=
epoch_lift=
[ "${KB_EPOCH:-0}" = 1 ] && epoch_cc=-DKB_EPOCH=1
[ "${EPOCHS:-${KB_EPOCH:-0}}" = 1 ] && epoch_lift=--epochs
guests=("$@")
[ "${#guests[@]}" -gt 0 ] || guests=(guest signals faults prim returns pieces fds regs slots calls index)
$cc -o "$out/hot" -DKB_HOT "$K"/*.c -lm
$cc -o "$out/plain" "$K"/*.c -lm
checked=0
passed=0
failed=0
ulimit -S -t 120
# lift the given dump specs into $f.c ($1 = stem, $2 = label, the rest are lift.ts arguments), build it, run its forms
check() {
	local f=$1 label=$2 g=$3
	shift 3
	"$node" --no-warnings --experimental-strip-types "$here/lift.ts" --temps --windows --regs --slots $epoch_lift ${LIFT_FLAGS:-} "$@" 2> "$f.log"
	grep -q ': 0 blocks in ' "$f.log" && return 0
	(ulimit -S -t unlimited; $cc ${AOT_OPT:-} $epoch_cc -DKB_AOT -I"$K" -I"$here/../src" -o "$f" "$K"/*.c "$f.c" -lm)
	for regs in 0 1 2; do
		got=0
		(ulimit -S -t 20; KATYBUG_REGS=$regs "$f" "$out/$g" > "$f.got$regs" 2> /dev/null) 2> /dev/null || got=$?
		checked=$((checked + 1))
		if cmp -s "$out/$g.want" "$f.got$regs" && [ "$got" = "$rc" ]; then
			passed=$((passed + 1))
		else
			failed=$((failed + 1))
			echo "FAIL $g $label regs=$regs (exit $got, want $rc)"
		fi
	done
	rm -f "$f" "$f.c" "$f.got0" "$f.got1" "$f.got2"
}
for g in "${guests[@]}"; do
	"$llvm/clang" "${flags[@]}" $(flags_of "$g") -o "$out/$g" "$T/$(source_of "$g")"
	mkdir -p "$out/hot-$g"
	rm -f "$out/hot-$g"/*.hot
	KATYBUG_HOT=$out/hot-$g "$out/hot" "$out/$g" > /dev/null 2>&1 || true
	rc=0
	"$out/plain" "$out/$g" > "$out/$g.want" 2> /dev/null || rc=$?
	# symbol, address, size of every function, in address order
	"$llvm/llvm-nm" -S -n --defined-only "$out/$g" | awk '$3 ~ /^[tT]$/ { print $4, $1, $2 }' > "$out/$g.funcs"
	# a region per function in one process's dump; the biggest dump is the guest's own process
	big=$(ls -S "$out/hot-$g"/*.hot | head -1)
	specs=()
	names=()
	while read -r name addr size <&3; do
		specs+=("$big@0x$addr-$(printf '0x%x' $((0x$addr + 0x$size)))")
		names+=("$name")
	done 3< "$out/$g.funcs"
	case $mode in
		each)
			while read -r name addr size <&3; do
				lo=0x$addr
				hi=$(printf '0x%x' $((lo + 0x$size)))
				check "$out/aot-$g-$name" "$name" "$g" --ranges="$lo-$hi" "$out/aot-$g-$name.c" 1 "$out/hot-$g"/*.hot
			done 3< "$out/$g.funcs"
			;;
		all)
			check "$out/aot-$g-all" all "$g" --calls "$out/aot-$g-all.c" 1 "${specs[@]}"
			;;
		holes)
			for i in "${!names[@]}"; do
				rest=("${specs[@]:0:i}" "${specs[@]:i+1}")
				[ "${#rest[@]}" -gt 0 ] || continue
				check "$out/aot-$g-${names[$i]}" "without ${names[$i]}" "$g" --calls "$out/aot-$g-${names[$i]}.c" 1 "${rest[@]}"
			done
			;;
	esac
	echo "$g: $checked runs so far, $passed pass, $failed fail"
done
echo "functions lifted ($mode): $checked runs, $passed PASS, $failed FAIL"
exit $((failed > 0))
