#!/usr/bin/env bash
# the instruction corpus (x86-ops.ts): run natively on a Linux x86-64 host (NATIVE_HOST, default
# paisley-park, the binary under ~/gmux-rig/k3) and under a native build of katybug here; every case
# must match. usage: tests/c/katybug/ops.sh
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
root=$(cd "$here/../../.." && pwd)
host=${NATIVE_HOST:-paisley-park}
out=$(mktemp -d)
cc -std=c11 -D_DEFAULT_SOURCE -D_DARWIN_C_SOURCE -O2 ${KATYBUG_CFLAGS:-} -o "$out/katybug" "$root"/src/gmux/katybug/*.c -lm
"$root/scripts/ts" "$here/x86-ops.ts" > "$out/x86-ops.S"
clang --target=x86_64-linux-gnu -nostdlib -static -fuse-ld=lld -o "$out/x86-ops" "$out/x86-ops.S"
ssh "$host" 'mkdir -p ~/gmux-rig/k3 && cat > ~/gmux-rig/k3/x86-ops && chmod +x ~/gmux-rig/k3/x86-ops && ~/gmux-rig/k3/x86-ops' \
	< "$out/x86-ops" > "$out/native.bin"
"$out/katybug" "$out/x86-ops" > "$out/katybug.bin"
"$root/scripts/ts" "$here/x86-ops-diff.ts" "$out/x86-ops.S" "$out/native.bin" "$out/katybug.bin"
