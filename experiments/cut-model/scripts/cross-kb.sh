#!/usr/bin/env bash
# katybug's crossings priced one at a time (table), the block-cache lookup over working sets (ws), and
# the trace-length sweep the table then predicts (g28): all run through trace-length/scripts/sweep.sh's
# builds, from a copy of src/gmux/katybug (an existing <out dir>/katybug-src, else HEAD) so another
# session's edits cannot move a build between the modes. Each arch's sweep holds the bench lock, since
# another lane may be timing on this machine.
# ws2 times the dirh guests (blocks held and blocks dispatched over, all direct jumps) on the base and
# chain builds; ws3 times dirh guests that also hold trace-long blocks over every sweep arm.
# ws4 is ws2 with the cycle in decode order (dirs).
# usage: cross-kb.sh table|ws|ws2|ws3|ws4|g28 <out dir>  (ROUNDS=3, LAYOUTS=3, ARCHES="x86_64 aarch64";
# LOADLOG=<file> appends the load average of every timed run)
set -uo pipefail
here=$(cd "$(dirname "$0")" && pwd)
root=$(cd "$here/../../.." && pwd)
what=${1:?usage: cross-kb.sh table|ws|g28 <out dir>}
out=${2:?usage: cross-kb.sh table|ws|g28 <out dir>}
mkdir -p "$out"
out=$(cd "$out" && pwd)
llvm=${LLVM:-/opt/homebrew/opt/llvm/bin}
lock=$root/build/batch/mac-bench.lock

if [ ! -d "$out/katybug-src" ]; then
	mkdir -p "$out/katybug-src"
	git -C "$root" archive HEAD src/gmux/katybug | tar -x -C "$out/katybug-src" --strip-components=3
	git -C "$root" rev-parse HEAD > "$out/katybug-src.rev"
fi
export KATYBUG_SRC=$out/katybug-src ROUNDS=${ROUNDS:-3} LAYOUTS=${LAYOUTS:-3}
[ -n "${LOADLOG:-}" ] && export LOADLOG

flags=(-nostdlib -static -fuse-ld=lld -O2 -ffreestanding -fno-stack-protector -fno-builtin)
"$llvm/clang" --target=x86_64-linux-gnu "${flags[@]}" -mno-sse -mno-mmx -o "$out/kb-cross-x86_64" "$here/../src/kb-cross.c" || exit 1
"$llvm/clang" --target=aarch64-linux-gnu "${flags[@]}" -mgeneral-regs-only -o "$out/kb-cross-aarch64" "$here/../src/kb-cross.c" || exit 1

# ops a pass of the tl guest runs, so each (segments, reps) takes the same ops: TLOPS (default 300M)
if [ "$what" = table ]; then
	cc -std=c11 -D_DEFAULT_SOURCE -D_DARWIN_C_SOURCE -O2 -o "$out/kb-cal" "$KATYBUG_SRC"/*.c -lm || exit 1
fi
tlops() { KATYBUG_STATS=1 "$out/kb-cal" "$out/kb-cross-$1" t "$2" "$3" "$4" 2>&1 > /dev/null | grep -ao 'of [0-9]* ops run' | awk '{print $2}'; }

mkworkloads() {
	local arch=$1 g=../kb-cross-{arch}
	cat << EOF
a1|@ $g a 1 28000000
a4|@ $g a 4 12000000
a16|@ $g a 16 4000000
a64|@ $g a 64 1080000
a64x|@ $g a 64 3200000
b0|@ $g b 4 0 4000000
b32|@ $g b 4 32 4000000
b8|@ $g b 4 8 4000000
b4|@ $g b 4 4 4000000
b2|@ $g b 4 2 4000000
m0|@ $g m 0 0 12000000
m1|@ $g m 1 0 12000000
m0x|@ $g m 0 32 12000000
m1x|@ $g m 1 32 12000000
null|@ $g n
EOF
	for k in 4 16; do
		for s in 1 2 4 8 16 32 64; do
			a=$(tlops "$arch" "$s" "$k" 1000)
			b=$(tlops "$arch" "$s" "$k" 2000)
			echo "tl$s-$k|@ $g t $s $k $(((${TLOPS:-300000000}) * 1000 / (b - a)))"
		done
	done
}

# a generated working-set guest for each (mode, blocks held, blocks in the cycle) and two run lengths
wsguests() {
	local arch=$1 n
	: > "$out/$what-$arch.txt"
	local specs=("ind 16 16" "ind 1024 16" "ind 1024 128" "ind 1024 1024" "ind 4096 16" "ind 4096 64" "ind 4096 256"
		"ind 4096 1024" "ind 4096 4096" "ind 20000 16" "ind 20000 1024" "ind 20000 20000" "ind 98000 16"
		"ind 98000 128" "ind 98000 1024" "ind 98000 8192" "ind 98000 98000"
		"dir 16 16" "dir 1024 1024" "dir 4096 4096" "dir 20000 20000" "dir 98000 98000")
	[ "$what" = ws2 ] && specs=("dirh 16 16" "dirh 1024 16" "dirh 1024 128" "dirh 1024 1024" "dirh 4096 16" "dirh 4096 64" "dirh 4096 256"
		"dirh 4096 1024" "dirh 4096 4096" "dirh 20000 16" "dirh 20000 256" "dirh 20000 1024" "dirh 20000 20000")
	# ws3: dirh guests with guards (a spec's fourth field): the lookup term and the trace block term in one guest
	[ "$what" = ws4 ] && specs=("dirs 16 16" "dirs 1024 16" "dirs 1024 128" "dirs 1024 1024" "dirs 4096 16" "dirs 4096 64" "dirs 4096 256"
		"dirs 4096 1024" "dirs 4096 4096" "dirs 20000 16" "dirs 20000 256" "dirs 20000 1024" "dirs 20000 20000"
		"dirs 4096 256 4" "dirs 4096 256 16")
	[ "$what" = ws3 ] && specs=("dirh 4096 256 0" "dirh 4096 256 4" "dirh 4096 256 16" "dirh 4096 1024 4")
	for spec in "${specs[@]}"; do
		set -- $spec
		local tag=${4:+g$4}
		for n in 7840000 31360000; do
			local rounds=$((n / ($3 * (1 + ${4:-0})))) g=ws-$arch-$1-$2-$3$tag-$((n / 1000000))
			node --no-warnings --experimental-strip-types "$here/ws-gen.ts" gen "$arch" "$1" "$2" "$3" "$rounds" "${4:-0}" > "$out/ws.S" || exit 1
			"$llvm/clang" --target="$arch-linux-gnu" -nostdlib -static -fuse-ld=lld -o "$out/$g" "$out/ws.S" || exit 1
			echo "$1-$2-$3$tag-$((n / 1000000))|@ ../$g" >> "$out/$what-$arch.txt"
		done
	done
}

for arch in ${ARCHES:-x86_64 aarch64}; do
	arms=()
	case $what in
	table) mkworkloads "$arch" > "$out/workloads-$arch.txt" ;;
	ws | ws2 | ws4)
		wsguests "$arch"
		arms=("base=-DKB_FUSE=0 -DKB_CHAIN=0 -DKB_TRACE=1" "chain=-DKB_FUSE=0 -DKB_TRACE=1")
		;;
	ws3) wsguests "$arch" ;;
	esac
	until mkdir "$lock" 2> /dev/null; do sleep 20; done
	case $what in
	table) WORKLOADS=$out/workloads-$arch.txt ;;
	ws | ws2 | ws3 | ws4) WORKLOADS=$out/$what-$arch.txt ;;
	*) unset WORKLOADS ;;
	esac
	export WORKLOADS
	ARCHES=$arch "$here/../../trace-length/scripts/sweep.sh" "$out/$arch" ${arms[@]+"${arms[@]}"} > "$out/$what-$arch.tsv" 2> "$out/$what-$arch.err"
	rmdir "$lock"
done
echo done > "$out/$what.done"
