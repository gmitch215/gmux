#!/usr/bin/env bash
# builds the x86-64 guests of tests/c/katybug, takes each one's hot-block dump with a native Katybug, and emits its regions
# (emit.ts) into one set per guest or per function; writes jobs.tsv for emit-check.ts. The module of each set is built
# elsewhere (the wasm toolchain), into <out>/wasm/<set>/.
# REGIONS=all: every function of the guest as a region of one set; each: one set per function, that function alone.
# usage: [REGIONS=all|each] [EACH_ONLY=<regex on function names>] [EMIT_FLAGS=--flags=all] emit-guests.sh <out dir> <katybug sources> <tests dir> [guest...]
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
mkdir -p "$1"
out=$(cd "$1" && pwd)
K=$(cd "$2" && pwd)
T=$(cd "$3" && pwd)
shift 3
llvm=${LLVM:-/opt/homebrew/opt/llvm/bin}
node=${NODE:-node}
mode=${REGIONS:-all}
cc="${CC:-cc} -std=c11 -D_DEFAULT_SOURCE -D_DARWIN_C_SOURCE -O1"
flags=(--target=x86_64-linux-gnu -nostdlib -static -fuse-ld=lld -O2 -ffreestanding -fno-stack-protector -fno-builtin)
source_of() {
	case $1 in commit) echo x86-commit.c ;; faults) echo x86-faults.c ;; region-smc) echo x86-region-smc.c ;; prim) echo prim-faults.c ;; regs) echo x86-regs.c ;; slots) echo x86-slots.c ;; calls) echo x86-calls.c ;; index) echo x86-index.c ;; loops) echo x86-loops.c ;; flags) echo x86-flags.c ;; *) echo "$1.c" ;; esac
}
flags_of() {
	case $1 in regs) echo "" ;; commit) echo "-mno-sse -mno-mmx -mno-red-zone" ;; region-smc) echo "-Wl,-N -mno-sse -mno-mmx" ;; rights) echo "-mno-sse -mno-mmx -DNO_SELF" ;; slots | calls | index | loops) echo "-mno-sse -mno-mmx -mno-red-zone" ;; prim) echo "-I$T -mno-sse -mno-mmx -mno-red-zone" ;; *) echo "-mno-sse -mno-mmx" ;; esac
}
guests=("$@")
[ "${#guests[@]}" -gt 0 ] || guests=(guest signals faults prim returns pieces fds regs slots calls index loops flags)
[ -x "$out/hot" ] || $cc -o "$out/hot" -DKB_HOT "$K"/*.c -lm
[ -x "$out/plain" ] || $cc -o "$out/plain" "$K"/*.c -lm
: > "$out/jobs.tsv"
for g in "${guests[@]}"; do
	"$llvm/clang" "${flags[@]}" $(flags_of "$g") -o "$out/$g" "$T/$(source_of "$g")"
	mkdir -p "$out/hot-$g"
	rm -f "$out/hot-$g"/*.hot
	KATYBUG_SEGMENTS=1 KATYBUG_HOT=$out/hot-$g "$out/hot" "$out/$g" > /dev/null 2>&1 || true
	rc=0
	"$out/plain" "$out/$g" > "$out/$g.want" 2> /dev/null || rc=$?
	echo "$rc" > "$out/$g.rc"
	"$llvm/llvm-nm" -S -n --defined-only "$out/$g" | awk '$3 ~ /^[tT]$/ { print $4, $1, $2 }' > "$out/$g.funcs"
	big=$(ls -S "$out/hot-$g"/*.hot | head -1)
	emit() {
		local set=$1
		shift
		mkdir -p "$out/sets/$set"
		"$node" --no-warnings --experimental-strip-types "$here/emit.ts" ${EMIT_FLAGS:-} "$out/sets/$set" 1 "$@" 2> "$out/sets/$set/emit.log"
		# a guest with a native-made .expected file also checks its output against it
		local want=""
		[ "$g" = commit ] && want="$T/x86-commit.expected"
		printf '%s\t%s\t%s\t$G\t%s\n' "$set" "$out/wasm/$set" "$out/$g" "$want" >> "$out/jobs.tsv"
	}
	case $mode in
		all)
			specs=()
			while read -r name addr size; do
				specs+=("$big@0x$addr-$(printf '0x%x' $((0x$addr + 0x$size)))")
			done < "$out/$g.funcs"
			emit "$g-all" "${specs[@]}"
			;;
		each)
			while read -r name addr size; do
				[[ $name =~ ${EACH_ONLY:-.} ]] || continue
				emit "$g-$name" "$big@0x$addr-$(printf '0x%x' $((0x$addr + 0x$size)))"
			done < "$out/$g.funcs"
			;;
	esac
	echo "$g: rc $rc, $(wc -l < "$out/$g.funcs" | tr -d ' ') functions"
done
