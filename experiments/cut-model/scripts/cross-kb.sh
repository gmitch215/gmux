#!/usr/bin/env bash
# katybug's crossings priced one at a time (table), and the trace-length sweep the table then predicts
# (g28): both run through trace-length/scripts/sweep.sh's nine builds, from a copy of src/gmux/katybug
# at HEAD so another session's edits cannot move a build between the two. Each arch's sweep holds the
# bench lock, since another lane may be timing on this machine.
# usage: cross-kb.sh table|g28 <out dir>  (ROUNDS=3, LAYOUTS=3, ARCHES="x86_64 aarch64")
set -uo pipefail
here=$(cd "$(dirname "$0")" && pwd)
root=$(cd "$here/../../.." && pwd)
what=${1:?usage: cross-kb.sh table|g28 <out dir>}
out=${2:?usage: cross-kb.sh table|g28 <out dir>}
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

flags=(-nostdlib -static -fuse-ld=lld -O2 -ffreestanding -fno-stack-protector -fno-builtin)
"$llvm/clang" --target=x86_64-linux-gnu "${flags[@]}" -mno-sse -mno-mmx -o "$out/kb-cross-x86_64" "$here/../src/kb-cross.c" || exit 1
"$llvm/clang" --target=aarch64-linux-gnu "${flags[@]}" -mgeneral-regs-only -o "$out/kb-cross-aarch64" "$here/../src/kb-cross.c" || exit 1

if [ "$what" = table ]; then
	g=../kb-cross-{arch}
	cat > "$out/workloads.txt" << EOF
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
	export WORKLOADS=$out/workloads.txt
fi

for arch in ${ARCHES:-x86_64 aarch64}; do
	until mkdir "$lock" 2> /dev/null; do sleep 20; done
	ARCHES=$arch "$here/../../trace-length/scripts/sweep.sh" "$out/$arch" > "$out/$what-$arch.tsv" 2> "$out/$what-$arch.err"
	rmdir "$lock"
done
echo done > "$out/$what.done"
