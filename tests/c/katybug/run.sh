#!/usr/bin/env bash
# the differential check: x86-64 and AArch64 ELFs built from tests/c/katybug run under a native
# build of katybug. guest.c's reference is the same source built natively (-DKB_HOST, freestanding
# otherwise); signals.expected is the x86-64 signals build's output on native Linux.
# usage: tests/c/katybug/run.sh
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
root=$(cd "$here/../../.." && pwd)
llvm=${LLVM:-/opt/homebrew/opt/llvm/bin}
out=$(mktemp -d)
cc -std=c11 -D_DEFAULT_SOURCE -D_DARWIN_C_SOURCE -O2 -Wall -Wextra -Werror \
	-o "$out/katybug" "$root"/src/gmux/katybug/*.c -lm
cc -DKB_HOST -O2 -o "$out/guest-native" "$here/guest.c"
flags=(-nostdlib -static -fuse-ld=lld -O2 -ffreestanding -fno-stack-protector -fno-builtin)
"$llvm/clang" --target=x86_64-linux-gnu "${flags[@]}" -mno-sse -mno-mmx -o "$out/guest-x86" "$here/guest.c"
"$llvm/clang" --target=aarch64-linux-gnu "${flags[@]}" -mgeneral-regs-only -o "$out/guest-a64" "$here/guest.c"
"$llvm/clang" --target=x86_64-linux-gnu "${flags[@]}" -mno-sse -mno-mmx -o "$out/signals-x86" "$here/signals.c"
"$llvm/clang" --target=aarch64-linux-gnu "${flags[@]}" -mgeneral-regs-only -o "$out/signals-a64" "$here/signals.c"
"$llvm/clang" --target=x86_64-linux-gnu -nostdlib -static -fuse-ld=lld -o "$out/hello-x86" "$here/hello-x86.S"
"$llvm/clang" --target=aarch64-linux-gnu -nostdlib -static -fuse-ld=lld -o "$out/hello-a64" "$here/hello-a64.S"

# the ELFs for tests/c/run.ts's katybug probe, which runs them inside a machine
mkdir -p "$root/build/katybug"
cp "$out"/hello-x86 "$out"/hello-a64 "$out"/guest-x86 "$out"/guest-a64 "$out"/signals-x86 "$out"/signals-a64 \
	"$root/build/katybug/"

failed=0
check() {
	local name=$1 want=$2 wantrc=$3
	shift 3
	local got rc=0
	got=$("$@" 2> "$out/err") || rc=$?
	if [ "$got" = "$want" ] && [ "$rc" = "$wantrc" ]; then
		echo "PASS $name"
	else
		echo "FAIL $name (exit $rc, want $wantrc): $(head -c 300 "$out/err")"
		diff <(echo "$want") <(echo "$got") | head -10 || true
		failed=1
	fi
}
ref_rc=0
ref=$("$out/guest-native") || ref_rc=$?
check hello-x86 hello 0 "$out/katybug" "$out/hello-x86"
check hello-a64 hello 0 "$out/katybug" "$out/hello-a64"
check guest-x86 "$ref" "$ref_rc" "$out/katybug" "$out/guest-x86"
check guest-a64 "$ref" "$ref_rc" "$out/katybug" "$out/guest-a64"
# signals.expected is the x86-64 build's output on native Linux; SIGTERM's default action ends it.
# a CI runner starts steps with SIGPIPE ignored, so the default case sets it back first
dfl=(perl -e '$SIG{PIPE} = "DEFAULT"; exec @ARGV or die')
check signals-x86 "$(cat "$here/signals.expected")" 143 "${dfl[@]}" "$out/katybug" "$out/signals-x86"
check signals-a64 "$(cat "$here/signals.expected")" 143 "${dfl[@]}" "$out/katybug" "$out/signals-a64"
# started with SIGPIPE ignored, which exec keeps (native Linux prints 1 on the first line)
ignored=$(sed '1s/ 0$/ 1/' "$here/signals.expected")
check signals-x86-ignored "$ignored" 143 bash -c "trap '' PIPE; exec \"\$@\"" - "$out/katybug" "$out/signals-x86"
check signals-a64-ignored "$ignored" 143 bash -c "trap '' PIPE; exec \"\$@\"" - "$out/katybug" "$out/signals-a64"
exit $failed
