#!/usr/bin/env bash
# the AArch64 instruction corpus (a64-ops.ts): run natively in a linux/arm64 container (docker on an
# arm64 host, or with binfmt emulation elsewhere) and under a native build of katybug here; every
# case must match. KATYBUG_PLAN=0 in the environment checks the unplanned blocks too. The outputs
# stay in <dir> when one is given.
# usage: tests/c/katybug/a64-ops.sh [dir]
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
root=$(cd "$here/../../.." && pwd)
out=${1:-$(mktemp -d)}
mkdir -p "$out"
cc -std=c11 -D_DEFAULT_SOURCE -D_DARWIN_C_SOURCE -O2 ${KATYBUG_CFLAGS:-} -o "$out/katybug" "$root"/src/gmux/katybug/*.c -lm
"$root/scripts/ts" "$here/a64-ops.ts" > "$out/a64-ops.S"
clang --target=aarch64-linux-gnu -nostdlib -static -fuse-ld=lld -o "$out/a64-ops" "$out/a64-ops.S"
docker run --rm --platform linux/arm64 --memory 512m -v "$out:/k:ro" alpine:3.20 /k/a64-ops > "$out/native.bin"
"$out/katybug" "$out/a64-ops" > "$out/katybug.bin"
"$root/scripts/ts" "$here/x86-ops-diff.ts" "$out/a64-ops.S" "$out/native.bin" "$out/katybug.bin" --a64
