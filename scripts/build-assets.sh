#!/usr/bin/env bash
# the Static Assets directory: the terminal page and the xterm.js it loads, and the bootstrap
# image a new machine restores instead of booting (scripts/bootstrap.ts; node, since the machine
# needs JSPI), once build/kernel is staged; and build/router (router, statx hit and scheduler core),
# which the site and bootstrap load
set -euo pipefail
root=$(cd "$(dirname "$0")/.." && pwd)
out=$root/build/assets/_gmux/term
"$root/scripts/build-router.sh"
mkdir -p "$out"
cp "$root/src/worker/ui/term.html" "$out/index.html"
cp "$root/src/worker/ui/term.js" "$out/term.js"
cp "$root/node_modules/@xterm/xterm/lib/xterm.js" "$root/node_modules/@xterm/xterm/css/xterm.css" "$out/"
if [ -f "$root/build/kernel/vmlinux.async.wasm" ]; then
	node --no-warnings --experimental-strip-types "$root/scripts/bootstrap.ts"
fi
