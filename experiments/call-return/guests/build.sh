#!/usr/bin/env bash
# build.sh <out dir>: the two deep-recursion guests (fib, parse) as static freestanding ELFs, one dir per arch
# (FIB_N=38 PASSES=4 LLVM=<clang dir>); the x86_64 ones also run natively on a Linux x86-64 host
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
out=${1:?usage: build.sh <out dir>}
llvm=${LLVM:-/opt/homebrew/opt/llvm/bin}
flags=(-nostdlib -static -fuse-ld=lld -O2 -ffreestanding -fno-stack-protector -fno-builtin
	-DFIB_N="${FIB_N:-38}" -DPASSES="${PASSES:-4}")
mkdir -p "$out/x86_64" "$out/aarch64"
for w in FIB:fib PARSE:parse; do
	"$llvm/clang" --target=x86_64-linux-gnu "${flags[@]}" -mno-sse -mno-mmx -D"${w%%:*}" -o "$out/x86_64/${w##*:}" "$here/deep.c"
	"$llvm/clang" --target=aarch64-linux-gnu "${flags[@]}" -mgeneral-regs-only -D"${w%%:*}" -o "$out/aarch64/${w##*:}" "$here/deep.c"
done
