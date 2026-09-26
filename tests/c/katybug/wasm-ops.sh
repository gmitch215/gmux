#!/usr/bin/env bash
# the wasm corpus (wasm-ops.ts): V8 and a native build of katybug --wasm run the same calls on the
# same module; every line must match. usage: tests/c/katybug/wasm-ops.sh
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
root=$(cd "$here/../../.." && pwd)
out=$(mktemp -d)
cc -std=c11 -D_DEFAULT_SOURCE -D_DARWIN_C_SOURCE -O2 -o "$out/katybug" "$root"/src/gmux/katybug/*.c -lm
"$root/scripts/ts" "$here/wasm-ops.ts" "$out"
wat2wasm "$out/wasm-ops.wat" -o "$out/wasm-ops.wasm"
node "$here/wasm-ops.mjs" "$out" > "$out/v8.txt"
# V8 raises one message for an empty table slot and a signature mismatch; katybug names them apart
"$out/katybug" --wasm "$out/wasm-ops.wasm" --calls "$out/wasm-ops.calls" \
	| sed 's/ trap null$/ trap sig/' > "$out/katybug.txt"
if diff "$out/v8.txt" "$out/katybug.txt" > "$out/diff.txt"; then
	echo "wasm corpus: $(wc -l < "$out/v8.txt" | tr -d ' ') calls equal"
else
	head -40 "$out/diff.txt"
	echo "wasm corpus: $(grep -c '^<' "$out/diff.txt") of $(wc -l < "$out/v8.txt" | tr -d ' ') differ"
	exit 1
fi
