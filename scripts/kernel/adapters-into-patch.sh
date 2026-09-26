#!/usr/bin/env bash
# puts a generated syscall_adapters.c (a pipeline run's out/) into kernel patch 0004, which adds that
# file; run the pipeline again after it, as build-linux.sh asks when the adapters change
set -euo pipefail
adapters=${1:?usage: scripts/kernel/adapters-into-patch.sh <syscall_adapters.c>}
root=$(cd "$(dirname "$0")/../.." && pwd)
patch=$(ls "$root"/src/kernel/patches/0004-*.patch)
lines=$(wc -l < "$adapters" | tr -d ' ')
next=$(mktemp)
awk -v file="$adapters" -v lines="$lines" '
	/^diff --git a\/arch\/wasm\/kernel\/syscall_adapters.c/ { inside = 1; print; next }
	inside && /^@@ / {
		print "@@ -0,0 +1," lines " @@"
		while ((getline line < file) > 0) print "+" line
		skipping = 1
		next
	}
	skipping && /^diff --git/ { inside = 0; skipping = 0 }
	!skipping { print }
' "$patch" > "$next"
mv "$next" "$patch"
echo "$(basename "$patch"): syscall_adapters.c is $lines lines"
