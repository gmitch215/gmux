#!/usr/bin/env bash
# the differential check: x86-64 and AArch64 ELFs built from tests/c/katybug run under a native
# build of katybug. guest.c's reference is the same source built natively (-DKB_HOST, freestanding
# otherwise); signals.expected is the x86-64 signals build's output on native Linux.
# usage: tests/c/katybug/run.sh; KATYBUG_CFLAGS adds flags to each check's katybug build
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
root=$(cd "$here/../../.." && pwd)
llvm=${LLVM:-/opt/homebrew/opt/llvm/bin}
out=$(mktemp -d)
cc -std=c11 -D_DEFAULT_SOURCE -D_DARWIN_C_SOURCE -O2 -Wall -Wextra -Werror \
	${KATYBUG_CFLAGS:-} -o "$out/katybug" "$root"/src/gmux/katybug/*.c -lm
cc -std=c11 -D_DEFAULT_SOURCE -D_DARWIN_C_SOURCE -O2 -Wall -Wextra -Werror -DKB_PIECE_BITS=12 \
	-o "$out/katybug-4k" "$root"/src/gmux/katybug/*.c -lm
cc -std=c11 -D_DEFAULT_SOURCE -D_DARWIN_C_SOURCE -O2 -Wall -Wextra -Werror -DKB_EPOCH=1 \
	-o "$out/katybug-epoch" "$root"/src/gmux/katybug/*.c -lm
cc -DKB_HOST -O2 -o "$out/guest-native" "$here/guest.c"
flags=(-nostdlib -static -fuse-ld=lld -O2 -ffreestanding -fno-stack-protector -fno-builtin)
"$llvm/clang" --target=x86_64-linux-gnu "${flags[@]}" -mno-sse -mno-mmx -o "$out/guest-x86" "$here/guest.c"
"$llvm/clang" --target=aarch64-linux-gnu "${flags[@]}" -mgeneral-regs-only -o "$out/guest-a64" "$here/guest.c"
"$llvm/clang" --target=x86_64-linux-gnu "${flags[@]}" -mno-sse -mno-mmx -o "$out/signals-x86" "$here/signals.c"
"$llvm/clang" --target=aarch64-linux-gnu "${flags[@]}" -mgeneral-regs-only -o "$out/signals-a64" "$here/signals.c"
"$llvm/clang" --target=x86_64-linux-gnu "${flags[@]}" -mno-sse -mno-mmx -o "$out/faults-x86" "$here/x86-faults.c"
"$llvm/clang" --target=x86_64-linux-gnu "${flags[@]}" -o "$out/regs-x86" "$here/x86-regs.c"
"$llvm/clang" --target=x86_64-linux-gnu "${flags[@]}" -mno-sse -mno-mmx -mno-red-zone -o "$out/slots-x86" "$here/x86-slots.c"
"$llvm/clang" --target=x86_64-linux-gnu "${flags[@]}" -I"$here" -mno-sse -mno-mmx -mno-red-zone -o "$out/prim-x86" "$here/prim-faults.c"
"$llvm/clang" --target=aarch64-linux-gnu "${flags[@]}" -I"$here" -mgeneral-regs-only -o "$out/prim-a64" "$here/prim-faults.c"
"$llvm/clang" --target=x86_64-linux-gnu "${flags[@]}" -mno-sse -mno-mmx -o "$out/returns-x86" "$here/returns.c"
"$llvm/clang" --target=aarch64-linux-gnu "${flags[@]}" -mgeneral-regs-only -o "$out/returns-a64" "$here/returns.c"
"$llvm/clang" --target=x86_64-linux-gnu "${flags[@]}" -mno-sse -mno-mmx -o "$out/pieces-x86" "$here/pieces.c"
"$llvm/clang" --target=aarch64-linux-gnu "${flags[@]}" -mgeneral-regs-only -o "$out/pieces-a64" "$here/pieces.c"
"$llvm/clang" --target=x86_64-linux-gnu "${flags[@]}" -mno-sse -mno-mmx -o "$out/fds-x86" "$here/fds.c"
"$llvm/clang" --target=aarch64-linux-gnu "${flags[@]}" -mgeneral-regs-only -o "$out/fds-a64" "$here/fds.c"
"$llvm/clang" --target=x86_64-linux-gnu "${flags[@]}" -mno-sse -mno-mmx -o "$out/bigsend-x86" "$here/bigsend.c"
"$llvm/clang" --target=aarch64-linux-gnu "${flags[@]}" -mgeneral-regs-only -o "$out/bigsend-a64" "$here/bigsend.c"
# -N: one writable and executable segment, for the loop that patches its own code
"$llvm/clang" --target=x86_64-linux-gnu "${flags[@]}" -Wl,-N -mno-sse -mno-mmx -o "$out/epochs-x86" "$here/epochs.c"
"$llvm/clang" --target=aarch64-linux-gnu "${flags[@]}" -Wl,-N -mgeneral-regs-only -o "$out/epochs-a64" "$here/epochs.c"
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
# a file that ends inside its program headers or its segments is refused, not run past its end
for n in 100 300; do
	head -c $n "$out/hello-x86" > "$out/cut-$n"
	check cut-elf-$n "" 126 "$out/katybug" "$out/cut-$n"
done
check guest-x86 "$ref" "$ref_rc" "$out/katybug" "$out/guest-x86"
check guest-a64 "$ref" "$ref_rc" "$out/katybug" "$out/guest-a64"
check guest-x86-segments-1 "$ref" "$ref_rc" env KATYBUG_SEGMENTS=1 "$out/katybug" "$out/guest-x86"
check guest-a64-segments-64 "$ref" "$ref_rc" env KATYBUG_SEGMENTS=64 "$out/katybug" "$out/guest-a64"
# the block cache: a second run takes its blocks from the first's file and prints the same; one
# with other plan settings takes none (the file's provenance does not match)
cached() {
	local name=$1 want=$2 wantrc=$3 bin=$4 dir=$out/cache-$1 got rc=0
	mkdir -p "$dir"
	KATYBUG_CACHE=$dir "$out/katybug" "$bin" > /dev/null 2>&1 || true
	got=$(KATYBUG_STATS=1 KATYBUG_CACHE=$dir "$out/katybug" "$bin" 2> "$out/err") || rc=$?
	local hits other
	hits=$( (grep -o '[0-9]* from the cache' "$out/err" || true) | cut -d' ' -f1)
	other=$( (KATYBUG_PLAN=0 KATYBUG_STATS=1 KATYBUG_CACHE=$dir "$out/katybug" "$bin" 2>&1 > /dev/null || true) \
		| (grep -o '[0-9]* from the cache' || true) | cut -d' ' -f1)
	if [ "$got" = "$want" ] && [ "$rc" = "$wantrc" ] && [ "${hits:-0}" -gt 0 ] && [ "${other:-1}" = 0 ]; then
		echo "PASS $name ($hits blocks from the cache)"
	else
		echo "FAIL $name (exit $rc, want $wantrc; $hits from the cache, $other with other settings)"
		failed=1
	fi
}
cached cache-guest-x86 "$ref" "$ref_rc" "$out/guest-x86"
cached cache-guest-a64 "$ref" "$ref_rc" "$out/guest-a64"
# x86-faults.expected is native Linux's: faults mid-rep, divide errors
check faults-x86 "$(cat "$here/x86-faults.expected")" 0 "$out/katybug" "$out/faults-x86"
# x86-regs.expected is native Linux's: every register and flag after SSE, x87 and string instructions,
# and at a fault inside one
check regs-x86 "$(cat "$here/x86-regs.expected")" 0 "$out/katybug" "$out/regs-x86"
# x86-slots.expected is native Linux's: stack slots written through pointers, by a callee, a signal
# handler, other widths, sse and rep stos, and read after a fault
check slots-x86 "$(cat "$here/x86-slots.expected")" 0 "$out/katybug" "$out/slots-x86"
# prim-faults.expected is native Linux's on both architectures: musl's strlen, memcmp, strcmp and
# memchr, byte for byte, called at a page end, a hole, PROT_NONE and across mappings; a kernel that
# reaches a page it cannot read hands over to the function, which faults at the same address
for a in x86 a64; do
	check prim-faults-$a "$(cat "$here/prim-faults.expected")" 0 "$out/katybug" "$out/prim-$a"
	check prim-faults-$a-interpreted "$(cat "$here/prim-faults.expected")" 0 env KATYBUG_PRIM=0 "$out/katybug" "$out/prim-$a"
	check prim-faults-$a-memchr-only "$(cat "$here/prim-faults.expected")" 0 env KATYBUG_PRIM=memchr "$out/katybug" "$out/prim-$a"
	# the kernels ran (the stats line counts each function's calls), or the checks above prove nothing
	if KATYBUG_STATS=1 "$out/katybug" "$out/prim-$a" 2>&1 > /dev/null | grep -q 'prim strlen [1-9].* memcmp [1-9].* strcmp [1-9].* memchr [1-9]'; then
		echo "PASS prim-faults-$a-recognized"
	else
		echo "FAIL prim-faults-$a-recognized"
		failed=1
	fi
done
# returns.c: recursion, a return slot overwritten to another address, and a longjmp ten frames up;
# every return goes to the address in the return slot, however it got there
returns=$'fib 6765\nredirect 200\nunwind -50'
for a in x86 a64; do
	check returns-$a "$returns" 0 "$out/katybug" "$out/returns-$a"
	check returns-$a-segments-1 "$returns" 0 env KATYBUG_SEGMENTS=1 "$out/katybug" "$out/returns-$a"
done
# pieces.c: guest memory is host blocks of 64 KiB, and every check puts an access (stores of each
# width, pipe I/O, rep movs and stos, brk, mprotect and munmap splits) across a block boundary
pieces=$'image ok\nmap ok\nfill ok\nstraddle ok\npipe ok\nrep ok\nsplit ok\nbigwrite ok\nstack ok\nheap ok'
check pieces-x86 "$pieces" 0 "$out/katybug" "$out/pieces-x86"
check pieces-x86-small-pieces "$pieces" 0 "$out/katybug-4k" "$out/pieces-x86"
check pieces-a64 "$(grep -v '^rep' <<< "$pieces")" 0 "$out/katybug" "$out/pieces-a64"
check pieces-a64-small-pieces "$(grep -v '^rep' <<< "$pieces")" 0 "$out/katybug-4k" "$out/pieces-a64"
# KATYBUG_PIECE_SKEW starts each mmap block at an offset (a fixed one, and one that moves per block)
for skew in 0 48 0,1088; do
	check pieces-x86-skew-$skew "$pieces" 0 env KATYBUG_PIECE_SKEW=$skew "$out/katybug" "$out/pieces-x86"
	check pieces-a64-skew-$skew "$(grep -v '^rep' <<< "$pieces")" 0 env KATYBUG_PIECE_SKEW=$skew "$out/katybug" "$out/pieces-a64"
done
# fds.c: guest descriptors are the host's, so katybug's own (its stderr, a directory handle) sit above
# the guest's range, which ends at the base: the limit reports it, and close, dup2, dup3 and F_DUPFD
# past it fail; a full table (or a lowered RLIMIT_NOFILE, also in a fork child) refuses new
# descriptors with EMFILE, calls on a number past the base give EBADF; a guest that closes every
# descriptor still gets katybug's stats line
fds=$'dents ok\nreuse ok\nstderr ok\nlimit ok\nclose-1000 ok\nclose-range ok\nclose-limit ok\ndup-below ok\ndup-limit ok\ndup-1000 ok\ndup-from-limit ok\ndupfd-below ok\ndupfd-limit ok\ndupfd-1000 ok\nfcntl-limit ok\nopen-emfile ok\nsocket-emfile ok\nsocketpair-emfile ok\npipe-emfile ok\ndup-emfile ok\ndupfd-emfile ok\naccept-emfile ok\naccept4-emfile ok\neventfd-emfile ok\nepoll-emfile ok\ntimerfd-emfile ok\ninotify-emfile ok\nsocket-after ok\nebadf-read ok\nebadf-write ok\nebadf-pread ok\nebadf-pwrite ok\nebadf-readv ok\nebadf-writev ok\nebadf-fstat ok\nebadf-ioctl ok\nebadf-lseek ok\nebadf-mmap ok\nebadf-poll ok\nebadf-select ok\nsetrlimit-low ok\nsetrlimit-read ok\nsetrlimit-up ok\nlimit-open ok\ndents-after ok\nfork-child ok'
stats='"$@" 2>&1 > /dev/null | cut -c1-8 | head -1'
for a in x86 a64; do
	check fds-$a "$fds" 0 "$out/katybug" "$out/fds-$a"
	check fds-$a-stats "katybug:" 0 bash -c "$stats" - env KATYBUG_STATS=1 "$out/katybug" "$out/fds-$a"
	check fds-$a-fork-exec "$fds" 0 env KATYBUG_FORK=exec "$out/katybug" "$out/fds-$a"
	check fds-$a-low-limit "$fds" 0 bash -c 'ulimit -n 256; exec "$@"' - "$out/katybug" "$out/fds-$a"
done
# bigsend.c: one send of 17 MiB (past 256 pieces at 64 KiB, and past 1024 at 4 KiB) reaches a forked
# reader whole, through sendto and through sendmsg
bigsend=$'sendto ok\nsendmsg ok'
for a in x86 a64; do
	check bigsend-$a "$bigsend" 0 "$out/katybug" "$out/bigsend-$a"
	check bigsend-$a-small-pieces "$bigsend" 0 "$out/katybug-4k" "$out/bigsend-$a"
done
check bigsend-x86-fork-exec "$bigsend" 0 env KATYBUG_FORK=exec "$out/katybug" "$out/bigsend-x86"
# epochs.c: a mapping, the signal state, executable code or a descriptor changes in the middle of a
# loop that is already a trace, once and every few iterations; each loop's result is what native Linux
# gives (x86-64 run there too), and the traces really ran
epochs=$'map-remap ok\nmap-churn ok\nmap-protect ok\nmap-unmap ok\nsig-install ok\nsig-unmask ok\nsig-churn ok\nsig-async ok\ncode-flip ok\ncode-churn ok\ncode-remap ok\ncode-smc ok\nfd-dup ok\nfd-churn ok'
for a in x86 a64; do
	check epochs-$a "$epochs" 0 "$out/katybug" "$out/epochs-$a"
	check epochs-$a-small-pieces "$epochs" 0 "$out/katybug-4k" "$out/epochs-$a"
	check epochs-$a-segments-1 "$epochs" 0 env KATYBUG_SEGMENTS=1 "$out/katybug" "$out/epochs-$a"
	check epochs-$a-guard "$epochs" 0 "$out/katybug-epoch" "$out/epochs-$a"
	check epochs-$a-guard-segments-1 "$epochs" 0 env KATYBUG_SEGMENTS=1 "$out/katybug-epoch" "$out/epochs-$a"
	if KATYBUG_STATS=1 "$out/katybug" "$out/epochs-$a" 2>&1 > /dev/null | grep -q '[1-9][0-9]* traces'; then
		echo "PASS epochs-$a-traced"
	else
		echo "FAIL epochs-$a-traced"
		failed=1
	fi
done
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
