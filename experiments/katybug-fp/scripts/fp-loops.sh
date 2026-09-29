#!/usr/bin/env bash
# times fmla, scalar fmadd, scalar arithmetic and a mixed FP loop under a katybug build, best of N
# usage: fp-loops.sh <katybug binary> [runs]
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
kb=${1:?usage: fp-loops.sh <katybug binary> [runs]}
runs=${2:-5}
tmp=$(mktemp -d)
for w in vfmla sfmadd sarith mixed; do
	clang --target=aarch64-linux-gnu -nostdlib -static -fuse-ld=lld -x assembler-with-cpp -DWHICH=$w -o "$tmp/$w" "$here/fp-loops.S"
	best=
	for _ in $(seq "$runs"); do
		s=$(date +%s.%N 2>/dev/null || python3 -c 'import time;print(time.time())')
		"$kb" "$tmp/$w" > /dev/null
		e=$(date +%s.%N 2>/dev/null || python3 -c 'import time;print(time.time())')
		t=$(awk -v s="$s" -v e="$e" 'BEGIN{printf "%.3f", e-s}')
		if [ -z "$best" ] || awk -v t="$t" -v b="$best" 'BEGIN{exit !(t<b)}'; then best=$t; fi
	done
	echo "$w $best"
done
