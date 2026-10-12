#!/usr/bin/env bash
# the whole-digest recognizer (digest.c): stream-faults.c runs the stream function, block function and finish
# function of the static x86-64 coreutils 9.5 (userland-build.sh; build/katybug/transcript/ubin/coreutils by
# default) over scripted reads, natively on NATIVE_HOST and under katybug with the kernels off, with the block
# kernels only, and with the host digest on (KATYBUG_HOSTDIGEST=1: a test double over hash.c stands in for the
# machine's node:crypto). Every scenario's output and exit status must be the same in all four; the host digest
# arm must also finish as many digests as the scenario's row says. "context" reads the context between block calls,
# which a host digest cannot answer: the arm differs there by exactly the words it shows (the initial state).
# usage: tests/c/katybug/digest.sh [coreutils [tool...]]; tools default to md5 sha1 sha256 sha512
# NATIVE_HOST required: an ssh host that runs x86-64 natively
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
root=$(cd "$here/../../.." && pwd)
llvm=${LLVM:-/opt/homebrew/opt/llvm/bin}
host=${NATIVE_HOST:?set NATIVE_HOST to an ssh host that runs x86-64 natively, or local}
cu=${1:-$root/build/katybug/transcript/ubin/coreutils}
cu=$(cd "$(dirname "$cu")" && pwd)/$(basename "$cu")
shift || true
tools=${*:-md5 sha1 sha256 sha512}
out=$(mktemp -d)
rig=gmux-rig/k45-digest
${CC:-cc} -std=c11 -D_DEFAULT_SOURCE -D_DARWIN_C_SOURCE -O2 -Wall -Wextra -Werror -o "$out/katybug" "$root"/src/gmux/katybug/*.c -lm
flags=(-nostdlib -static -O2 -ffreestanding -fno-stack-protector -fno-builtin -mno-sse -mno-mmx -mno-red-zone -Wall -Wextra -Werror)
if [ "$host" = local ]; then
	# a linux machine with clang 18 and the GNU linker: the program links above the code it maps
	clang "${flags[@]}" -Wl,-Ttext-segment=0x10000000 -o "$out/stream-faults" "$here/stream-faults.c"
	mkdir -p ~/$rig && cp "$cu" ~/$rig/coreutils && cp "$out/stream-faults" ~/$rig/stream-faults
else
	"$llvm/clang" --target=x86_64-linux-gnu -fuse-ld=lld "${flags[@]}" -Wl,--image-base=0x10000000 -o "$out/stream-faults" "$here/stream-faults.c"
	cat "$cu" | ssh "$host" "mkdir -p ~/$rig && cat > ~/$rig/coreutils && chmod +x ~/$rig/coreutils"
	cat "$out/stream-faults" | ssh "$host" "cat > ~/$rig/stream-faults && chmod +x ~/$rig/stream-faults"
fi
fail=0
native() { if [ "$host" = local ]; then (cd ~/$rig && sh -c "$1"); else ssh "$host" "cd ~/$rig && $1"; fi; }

# scenario, host digests the host arm finishes at least (summed over every process that reports)
scenarios="plain:1 exact:1 short:1 small:0 error:1 nested:2 handler:0 thread:0 fork-before:2 fork-after:2 fork-mid:1 unmap:0 exit:0 context:1"

run() {
	# run <arm> <tool> <scenario>: stdout and the status, the host digests the process reports
	local arm=$1 tool=$2 scn=$3
	rm -f "$out/p.log"
	local env=()
	case $arm in
		off) env=(KATYBUG_PRIM=0) ;;
		kernel) env=(KATYBUG_PRIM=md5,sha1,sha256,sha512) ;;
		on) env=(KATYBUG_HOSTDIGEST=1) ;;
		exec) env=(KATYBUG_HOSTDIGEST=1 KATYBUG_FORK=exec) ;;
	esac
	(
		cd "$out"
		rc=0
		env "${env[@]}" KATYBUG_STATS=1 KATYBUG_PRIM_LOG="$out/p.log" ./katybug ./stream-faults "$cu" "$tool" "$scn" 2> /dev/null || rc=$?
		echo "rc $rc"
	) > "$out/$arm.$tool.$scn"
	ndig=$({ grep -o "digest [0-9]*" "$out/p.log" 2> /dev/null || true; } | awk '{n += $2} END {print n + 0}')
}

for tool in $tools; do
	echo "# $tool"
	for pair in $scenarios; do
		scn=${pair%%:*}
		want=${pair##*:}
		native "./stream-faults ./coreutils $tool $scn; echo rc \$?" > "$out/native.$tool.$scn" 2> /dev/null || true
		for arm in off kernel on; do
			run $arm "$tool" "$scn"
			if [ "$scn" = context ] && [ $arm = on ]; then continue; fi
			cmp -s "$out/native.$tool.$scn" "$out/$arm.$tool.$scn" || {
				echo "FAIL $tool $scn: $arm differs from native"
				diff "$out/native.$tool.$scn" "$out/$arm.$tool.$scn" | head -4 || true
				fail=1
			}
		done
		run on "$tool" "$scn"
		if [ "$scn" != unmap ] && [ "$scn" != exit ] && [ "$ndig" -lt "$want" ]; then
			echo "FAIL $tool $scn: the host digest finished $ndig of at least $want"
			fail=1
		fi
		if [ "$scn" = fork-mid ]; then
			# a fork inside a stream by exec (the machine's fork): the child claims a copy of the host digest, and
			# both processes finish theirs on it
			run exec "$tool" "$scn"
			cmp -s "$out/native.$tool.$scn" "$out/exec.$tool.$scn" || {
				echo "FAIL $tool fork-mid: the fork-by-exec run differs from native"
				diff "$out/native.$tool.$scn" "$out/exec.$tool.$scn" | head -4 || true
				fail=1
			}
			[ "$ndig" -ge 2 ] || {
				echo "FAIL $tool fork-mid: the fork-by-exec run finished $ndig host digests, not both"
				fail=1
			}
		fi
		if [ "$scn" = context ]; then
			# the host arm shows the initial state where native shows the state after two blocks
			grep -q '^context' "$out/native.$tool.$scn" && grep -q '^context' "$out/on.$tool.$scn" || {
				echo "FAIL $tool context: no context line"
				fail=1
			}
			case $tool in
				md5 | sha1) iv="context 67452301 efcdab89" ;;
				sha256) iv="context 6a09e667 bb67ae85" ;;
				sha512) iv="context f3bcc908 6a09e667" ;;
			esac
			[ "$(grep '^context' "$out/on.$tool.$scn")" = "$iv" ] && [ "$(grep '^context' "$out/native.$tool.$scn")" != "$iv" ] || {
				echo "FAIL $tool context: the host arm should show the initial state and native the running one"
				fail=1
			}
			diff <(grep -v '^context' "$out/native.$tool.$scn") <(grep -v '^context' "$out/on.$tool.$scn") > /dev/null || {
				echo "FAIL $tool context: the digest or status differs"
				fail=1
			}
		fi
		echo "ok $tool $scn (host digests $ndig)"
	done
done
exit $fail
