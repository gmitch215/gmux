#!/usr/bin/env bash
# each function of the x86-64 guests of tests/c/katybug lifted alone (lift.ts --ranges over the function's
# symbol), the rest interpreted, run with KATYBUG_REGS=0, 1 and 2: stdout and exit status must equal the
# interpreter's. Calls, returns, faults, signals and syscalls then cross the region boundary in both
# directions in every guest. usage: fn-check.sh <out dir> [guest...]
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
cc="cc -std=c11 -D_DEFAULT_SOURCE -D_DARWIN_C_SOURCE -O1"
flags=(--target=x86_64-linux-gnu -nostdlib -static -fuse-ld=lld -O2 -ffreestanding -fno-stack-protector -fno-builtin)
source_of() {
	case $1 in faults) echo x86-faults.c ;; prim) echo prim-faults.c ;; regs) echo x86-regs.c ;; slots) echo x86-slots.c ;; *) echo "$1.c" ;; esac
}
flags_of() {
	case $1 in regs) echo "" ;; slots) echo "-mno-sse -mno-mmx -mno-red-zone" ;; prim) echo "-I$T -mno-sse -mno-mmx -mno-red-zone" ;; *) echo "-mno-sse -mno-mmx" ;; esac
}
guests=("$@")
[ "${#guests[@]}" -gt 0 ] || guests=(guest signals faults prim returns pieces fds regs slots)
$cc -o "$out/hot" -DKB_HOT "$K"/*.c -lm
$cc -o "$out/plain" "$K"/*.c -lm
checked=0
passed=0
failed=0
ulimit -S -t 120
for g in "${guests[@]}"; do
	"$llvm/clang" "${flags[@]}" $(flags_of "$g") -o "$out/$g" "$T/$(source_of "$g")"
	mkdir -p "$out/hot-$g"
	rm -f "$out/hot-$g"/*.hot
	KATYBUG_HOT=$out/hot-$g "$out/hot" "$out/$g" > /dev/null 2>&1 || true
	rc=0
	"$out/plain" "$out/$g" > "$out/$g.want" 2> /dev/null || rc=$?
	# symbol, address, size of every function, in address order
	"$llvm/llvm-nm" -S -n --defined-only "$out/$g" | awk '$3 ~ /^[tT]$/ { print $4, $1, $2 }' > "$out/$g.funcs"
	while read -r name addr size <&3; do
		lo=0x$addr
		hi=$(printf '0x%x' $((lo + 0x$size)))
		f=$out/aot-$g-$name
		"$node" --no-warnings --experimental-strip-types "$here/lift.ts" --temps --windows --regs --slots --ranges="$lo-$hi" "$f.c" 1 "$out/hot-$g"/*.hot 2> "$f.log"
		grep -q ' region 0 blocks' "$f.log" && continue
		(ulimit -S -t unlimited; $cc -DKB_AOT -I"$K" -I"$here/../src" -o "$f" "$K"/*.c "$f.c" -lm)
		for regs in 0 1 2; do
			got=0
			(ulimit -S -t 20; KATYBUG_REGS=$regs "$f" "$out/$g" > "$f.got$regs" 2> /dev/null) 2> /dev/null || got=$?
			checked=$((checked + 1))
			if cmp -s "$out/$g.want" "$f.got$regs" && [ "$got" = "$rc" ]; then
				passed=$((passed + 1))
			else
				failed=$((failed + 1))
				echo "FAIL $g $name regs=$regs (exit $got, want $rc)"
			fi
		done
		rm -f "$f" "$f.c" "$f.got0" "$f.got1" "$f.got2"
	done 3< "$out/$g.funcs"
	echo "$g: $checked runs so far, $passed pass, $failed fail"
done
echo "functions lifted alone: $checked runs, $passed PASS, $failed FAIL"
exit $((failed > 0))
