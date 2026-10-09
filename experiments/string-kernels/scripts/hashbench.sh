#!/usr/bin/env bash
# the hash block bench (hashbench.c over src/gmux/katybug/hash.c) natively with each compiler in CCS, as wasm32
# under node (V8) when LINUX_WASM names a linux-wasm tree, and gnulib's own blocks as a control when GNULIB
# names a coreutils lib directory; each run pinned to CPU, under LOCK, with quiet.sh's reading before it
# usage: CPU=13 LOCK=/tmp/paisley-timing.lock QUIET=<quiet.sh> [CCS="cc clang"] [ROUNDS=3] [MIB=256] [RUNS=5]
#   [LINUX_WASM=~/gmux-rig/linux-wasm] [GNULIB=<coreutils lib dir>] hashbench.sh <out dir>
# writes <out dir>/hashbench.tsv: compiler, round, variant, MB/s median, min-max, digest, quiet reading
set -uo pipefail
here=$(cd "$(dirname "$0")" && pwd)
root=$(cd "$here/../../.." && pwd)
cpu=${CPU:?set CPU}
lock=${LOCK:?set LOCK}
quiet=${QUIET:?set QUIET to quiet.sh}
mkdir -p "${1:?usage: hashbench.sh <out dir>}"
out=$(cd "$1" && pwd)
K=$root/src/gmux/katybug
for cc in ${CCS:-cc clang}; do
	$cc -std=c11 -D_DEFAULT_SOURCE -O2 -Wall -Wextra -Werror -o "$out/hb-$cc" "$here/../hashbench.c" "$K/hash.c" || exit 1
done
if [ -n "${GNULIB:-}" ]; then
	for cc in ${CCS:-cc clang}; do
		$cc -std=gnu11 -O2 -I"$here/../gnulib" -I"$GNULIB" -include config.h -o "$out/ref-$cc" "$here/../gnulib/refbench.c" \
			"$GNULIB"/sha256.c "$GNULIB"/sha1.c "$GNULIB"/md5.c "$GNULIB"/sha512.c || exit 1
	done
fi
if [ -n "${LINUX_WASM:-}" ]; then
	llvm=$LINUX_WASM/workspace/install/llvm/bin
	for f in hashbench.c:hb hash.c:hh; do
		src=$here/../hashbench.c
		[ "${f%%:*}" = hash.c ] && src=$K/hash.c
		LINUX_WASM=$LINUX_WASM REAL_LLVM=$llvm TMPDIR=/tmp bash "$root/scripts/cc-strict" -c -D_DEFAULT_SOURCE "$src" -o "$out/${f##*:}.o" > /dev/null || exit 1
	done
	"$llvm/wasm-ld" --no-entry "$out/hb.o" "$out/hh.o" -o "$out/hb.wasm" || exit 1
fi
sample() { # label cmd...
	local label=$1 q
	shift
	until mkdir "$lock" 2> /dev/null; do sleep 10; done
	q=$(bash "$quiet" "$cpu" 1 | cut -d' ' -f2)
	"$@" | awk -F'\t' -v l="$label" -v r="$round" -v q="$q" 'NF == 4 {print l "\t" r "\t" $1 "\t" $2 "\t" $3 "\t" $4 "\t" q}' >> "$out/hashbench.tsv"
	rmdir "$lock"
}
: > "$out/hashbench.tsv"
for round in $(seq "${ROUNDS:-3}"); do
	for cc in ${CCS:-cc clang}; do
		sample "$cc" taskset -c "$cpu" "$out/hb-$cc" "${MIB:-256}" "${RUNS:-5}"
		[ -n "${GNULIB:-}" ] && sample "gnulib $cc" taskset -c "$cpu" "$out/ref-$cc" "${MIB:-256}" "${RUNS:-5}"
	done
	[ -n "${LINUX_WASM:-}" ] && sample "wasm node $(node --version)" taskset -c "$cpu" node "$here/hashbench-wasm.ts" "$out/hb.wasm" "${MIB:-256}" "${RUNS:-5}"
done
echo "done: $out/hashbench.tsv"
