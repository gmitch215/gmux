#!/usr/bin/env bash
# each mutant takes one check out of a copy of katybug, and the guest lines named with it must then differ
# from native Linux's (rights-<arch>.expected, x86-loops.expected): a check that no guest notices is no check
# usage: tests/c/katybug/mutants.sh
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
root=$(cd "$here/../../.." && pwd)
llvm=${LLVM:-/opt/homebrew/opt/llvm/bin}
out=$(mktemp -d)
flags=(-nostdlib -static -fuse-ld=lld -O2 -ffreestanding -fno-stack-protector -fno-builtin)
"$llvm/clang" --target=x86_64-linux-gnu "${flags[@]}" -Wl,-N -mno-sse -mno-mmx -o "$out/rights-x86" "$here/rights.c"
"$llvm/clang" --target=aarch64-linux-gnu "${flags[@]}" -Wl,-N -mgeneral-regs-only -o "$out/rights-a64" "$here/rights.c"
"$llvm/clang" --target=x86_64-linux-gnu "${flags[@]}" -mno-sse -mno-mmx -mno-red-zone -o "$out/loops-x86" "$here/x86-loops.c"

failed=0
# mutant <name> <file> <text> <replacement>: the text is replaced in a copy of katybug's sources (it must be
# there), and the copy is built; false when it is not
mutant() {
	local name=$1 file=$2 from=$3 to=$4
	local dir=$out/$name
	mkdir "$dir"
	cp "$root"/src/gmux/katybug/*.c "$root"/src/gmux/katybug/*.h "$dir/"
	if ! FROM=$from TO=$to perl -0pi -e 'BEGIN { $f = $ENV{FROM}; $t = $ENV{TO} } $n += s/\Q$f\E/$t/; END { exit($n ? 0 : 1) }' "$dir/$file"; then
		echo "FAIL mutant-$name: \"$from\" is not in $file"
		failed=1
		return 1
	fi
	cc -std=c11 -D_DEFAULT_SOURCE -D_DARWIN_C_SOURCE -DKB_ZLIB -O2 -o "$dir/katybug" "$dir"/*.c -lm -lz
}

# differs <name> <guest> <expected file> <line prefix>: the guest's lines that start with the prefix, run under
# the mutant, are not all native Linux's
differs() {
	local name=$1 guest=$2 expected=$3 prefix=$4 want got
	want=$(grep "^$prefix" "$here/$expected" || true)
	got=$(timeout 60 "$out/$name/katybug" "$out/$guest" 2> /dev/null | grep "^$prefix" || true)
	if [ "$want" != "$got" ]; then
		echo "PASS mutant-$name-$guest (the $prefix lines differ from native Linux's)"
	else
		echo "FAIL mutant-$name-$guest: the $prefix lines still match"
		failed=1
	fi
}

if mutant no-write-check mem.c 'if (acc == KB_W) return m->prot & KB_W;' 'if (acc == KB_W) return 1;'; then
	differs no-write-check rights-x86 rights-x86.expected store-ro
	differs no-write-check rights-a64 rights-a64.expected store-ro
	differs no-write-check loops-x86 x86-loops.expected ro
fi
if mutant no-exec-check mem.c 'if (acc == KB_X) return m->prot & KB_X;' 'if (acc == KB_X) return 1;'; then
	differs no-exec-check rights-x86 rights-x86.expected fetch-nx
	differs no-exec-check rights-a64 rights-a64.expected fetch-nx
fi
if mutant no-mark-check mem.c 'if (!cpu->nmarks || !len) return;' 'return;'; then
	differs no-mark-check rights-x86 rights-x86.expected smc-store
	differs no-mark-check rights-a64 rights-a64.expected smc-store
fi
# a write by a system call, a string operation or a host kernel (kb_span) skips the marks
if mutant no-syscall-marks mem.c 'if (a == KB_W && (m->prot & KB_X))' 'if (0)'; then
	differs no-syscall-marks rights-x86 rights-x86.expected smc-read
	differs no-syscall-marks rights-a64 rights-a64.expected smc-read
fi
# a block that a write made stale is used as it is
if mutant no-revalidation run.c 'if (kb_marks_current(cpu, b)) return 1;' 'if (b->npv >= 0) return 1;'; then
	differs no-revalidation rights-x86 rights-x86.expected smc-store
	differs no-revalidation rights-a64 rights-a64.expected smc-store
fi
exit $failed
