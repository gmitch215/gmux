#!/usr/bin/env bash
# the return stack is removed from katybug (it did not beat the noise); on the current tree both arms
# run the same code, so run this from a copy of the repo from before the removal
# threads.sh <work dir>: tests/c/katybug/threads.c (pthreads through the guest's own libc) natively and under
# a static katybug with the return stack off and on, in Debian (glibc) and Alpine (musl) containers; the
# outputs must match line for line. Run on the x86-64 host (docker); prints the stack's counters for the
# on run. CPUSET=<cpus> pins the containers (default 6,18).
set -uo pipefail
here=$(cd "$(dirname "$0")" && pwd)
root=$(cd "$here/../../.." && pwd)
work=${1:?usage: threads.sh <work dir>}
mkdir -p "$work"
work=$(cd "$work" && pwd)
cp "$root/tests/c/katybug/threads.c" "$work/"
cc -std=c11 -D_DEFAULT_SOURCE -O2 -static -o "$work/katybug" "$root"/src/gmux/katybug/*.c -lm || exit 1
dock="docker run --rm --user $(id -u):$(id -g) --memory 2g --cpus 2 --cpuset-cpus ${CPUSET:-6,18} -v $work:/t"
docker run --rm --memory 2g --cpus 2 -v "$work:/t" alpine:3.20 sh -c \
	'apk add --no-cache build-base > /dev/null && cc -O2 -pthread -o /t/threads-musl /t/threads.c && chown '"$(id -u):$(id -g)"' /t/threads-musl'
docker run --rm --memory 2g --cpus 2 -v "$work:/t" debian:bookworm-slim sh -c \
	'apt-get -qq update > /dev/null && apt-get -qq install -y gcc libc6-dev > /dev/null 2>&1 && gcc -O2 -pthread -o /t/threads-glibc /t/threads.c && chown '"$(id -u):$(id -g)"' /t/threads-glibc'
fail=0
for img in debian:bookworm-slim alpine:3.20; do
	case $img in debian*) bin=/t/threads-glibc ;; *) bin=/t/threads-musl ;; esac
	$dock "$img" $bin > "$work/native-${img%%:*}.txt" 2>&1
	for ras in 0 1; do
		$dock -e KATYBUG_RAS=$ras -e KATYBUG_STATS=1 "$img" sh -c "/t/katybug $bin 2> /t/stats-${img%%:*}-$ras.txt" > "$work/kb-${img%%:*}-$ras.txt" 2>&1
		if cmp -s "$work/native-${img%%:*}.txt" "$work/kb-${img%%:*}-$ras.txt"; then
			echo "PASS ${img%%:*} RAS=$ras: $(wc -l < "$work/native-${img%%:*}.txt") lines equal"
		else
			echo "FAIL ${img%%:*} RAS=$ras"
			diff "$work/native-${img%%:*}.txt" "$work/kb-${img%%:*}-$ras.txt" | head -10
			fail=1
		fi
		echo "  $(grep -E 'ras |lookups' "$work/stats-${img%%:*}-$ras.txt" | paste -sd' ')"
	done
done
exit $fail
