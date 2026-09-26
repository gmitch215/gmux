#!/usr/bin/env bash
# the Static Assets directory: the terminal page and the xterm.js it loads
set -euo pipefail
root=$(cd "$(dirname "$0")/.." && pwd)
out=$root/build/assets/_gmux/term
mkdir -p "$out"
cp "$root/src/worker/ui/term.html" "$out/index.html"
cp "$root/src/worker/ui/term.js" "$out/term.js"
cp "$root/node_modules/@xterm/xterm/lib/xterm.js" "$root/node_modules/@xterm/xterm/css/xterm.css" "$out/"
