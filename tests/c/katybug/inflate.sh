#!/usr/bin/env bash
# the whole-stream inflate recognizer (inflate.c): the static x86-64 GNU gzip 1.13 (gzip-build.sh; build/katybug/gzip/gzip by
# default) runs the corpus of inflate-cases.ts (valid files of every block type around the window size, concatenated
# members, trailing bytes, crafted bad streams, byte flips, truncations, -t -l, stdin, pipes, a full disk, an early reader)
# natively on NATIVE_HOST and under katybug with the kernels off, with the crc loop only, and with the host inflate on
# (KATYBUG_HOSTINFLATE=1: a test double over the system's zlib stands in for the machine's node:zlib). Every case's
# output, error output and status must be the same in all four; the host arm must take a stream in the cases marked
# taken and none where marked refused
# usage: tests/c/katybug/inflate.sh [gzip]; CONTAINER (an image) runs it all in that image; NATIVE_HOST required: an ssh host that runs x86-64 natively, or local; ARMS (off kernel on), FLIPS and MIXFLIPS (the byte-flip cases)
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
root=$(cd "$here/../../.." && pwd)
host=${NATIVE_HOST:?set NATIVE_HOST to an ssh host that runs x86-64 natively, or local}
gz=${1:-$root/build/katybug/gzip/gzip}
gz=$(cd "$(dirname "$gz")" && pwd)/$(basename "$gz")
out=${OUT:-$(mktemp -d)}
mkdir -p "$out"
${CC:-cc} -std=c11 -D_DEFAULT_SOURCE -D_DARWIN_C_SOURCE -O2 -Wall -Wextra -Werror -DKB_ZLIB -o "$out/katybug" "$root"/src/gmux/katybug/*.c -lm -lz
rig=gmux-rig/inflate
if [ -z "${REUSE:-}" ]; then
	node --experimental-strip-types "$here/inflate-cases.ts" "$out/corpus"
	cp "$gz" "$out/corpus/gzip"
fi
cp "$here/inflate-run.sh" "$out/corpus/inflate-run.sh"
rm -rf "$out/off" "$out/kernel" "$out/on" "$out"/corpus/w{off,kernel,on}*

# CONTAINER=<image> runs every arm and the native control inside that image on this machine (a linux box with docker and a
# static katybug: CC="clang -static"), the corpus mounted at its own path
run=
[ -n "${CONTAINER:-}" ] && run="docker run --rm --memory 2g --cpus 2 -u $(id -u):$(id -g) -e HOME=/tmp -v $out:$out -w $out/corpus $CONTAINER"

# the native control, in one session, while the arms run here (REUSE=1 with OUT: the corpus and the native results of an earlier run)
if [ -n "${REUSE:-}" ]; then
	:
elif [ -n "${CONTAINER:-}" ]; then
	$run sh inflate-run.sh native "$out/native" &
elif [ "$host" = local ]; then
	mkdir -p ~/$rig/corpus
	cp -R "$out/corpus/." ~/$rig/corpus/
	(cd ~/$rig/corpus && sh inflate-run.sh native "$out/native") &
else
	tar -C "$out" -cf - corpus | ssh "$host" "mkdir -p ~/$rig && tar -C ~/$rig -xf - && cd ~/$rig/corpus && sh inflate-run.sh native ../native > /dev/null 2>&1; tar -C ~/$rig -cf - native" | tar -C "$out" -xf - &
fi
for arm in ${ARMS:-off kernel on}; do
	(cd "$out/corpus" && $run sh inflate-run.sh "$arm" "$out/$arm" "$out/katybug") &
done
wait

fail=0
: > "$out/taken.txt"
n=$(cat "$out/native/count")
i=0
while IFS='|' read -r name expect cmd; do
	i=$((i + 1))
	for arm in ${ARMS:-off kernel on}; do
		for ext in out err rc; do
			cmp -s "$out/native/$i.$ext" "$out/$arm/$i.$ext" || {
				echo "FAIL $name ($i): $arm differs from native in $ext"
				diff <(head -c 300 "$out/native/$i.$ext") <(head -c 300 "$out/$arm/$i.$ext") | head -4 || true
				fail=1
			}
		done
	done
	taken=$({ grep -o "inflate [0-9]*" "$out/on/$i.log" 2> /dev/null || true; } | awk '{n += $2} END {print n + 0}')
	case $expect in
		taken) [ "$taken" -ge 1 ] || {
			echo "FAIL $name ($i): the host inflate took no stream"
			fail=1
		} ;;
		refused) [ "$taken" -eq 0 ] || {
			echo "FAIL $name ($i): the host inflate took $taken streams of a stream it must refuse"
			fail=1
		} ;;
	esac
	echo "$taken" >> "$out/taken.txt"
done < "$out/corpus/cases.txt"
echo "$i cases ($n run natively), host streams taken in $(awk '$1 > 0' "$out/taken.txt" | wc -l | tr -d ' ') of them"
[ "$fail" = 0 ] && echo "inflate.sh: ok" || echo "inflate.sh: FAIL"
exit "$fail"
