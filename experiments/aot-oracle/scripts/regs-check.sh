#!/usr/bin/env bash
# the x86-64 guests of tests/c/katybug lifted whole (every block they run) in both forms of lift.ts
# --regs --slots, run with KATYBUG_REGS=0, 1 and 2: stdout and exit status must equal the interpreter's
# (and x86-regs.expected for that guest). LIFT_MUTATE=noguard or nowrite builds the slots form unsound on
# purpose: the slots guest must then fail with regs=2. KB_EPOCH=1 builds the regions' runtime with the epoch
# guard (-DKB_EPOCH=1) and lifts with --epochs; EPOCHS=0 lifts without it (the interpreter's guard alone).
# LIFT_FLAGS adds lift.ts flags (--only=2, which builds one form, so the three runs repeat it).
# CC (cc) and CC_EXTRA (-DKB_IDENTITY) set the host build; PREBUILT=1 uses the guests already in the out dir.
# usage: [KB_EPOCH=1] [EPOCHS=0] [LIFT_FLAGS=--only=2] regs-check.sh <out dir> [guest...]
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
root=$(cd "$here/../../.." && pwd)
mkdir -p "$1"
out=$(cd "$1" && pwd)
shift
llvm=${LLVM:-/opt/homebrew/opt/llvm/bin}
node=${NODE:-node}
T=$root/tests/c/katybug
K=$root/src/gmux/katybug
cc="${CC:-cc} -std=c11 -D_DEFAULT_SOURCE -D_DARWIN_C_SOURCE -O1 ${CC_EXTRA:-}"
flags=(--target=x86_64-linux-gnu -nostdlib -static -fuse-ld=lld -O2 -ffreestanding -fno-stack-protector -fno-builtin)
source_of() {
	case $1 in faults) echo x86-faults.c ;; prim) echo prim-faults.c ;; regs) echo x86-regs.c ;; slots) echo x86-slots.c ;; flags) echo x86-flags.c ;; *) echo "$1.c" ;; esac
}
flags_of() {
	case $1 in regs) echo "" ;; slots) echo "-mno-sse -mno-mmx -mno-red-zone" ;; prim) echo "-I$T -mno-sse -mno-mmx -mno-red-zone" ;; epochs) echo "-Wl,-N -mno-sse -mno-mmx" ;; *) echo "-mno-sse -mno-mmx" ;; esac
}
epoch_cc=
epoch_lift=
[ "${KB_EPOCH:-0}" = 1 ] && epoch_cc=-DKB_EPOCH=1
[ "${EPOCHS:-${KB_EPOCH:-0}}" = 1 ] && epoch_lift=--epochs
guests=("$@")
[ "${#guests[@]}" -gt 0 ] || guests=(guest signals faults prim returns pieces fds regs slots epochs flags)
$cc -o "$out/hot" -DKB_HOT "$K"/*.c -lm
$cc -o "$out/plain" "$K"/*.c -lm
failed=0
ulimit -S -t 120
for g in "${guests[@]}"; do
	[ -n "${PREBUILT:-}" ] || "$llvm/clang" "${flags[@]}" $(flags_of "$g") -o "$out/$g" "$T/$(source_of "$g")"
	mkdir -p "$out/hot-$g"
	rm -f "$out/hot-$g"/*.hot
	KATYBUG_HOT=$out/hot-$g "$out/hot" "$out/$g" > /dev/null 2>&1 || true
	"$node" --no-warnings --experimental-strip-types "$here/lift.ts" --temps --windows --regs --slots $epoch_lift ${LIFT_FLAGS:-} "$out/aot-$g.c" 1 "$out/hot-$g"/*.hot 2> "$out/lift-$g.log"
	(ulimit -S -t unlimited; $cc $epoch_cc -DKB_AOT -I"$K" -I"$here/../src" -o "$out/aot-$g" "$K"/*.c "$out/aot-$g.c" -lm)
	rc=0
	"$out/plain" "$out/$g" > "$out/$g.want" 2> /dev/null || rc=$?
	if [ "$g" = epochs ] && grep -q ' FAIL' "$out/$g.want"; then
		echo "FAIL $g: the interpreter alone reports a failing case"
		failed=1
	fi
	for regs in 0 1 2; do
		got=0
		KATYBUG_REGS=$regs "$out/aot-$g" "$out/$g" > "$out/$g.got$regs" 2> /dev/null || got=$?
		if cmp -s "$out/$g.want" "$out/$g.got$regs" && [ "$got" = "$rc" ]; then
			echo "PASS $g regs=$regs (exit $rc, $(wc -c < "$out/$g.want") bytes)"
		else
			echo "FAIL $g regs=$regs (exit $got, want $rc)"
			failed=1
		fi
	done
	# the slots guest's cases one by one, so a failure names the condition
	if [ "$g" = slots ]; then
		for c in esc cal sig wid vec flt; do
			"$out/plain" "$out/$g" $c > "$out/$g.want.$c" 2> /dev/null || true
			for regs in 0 1 2; do
				(ulimit -S -t 20; KATYBUG_REGS=$regs "$out/aot-$g" "$out/$g" $c > "$out/$g.got$regs.$c" 2> /dev/null) 2> /dev/null || true
				if cmp -s "$out/$g.want.$c" "$out/$g.got$regs.$c"; then
					echo "PASS $g $c regs=$regs"
				else
					echo "FAIL $g $c regs=$regs"
					failed=1
				fi
			done
		done
	fi
done
exit $failed
